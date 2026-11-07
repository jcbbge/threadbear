import AppKit
import SwiftUI
import ThreadbearCore

/// Sizes the sidebar's rows share, so the new-thread row, the headings, the
/// thread titles and the view headers all start at the same x.
enum SidebarMetrics {
    /// From the sidebar's edges to a row's highlight.
    static var outerInset: CGFloat { zoomed(8) }
    /// Inside a row's highlight, left of its text. Wider than the right side
    /// (10) to leave a gutter for the unread dot, as Mail does, so titles
    /// line up whether or not they have one.
    static var leading: CGFloat { zoomed(18) }
    static var trailing: CGFloat { zoomed(10) }
    static var corner: CGFloat { zoomed(8) }
    /// Fainter than the selected row's 0.06 to 0.08, so the two read apart.
    static let hover = Color.primary.opacity(0.03)
    /// Times and counts: quieter than a title but readable
    /// (the system tertiary was about 2:1 here, like disabled text).
    static let faint = Color(nsColor: Theme.faintText)
}

struct SidebarView: View {
    @Environment(AppModel.self) private var app

    var body: some View {
        // The view picked in the activity bar, which runs down the window's
        // left edge beside this (RootView). In a ZStack so the old view and
        // the new one share the space while one fades out and the other
        // fades in and settles.
        ZStack {
            Group {
                switch app.sidebarMode {
                case .inbox: InboxList()
                case .scheduled: ScheduledList()
                case .projects: ProjectsList()
                case .librarian: LibrarianView()
                }
            }
            .transition(Juice.reduceMotion ? .opacity : .asymmetric(
                insertion: .opacity.combined(with: .offset(y: zoomed(6))),
                removal: .opacity
            ))
        }
        .frame(maxWidth: .infinity)
        .animation(Juice.reduceMotion ? .easeOut(duration: 0.12) : .snappy(duration: 0.22), value: app.sidebarMode)
    }
}

private struct InboxList: View {
    @Environment(AppModel.self) private var app

    /// How many archived threads the Archived section shows (`ArchiveRows`).
    @State private var archiveLimit = ArchiveRows.first

    var body: some View {
        // The search at the top cuts every section down to its matches.
        let query = app.searchQuery.trimmingCharacters(in: .whitespacesAndNewlines)
        let searching = !query.isEmpty
        let sections = app.sections.matching(query)
        // A thread whose panel is still dropping into the Archived heading
        // isn't counted or listed there until it lands (`ArchiveFlight`).
        let flying = app.flyingToArchive
        let archived = flying.isEmpty ? sections.archived : sections.archived.filter { !flying.contains($0.id) }
        // And the same for one sinking into Hibernating.
        let tucking = app.flyingToHibernate
        let hibernating = tucking.isEmpty ? sections.hibernating : sections.hibernating.filter { !tucking.contains($0.id) }
        // The Archived section shows the most recent few, or every match
        // while searching.
        let archive = ArchiveRows.shown(archived, limit: archiveLimit, searching: searching, selection: app.selection)
        // Each section's rows as drawn.
        let drawn: (InboxSection) -> [ThreadSummary] = { $0 == .archived ? archive.rows : $0 == .hibernating ? hibernating : sections[$0] }
        // A folded section's rows aren't drawn, so the arrow keys skip
        // them. A search draws every section's matches, folded or not.
        let open = InboxSection.allCases.filter { searching || !app.collapsedSections.contains($0) }
        // Rows are identified by section and thread (see SectionRow), so
        // the arrow keys scroll to that.
        let rowIDs = Dictionary(uniqueKeysWithValues: InboxSection.allCases.flatMap { section in
            drawn(section).map { ($0.id, SectionRow.id(section: section.title, thread: $0.id)) }
        })
        VStack(spacing: 0) {
            // One line, the search and then New thread (Mike asked 30 Oct):
            // a New thread row over a search field read as two bars that
            // didn't match. The button takes the field's height.
            HStack(spacing: zoomed(6)) {
                ThreadSearch()
                NewThreadButton()
            }
            .fixedSize(horizontal: false, vertical: true)
            .padding(.horizontal, SidebarMetrics.outerInset)
            .padding(.top, zoomed(4))
            let order = open.flatMap { drawn($0).map(\.id) }
            // Section and thread, so a thread changing section animates
            // even when the order of ids alone stays the same.
            let layout = open.flatMap { section in
                drawn(section).map { SectionRow.id(section: section.title, thread: $0.id) }
            }
            ThreadList(order: order, layout: layout, scrollID: { rowIDs[$0] ?? $0 }) { select in
                if !app.threadsLoaded {
                    // Before the runner's first list: rows shaped like
                    // threads, so the sidebar reads as loading, not empty.
                    LoadingRows()
                } else {
                    if searching && sections.isEmpty {
                        EmptyNote(text: "No threads match.")
                    }
                    ForEach(InboxSection.allCases, id: \.self) { section in
                        if section == .archived {
                            ThreadSection(section: section, threads: archive.rows, total: archived.count, more: archive.more,
                                          searching: searching, showMore: { archiveLimit += ArchiveRows.step }, select: select)
                        } else if section == .hibernating {
                            // The heading comes up as the first thread sets
                            // off for it, so there's a moon to land in.
                            ThreadSection(section: section, threads: hibernating, searching: searching,
                                          keepHeading: !tucking.isEmpty && !searching, select: select)
                        } else {
                            ThreadSection(section: section, threads: sections[section], searching: searching, select: select)
                        }
                        // Under the empty Inbox heading. Threads waiting on
                        // a schedule don't stop it: there's still nothing
                        // for Mike to do.
                        // Nor do starred threads, unless one needs him.
                        // It comes once the last archived or hibernated page
                        // has landed: arriving under the heading mid-flight
                        // pushes it down, and the page lands short.
                        if section == .inbox && !searching && sections.inbox.isEmpty && sections.running.isEmpty && sections.needsYou.isEmpty && !app.flightLeavingTheInbox {
                            InboxZero()
                        }
                    }
                }
            }
            // An archived panel falls off the bottom of this when the
            // Archived heading is out of sight (`ArchiveFlight`).
            .background(FlightMarker(kind: .inboxList))
        }
    }
}

/// Grey placeholder rows the size of thread rows (a 30 pt tile, a title
/// line and a place line), gently pulsing while the app waits for the
/// runner's first list. Mike asked for these on 30 Oct, after the iPhone
/// said "Nothing in the inbox" while it loaded.
private struct LoadingRows: View {
    @State private var dim = false
    private static let widths: [(CGFloat, CGFloat)] = [(170, 90), (130, 70), (190, 110), (150, 80), (120, 95), (175, 75)]

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            ForEach(Self.widths.indices, id: \.self) { i in
                let (title, place) = Self.widths[i]
                HStack(alignment: .center, spacing: zoomed(10)) {
                    RoundedRectangle(cornerRadius: zoomed(7)).frame(width: zoomed(30), height: zoomed(30))
                    VStack(alignment: .leading, spacing: zoomed(7)) {
                        Capsule().frame(width: zoomed(title), height: zoomed(9))
                        Capsule().frame(width: zoomed(place), height: zoomed(7))
                    }
                    Spacer(minLength: 0)
                }
                .padding(EdgeInsets(top: zoomed(8), leading: SidebarMetrics.leading, bottom: zoomed(8), trailing: SidebarMetrics.trailing))
            }
        }
        .foregroundStyle(Color.primary.opacity(0.07))
        .padding(.horizontal, SidebarMetrics.outerInset)
        .padding(.top, zoomed(10))
        .opacity(dim ? 0.5 : 1)
        .onAppear {
            guard !Juice.reduceMotion else { return }
            withAnimation(.easeInOut(duration: 0.9).repeatForever(autoreverses: true)) { dim = true }
        }
        .accessibilityElement()
        .accessibilityLabel("Loading threads")
    }
}

/// A heading and its rows. Empty sections other than Inbox are left out,
/// and Inbox too while searching. Clicking the heading folds the rows
/// away; folded, it shows how many. The Archived section shows the most
/// recent few until asked for more.
private struct ThreadSection: View {
    @Environment(AppModel.self) private var app
    let section: InboxSection
    /// As drawn: the Archived section's are already cut short
    /// (`ArchiveRows`).
    let threads: [ThreadSummary]
    /// The Archived section's rows before the cut, for the folded count.
    var total: Int? = nil
    /// Archived threads left out by the cut, for "Show more".
    var more = 0
    /// The search has text, so `threads` are its matches. They're drawn
    /// with the heading open and no fold, whatever Mike had folded: a
    /// match behind a folded heading would be easy to miss. The folds are
    /// back as they were once the search is cleared.
    var searching = false
    var showMore: () -> Void = {}
    /// Show the heading even with nothing under it yet.
    var keepHeading = false
    let select: (String) -> Void

    var body: some View {
        let count = total ?? threads.count
        if count > 0 || keepHeading || (section == .inbox && !searching) {
            let collapsed = !searching && app.collapsedSections.contains(section)
            SectionHeading(title: section.title, icon: section.icon, fold: searching ? nil : .init(collapsed: collapsed, count: count) {
                withAnimation(.snappy(duration: 0.2)) {
                    if collapsed { app.collapsedSections.remove(section) } else { app.collapsedSections.insert(section) }
                }
            }) {
                if section == .inbox { InboxOrderMenu() }
            }
            .environment(\.archiveLandings, section == .archived ? app.archiveLandings : nil)
            .environment(\.hibernateLandings, section == .hibernating ? app.hibernateLandings : nil)
            if !collapsed {
                ForEach(threads.map { SectionRow(section: section.title, thread: $0) }) { row in
                    ThreadRowView(thread: row.thread, mode: RowMode(section, thread: row.thread, now: app.now), section: section) { select(row.thread.id) }
                        // The tour points at the samples' rows by title.
                        .tourTarget(.sampleRow(row.thread.title), when: row.thread.sample)
                        .transition(Juice.row)
                    // Put-away threads have nothing running to list.
                    if !section.isPutAway {
                        SubagentList(thread: row.thread, section: section.title, finishedShown: section != .inbox && section != .starred)
                    }
                }
                if section == .archived && more > 0 {
                    SidebarButtonRow(icon: "ellipsis", title: "Show \(min(more, ArchiveRows.step)) more",
                                     tip: "\(more) older archived \(more == 1 ? "thread" : "threads") not shown") {
                        withAnimation(.snappy(duration: 0.2)) { showMore() }
                    }
                }
            }
        }
    }
}

/// The search at the top of the inbox. It searched only the archive,
/// under the Archived heading, until Mike asked for it at the top,
/// finding any thread (30 Oct).
private struct ThreadSearch: View {
    @Environment(AppModel.self) private var app

    var body: some View {
        @Bindable var app = app
        SearchField(text: $app.searchQuery, prompt: "Search threads")
    }
}

/// New thread beside the search: the compose icon alone, as Mail and
/// Notes have it, so the search keeps the room. Mike tried it with the
/// words "New thread" too and went back to the icon (30 Oct). Lit while
/// the new thread's composer is showing, as the row it replaced was.
private struct NewThreadButton: View {
    @Environment(AppModel.self) private var app
    @Environment(\.controlActiveState) private var activeState
    @State private var hovering = false

    var body: some View {
        let active = app.selection == nil
        Button { app.newThread() } label: {
            Image(systemName: "square.and.pencil")
                .font(.system(size: TypeScale.sidebarButton))
                .foregroundStyle(hovering || active ? .primary : .secondary)
                .frame(width: zoomed(32))
                .frame(maxHeight: .infinity)
                .background(active ? Color.primary.opacity(activeState == .key ? 0.08 : 0.06) : hovering ? SidebarMetrics.hover : .clear,
                            in: RoundedRectangle(cornerRadius: SidebarMetrics.corner))
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .onHover { hovering = $0 }
        .animation(Juice.hover, value: hovering)
        // Over the end of the search, since the sidebar's edge is just
        // right of the button.
        .shortcutHint(AppShortcuts.shared.display(.newThread), .before)
        .tip(AppShortcuts.shared.tip("Start a new thread", .newThread))
        .accessibilityLabel("New thread")
    }
}

/// Which archived threads the Archive section draws. Mike's archive runs
/// to hundreds, more than a list under the inbox should scroll through,
/// so it shows the most recent few and more on asking. A search shows
/// every match, and the open thread is always in (a thread chip can open
/// an old one).
enum ArchiveRows {
    static let first = 20
    static let step = 50

    static func shown(_ archived: [ThreadSummary], limit: Int, searching: Bool, selection: String?) -> (rows: [ThreadSummary], more: Int) {
        if searching { return (archived, 0) }
        let selected = selection.flatMap { id in archived.firstIndex { $0.id == id } }.map { $0 + 1 } ?? 0
        let count = min(archived.count, max(limit, selected))
        return (Array(archived.prefix(count)), archived.count - count)
    }
}

/// A row's identity in the lazy stack includes its section. Keyed by the
/// thread id alone, a thread that moved section kept the row it had drawn
/// before (it went to Running still showing its time, not "Working"): the
/// stack moved the row without running its body again. So no plain
/// `.id(thread.id)` on these rows either; the stack keys rows by that too.
struct SectionRow: Identifiable {
    let section: String
    let thread: ThreadSummary
    var id: String { Self.id(section: section, thread: thread.id) }

    static func id(section: String, thread: String) -> String { section + "/" + thread }
}

/// The sort button at the end of the Inbox heading.
private struct InboxOrderMenu: View {
    @Environment(AppModel.self) private var app
    @State private var hovering = false

    var body: some View {
        IconMenu {
            Picker("Sort", selection: Binding(
                get: { app.inboxOrder },
                set: { order in withAnimation(.snappy(duration: 0.2)) { app.inboxOrder = order } }
            )) {
                ForEach(InboxOrder.allCases, id: \.self) { Label($0.title, systemImage: $0.symbol).tag($0) }
            }
            .pickerStyle(.inline)
            .labelsHidden()
        } label: {
            Image(systemName: "arrow.up.arrow.down")
                .font(.system(size: zoomed(10), weight: .semibold))
                // Brighter once it's off the default, so a changed order
                // isn't a surprise.
                .foregroundStyle(hovering ? AnyShapeStyle(.primary) : app.inboxOrder == .needsYou ? AnyShapeStyle(SidebarMetrics.faint) : AnyShapeStyle(.secondary))
                .animation(Juice.hover, value: hovering)
                .frame(width: zoomed(16), height: zoomed(16))
                .contentShape(Rectangle())
        }
        .menuStyle(.button)
        .buttonStyle(.plain)
        .menuIndicator(.hidden)
        .fixedSize()
        .onHover { hovering = $0 }
        .tip("Sort: \(app.inboxOrder.title)")
    }
}

/// Out of the generic SectionHeading so a helper can make one for a heading
/// with any accessory.
struct SectionFold {
    var collapsed: Bool
    /// The rows under it, shown while they're folded away.
    var count: Int
    var toggle: () -> Void
}

struct SectionHeading<Accessory: View>: View {
    let title: String
    /// A small SF Symbol before the title, so the groups can be told apart
    /// at a glance.
    var icon: String? = nil
    /// A project's own icon in place of the symbol: a project's links in
    /// Highlights.
    var project: Project? = nil
    /// Given for a heading that folds its rows away when clicked.
    var fold: Fold? = nil
    /// Controls at the heading's end, outside the fold button so a click
    /// on them doesn't fold the section: the Inbox's sort menu.
    @ViewBuilder var accessory: () -> Accessory
    @State private var hovering = false
    @Environment(\.archiveLandings) private var archiveLandings
    @Environment(\.hibernateLandings) private var hibernateLandings

    typealias Fold = SectionFold

    var body: some View {
        HStack(spacing: zoomed(4)) {
            if let fold {
                Button(action: fold.toggle) { label }
                    .buttonStyle(.plain)
                    .onHover { hovering = $0 }
                    .tip(fold.collapsed ? "Show \(title)" : "Hide \(title)")
                    .accessibilityValue(fold.collapsed ? "Collapsed" : "Expanded")
            } else {
                label
            }
            // The same band as the title, so the two line up.
            accessory()
                .padding(.top, zoomed(18))
                .padding(.bottom, zoomed(6))
        }
        .padding(.trailing, SidebarMetrics.trailing)
    }

    private var label: some View {
        // A quiet divider rather than a bold tag: grey, at the previews'
        // size, with clear room above each group, like Codex and Claude.
        // Semibold so it isn't weaker than the rows it groups. A hairline
        // runs from the title to the edge so the groups read as separate
        // (Mike asked 27 Oct).
        HStack(spacing: zoomed(6)) {
            if let project {
                ProjectIconView(project: project, size: 14)
            } else if let icon {
                Image(systemName: icon)
                    .font(.system(size: zoomed(11), weight: .medium))
                    // The Archived heading's box: where an archived
                    // thread's panel lands, bouncing as it does
                    // (`ArchiveFlight`).
                    .symbolEffect(.bounce, value: archiveLandings ?? 0)
                    // Hibernating's moon dips rather than hops, its Zs
                    // stirring after it, and lifts a shade as it takes the
                    // thread in.
                    .symbolEffect(.bounce.down.byLayer, value: hibernateLandings ?? 0)
                    .phaseAnimator([0, 0.16], trigger: hibernateLandings ?? 0) { moon, lit in
                        moon.brightness(lit)
                    } animation: { _ in .easeOut(duration: 0.32) }
                    .background {
                        if archiveLandings != nil { FlightMarker(kind: .archiveBox) }
                        if hibernateLandings != nil { FlightMarker(kind: .hibernateBox) }
                    }
                    .frame(width: zoomed(14))
            }
            Text(title)
                .font(.system(size: TypeScale.sidebarHeading, weight: .semibold))
                .foregroundStyle(hovering ? .primary : .secondary)
                .animation(Juice.hover, value: hovering)
                .fixedSize()
            Rectangle()
                .fill(Color.primary.opacity(0.08))
                .frame(height: 1)
                .padding(.horizontal, zoomed(4))
            if let fold {
                // Folded, the count says what's hidden; the chevron only
                // shows while folded or on hover, so an open heading stays
                // as quiet as the others.
                if fold.collapsed && fold.count > 0 {
                    // Rolls to the new number when a thread comes or goes
                    // while the section's folded.
                    Text("\(fold.count)")
                        .font(.system(size: TypeScale.sidebarMeta))
                        .foregroundStyle(SidebarMetrics.faint)
                        .monospacedDigit()
                        .contentTransition(.numericText(value: Double(fold.count)))
                        .animation(Juice.swap, value: fold.count)
                        .transition(Juice.popIn)
                }
                Image(systemName: "chevron.down")
                    .font(.system(size: zoomed(9), weight: .semibold))
                    .foregroundStyle(SidebarMetrics.faint)
                    .rotationEffect(.degrees(fold.collapsed ? -90 : 0))
                    .opacity(fold.collapsed || hovering ? 1 : 0)
                    .animation(Juice.hover, value: hovering)
            }
        }
        .foregroundStyle(.secondary)
        .padding(.leading, SidebarMetrics.leading)
        // The padding sits inside the fold button, so the whole band
        // above the rows folds, as it did before the accessory.
        .padding(.top, zoomed(18))
        .padding(.bottom, zoomed(6))
        .frame(maxWidth: .infinity, alignment: .leading)
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(.isHeader)
    }
}

extension SectionHeading where Accessory == EmptyView {
    init(title: String, icon: String? = nil, project: Project? = nil, fold: Fold? = nil) {
        self.init(title: title, icon: icon, project: project, fold: fold) { EmptyView() }
    }
}

extension InboxSection {
    var icon: String {
        switch self {
        case .starred: return "star"
        case .inbox: return "tray"
        case .running: return "bolt"
        case .hibernating: return "moon.zzz"
        case .archived: return "archivebox"
        }
    }
}

/// The scrolling part of each sidebar view: a lazy stack of rows with
/// up and down arrow keys once it has focus, as the system list had. Rows
/// are drawn here rather than in a `List` because the sidebar list style
/// paints its own accent-coloured selection, which can't be made as quiet
/// as the other agent apps' grey highlight.
struct ThreadList<Content: View>: View {
    @Environment(AppModel.self) private var app
    /// Thread ids top to bottom, for the arrow keys.
    let order: [String]
    /// The rows as drawn, when that says more than `order` (the inbox's
    /// carry their section). A change to it animates the rows into place.
    var layout: [String]? = nil
    /// The id a thread's row has in the stack, to scroll it into view.
    var scrollID: (String) -> String = { $0 }
    @ViewBuilder let content: (_ select: @escaping (String) -> Void) -> Content
    @FocusState private var focused: Bool
    @Namespace private var rowSpace

    var body: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 0) {
                    content { id in
                        // Clicking a row gives the list focus, so the arrow
                        // keys move through threads from there.
                        focused = true
                        app.select(id)
                    }
                }
                .environment(\.sidebarRowSpace, rowSpace)
                // Only when rows come, go or change places, or the selection
                // moves: text changing inside a row (a new title, the
                // clock) isn't animated by these.
                .animation(Juice.rows, value: layout ?? order)
                .animation(Juice.selection, value: SelectionKey(thread: app.selection, subagent: app.subagentSelection, project: app.openProjectId))
                .padding(.horizontal, SidebarMetrics.outerInset)
                // Room for the last row to scroll clear of the fade below.
                .padding(.bottom, zoomed(32))
            }
            // With a mouse connected macOS draws a legacy scroller with a
            // track down the list, which also pushed the times left. Codex,
            // Claude and T3 show none; the list scrolls the same without it.
            .scrollIndicators(.never)
            // The last row fades out at the foot rather than being cut
            // through its text at the hairline, as the transcript does above
            // the composer. About a title and a preview tall, and clear just
            // before the hairline: at 16 pt a row still showed half its
            // letters on the rule. A static mask, so scrolling costs nothing.
            .mask {
                VStack(spacing: 0) {
                    Color.black
                    LinearGradient(colors: [.black, .clear], startPoint: .top, endPoint: .bottom).frame(height: zoomed(30))
                    Color.clear.frame(height: zoomed(4))
                }
            }
            .focusable()
            .focused($focused)
            .focusEffectDisabled()
            .onMoveCommand { direction in
                let step: Int
                switch direction {
                case .up: step = -1
                case .down: step = 1
                default: return
                }
                guard let next = SidebarOrder.neighbour(of: app.selection, in: order, step: step), next != app.selection else { return }
                app.select(next)
                proxy.scrollTo(scrollID(next))
            }
            // Next Inbox Thread (⌥⌘↓) picks a row from the menu: bring it
            // into view as the arrow keys do.
            .onChange(of: app.revealSelectionRequests) {
                guard let id = app.selection, order.contains(id) else { return }
                withAnimation(Juice.selection) { proxy.scrollTo(scrollID(id)) }
            }
            .onExitCommand {
                if app.sidebarMode != .inbox { app.sidebarMode = .inbox }
            }
        }
    }
}

/// What's selected in the sidebar, for animating the highlight's slide.
private struct SelectionKey: Equatable {
    let thread: String?
    let subagent: SubagentRef?
    let project: String?
}

/// What kind of list a row is in: how it reads and its hover buttons.
enum RowMode: Equatable {
    case inbox, hibernating, archive, projects

    /// A starred thread reads as what it is: one that's hibernating says
    /// when it wakes, and wakes rather than hibernates. So does one under
    /// Hibernating that's only waiting on a schedule: it isn't snoozed, so
    /// Wake would do nothing, and its row says when the schedule runs.
    init(_ section: InboxSection, thread: ThreadSummary, now: Date) {
        switch section {
        case .starred, .hibernating: self = thread.isSnoozed(at: now) ? .hibernating : .inbox
        case .archived: self = .archive
        case .inbox, .running: self = .inbox
        }
    }

    var rowActions: [RowAction] {
        switch self {
        case .inbox, .projects: return [.star, .snooze, .archive]
        case .hibernating: return [.star, .unsnooze, .archive]
        case .archive: return [.unarchive]
        }
    }
}

enum RowAction {
    case star, snooze, archive, unsnooze, unarchive
}

struct ThreadRowView: View {
    @Environment(AppModel.self) private var app
    @Environment(\.controlActiveState) private var activeState
    let thread: ThreadSummary
    let mode: RowMode
    /// The inbox section the row is under, so it doesn't repeat its heading.
    var section: InboxSection? = nil
    /// The project whose heading the row is under (the Projects view), so
    /// the row doesn't name it again.
    var heading: String? = nil
    let select: () -> Void
    @State private var hovering = false
    @State private var pressed = false
    /// A brief accent wash over a row that's just finished, so a reply
    /// landing in the inbox catches the eye.
    @State private var landed = false
    /// Two fingers sliding the row left to archive it (RowSwipe.swift).
    @State private var swipe = RowSwipeController()
    /// The thread's being dragged out (ThreadDrag), till it's let go.
    @State private var draggingOut = false
    /// What the window showed before the press opened this thread, to go
    /// back to if the press turns into dragging it out.
    @State private var placeBeforePress: NavigationPlace?
    @Environment(\.sidebarRowSpace) private var listSpace
    /// Not in Projects: a thread in two projects has a row under each, and
    /// two rows can't both be the one the highlight and the glide follow.
    private var rowSpace: Namespace.ID? { mode == .projects ? nil : listSpace }

    /// Not while one of its sub-agents is showing: that row is highlighted.
    private var isSelected: Bool { app.selection == thread.id && app.subagentSelection == nil && app.openProjectId == nil && !app.showsHomePage }
    /// The screenshot run shows one row as if the pointer were over it.
    private var pointerOver: Bool { hovering || app.hoverOverride == thread.id }
    /// Archived from somewhere other than a swipe: slides off all the same.
    private var slidingOff: Bool { app.slidingOff.contains(thread.id) }
    /// Not while it's being swiped: the buttons would ride along with it.
    /// Kept while its moon's menu is open, which the pointer leaves the row
    /// to get into (`MenuAnchor.held`).
    private var showsActions: Bool { (pointerOver || app.menuOpenRow == thread.id) && !swipe.isSwiping && !slidingOff }

    /// The press became dragging the thread out. The press opened it, as
    /// a click does on mouse down, but it's being dragged into the thread
    /// that was open, so that one comes back to drop it on.
    private func dragOut() {
        guard ThreadDrag.begin(thread, ended: { draggingOut = false }) else { return }
        draggingOut = true
        // AppKit has the mouse till the drop, so the gesture may never hear
        // it come up.
        pressed = false
        swipe.dragEnded()
        if let before = placeBeforePress, app.place != before { app.goBack() }
    }

    var body: some View {
        // The Projects view's rows say what they're doing too: it has no
        // Needs you or Running headings to say it for them.
        let look = mode == .inbox || mode == .projects ? ThreadRowLook(thread, section: section) : ThreadRowLook(status: .time, unread: false, emphasised: false)
        // A tile for the thread's project, two lines tall, then the title
        // across the whole width and under it where the thread belongs and
        // what it's doing. The preview and the account name went once
        // projects came: Mike reads a thread by its title and its project.
        // Another runner's thread: its Mac's icon in the tile (it has no
        // projects here), and the Mac's name in the tooltips.
        let place = app.runnerPlace(of: thread)
        HStack(alignment: .center, spacing: zoomed(10)) {
            ProjectTiles(projects: ProjectMark.shown(thread, under: heading), runnerIcon: thread.isRemote ? app.runnerIcon(of: thread) : nil)
                .tip(place.map { "\($0), in \(thread.cwd.abbreviatingHome)" } ?? ProjectMark.help(thread))
                .overlay(alignment: .leading) {
                    if look.done {
                        // Finished with nothing needed: a tick where the
                        // unread dot would be, drawn on as it arrives.
                        Image(systemName: "checkmark")
                            .font(.system(size: zoomed(9), weight: .bold))
                            .foregroundStyle(Color.accentColor)
                            .frame(width: zoomed(10), height: zoomed(10))
                            .transition(Juice.reduceMotion ? .opacity : AnyTransition(SymbolEffectTransition(effect: .drawOn, options: .default)))
                            .offset(x: -(SidebarMetrics.leading + zoomed(10)) / 2 - zoomed(1))
                            .accessibilityLabel("Done, unread")
                    } else if look.unread {
                        // In the row's leading gutter, left of the tile. Pops
                        // in with a little overshoot, and shrinks away once
                        // the thread's been read.
                        Circle()
                            .fill(Color.accentColor)
                            .frame(width: zoomed(7), height: zoomed(7))
                            .transition(Juice.popIn)
                            .offset(x: -(SidebarMetrics.leading + zoomed(7)) / 2 - zoomed(1))
                            .tip("Needs you")
                            .accessibilityLabel("Needs you")
                    }
                }
                .animation(Juice.pop, value: look.unread)
                .animation(Juice.pop, value: look.done)
            VStack(alignment: .leading, spacing: zoomed(3)) {
                HStack(spacing: 0) {
                    Text(thread.title.isEmpty ? "Untitled" : thread.title)
                        .font(.system(size: TypeScale.sidebarTitle, weight: look.emphasised ? .semibold : .regular))
                        .foregroundStyle(.primary)
                        .lineLimit(1)
                    Spacer(minLength: 0)
                    if showsActions {
                        // Room for the hover buttons, drawn over the row so
                        // they don't change its height.
                        Color.clear.frame(width: CGFloat(mode.rowActions.count) * zoomed(24), height: 1)
                    }
                }
                HStack(alignment: .firstTextBaseline, spacing: zoomed(6)) {
                    HStack(alignment: .firstTextBaseline, spacing: zoomed(4)) {
                        if let byline = ThreadByline.line(thread, under: heading) {
                            // Mike didn't start it: a mark for who did
                            // (who and why in its tip), then the place.
                            // A tool's symbol may not exist on this macOS.
                            Image(systemName: NSImage(systemSymbolName: byline.symbol, accessibilityDescription: nil) == nil ? ThreadByline.toolSymbol : byline.symbol)
                                .font(.system(size: TypeScale.sidebarMeta))
                                .tip(thread.schedule.map { StartedBySchedule.tip($0, current: app.schedule($0.id)) } ?? byline.tip)
                                .accessibilityLabel(byline.tip)
                            Text(byline.text)
                                .font(.system(size: TypeScale.sidebarMeta + 1))
                                .lineLimit(1)
                        } else {
                            Text(ProjectMark.place(thread, under: heading))
                                .font(.system(size: TypeScale.sidebarMeta + 1))
                                .lineLimit(1)
                                .tip(ProjectMark.lineTip(thread, under: heading))
                        }
                    }
                    .foregroundStyle(.secondary)
                    Spacer(minLength: zoomed(6))
                    if !showsActions {
                        // A new status ("Working" to the time) blurs
                        // across rather than snapping.
                        trailing(look)
                            .id(look.status)
                            .transition(Juice.reduceMotion ? .opacity : AnyTransition(BlurReplaceTransition(configuration: .downUp)))
                    }
                }
                .animation(Juice.swap, value: look.status)
            }
        }
        .padding(EdgeInsets(top: zoomed(8), leading: SidebarMetrics.leading, bottom: zoomed(8), trailing: SidebarMetrics.trailing))
        // An offline runner's threads stay listed, quietly: they can't
        // change until it's back.
        .opacity(app.remoteRunner(of: thread)?.online == false ? 0.5 : 1)
        .background {
            if landed {
                RoundedRectangle(cornerRadius: SidebarMetrics.corner)
                    .fill(Color.accentColor.opacity(0.14))
                    .transition(.opacity)
            }
        }
        .rowHighlight(selected: isSelected, hovering: showsActions, selectedColor: selectedColor, space: rowSpace)
        // The open thread's row: archived, it closes up as its panel drops
        // into the Archived heading, which the flight allows for.
        .background { if isSelected { FlightMarker(kind: .openRow) } }
        .contentShape(RoundedRectangle(cornerRadius: SidebarMetrics.corner))
        // A slight press while the mouse is down, so a click feels like it
        // landed on something.
        .scaleEffect(pressed && !Juice.reduceMotion ? 0.985 : 1)
        .animation(.snappy(duration: 0.14), value: pressed)
        // The row and its thread's row in another section are one thing,
        // so a move between Running and the Inbox glides.
        .matched("row/" + thread.id, in: rowSpace)
        .onAppear {
            // Only a row turning up within a moment of its turn finishing,
            // unread: a reply that's just arrived, not one scrolled to.
            guard mode == .inbox, look.unread || look.done || look.status == .needsYou,
                  Date().timeIntervalSince(thread.lastActivityAt) < 3 else { return }
            landed = true
            withAnimation(.easeOut(duration: Juice.reduceMotion ? 0.4 : 1.1).delay(0.3)) { landed = false }
        }
        // Selects on mouse down, as the system list did and Mail does; a
        // tap gesture waits for the mouse to come back up. Dragging left
        // swipes the row, for a mouse (global, as the row moves with it).
        // Any other way drags the thread out, to drop into the open
        // thread's message (ThreadDrag).
        .gesture(DragGesture(minimumDistance: 0, coordinateSpace: .global).onChanged { value in
            guard !draggingOut else { return }
            if pressed, !swipe.isSwiping, RowSwipe.dragsOut(dx: value.translation.width, dy: value.translation.height) {
                dragOut()
                return
            }
            swipe.drag(value.translation)
            guard !pressed else { return }
            pressed = true
            placeBeforePress = app.place
            select()
        }.onEnded { _ in
            pressed = false
            swipe.dragEnded()
        })
        // After the gesture, so clicking these never selects the row.
        .overlay(alignment: .trailing) {
            if showsActions {
                RowActions(thread: thread, actions: mode.rowActions)
                    // The tour points at a sample's moon and box.
                    .tourTarget(.rowButtons, when: thread.sample)
                    .padding(.trailing, SidebarMetrics.trailing - zoomed(5))
            }
        }
        .rowSwipe(swipe, leaving: slidingOff)
        // Off as quickly as a swiped row goes, back (an archive that
        // failed) with the spring a short swipe has.
        .animation(slidingOff ? .easeIn(duration: Juice.reduceMotion ? 0.1 : 0.16)
                   : Juice.reduceMotion ? .easeOut(duration: 0.15) : .spring(response: 0.3, dampingFraction: 0.75),
                   value: slidingOff)
        .onHover { hovering = $0 }
        .onChange(of: pointerOver, initial: true) {
            swipe.action = RowSwipeAction.forRow(thread, mode: mode, app: app)
            swipe.setHovered(pointerOver)
        }
        .onDisappear { swipe.stop() }
        .animation(Juice.hover, value: showsActions)
        // The whole title, which the row often cuts short, and where it runs.
        // The status and project marks have their own tips over this one.
        .tip((thread.title.isEmpty ? "Untitled" : thread.title) + "\n" + (place.map { "\($0), in " } ?? "") + thread.cwd.abbreviatingHome)
        .iconContextMenu {
            ThreadMenu(thread: thread)
            Divider()
            // As in the thread's ... menu, so Mike can grab a thread's id
            // to point an agent at it without opening the thread (6 Nov).
            Button("Copy thread id", systemImage: "number") { app.copyToPasteboard(thread.id) }
        }
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(isSelected ? [.isButton, .isSelected] : .isButton)
        .accessibilityAction { select() }
    }

    private var selectedColor: Color { Color.primary.opacity(activeState == .key ? 0.08 : 0.06) }

    /// A hibernating thread says when it wakes, where the time would be.
    private var wakeText: String? {
        if thread.snoozedUntilRelease { return "Back on update" }
        if thread.snoozedUntilRestart { return "Back on restart" }
        if let until = thread.snoozedUntil { return "Back \(RelativeTime.until(until, now: app.now))" }
        return nil
    }

    @ViewBuilder
    private func trailing(_ look: ThreadRowLook) -> some View {
        // Every login in its pool is out of room; it carries on by itself.
        // Says so over whatever the turn that ran dry left (often Failed).
        if mode != .hibernating, let waiting = thread.waitingForRoom, !thread.isArchived {
            Text(Pools.waitingLine(waiting, now: app.now))
                .font(.system(size: TypeScale.sidebarMeta))
                .foregroundStyle(SidebarMetrics.faint)
                .lineLimit(1)
        } else if mode != .hibernating, thread.waitingForNetwork != nil, !thread.isArchived {
            // Its turn lost the internet; it carries on once it's back,
            // so it isn't Failed in the sense of needing Mike.
            Text("Waiting for connection")
                .font(.system(size: TypeScale.sidebarMeta))
                .foregroundStyle(SidebarMetrics.faint)
                .lineLimit(1)
                .tip("The internet dropped during its turn. It carries on by itself once the connection is back.")
        } else {
            trailingStatus(look)
        }
    }

    @ViewBuilder
    private func trailingStatus(_ look: ThreadRowLook) -> some View {
        switch look.status {
        case .time:
            if mode == .hibernating {
                if let words = WakeWords.row(thread, now: app.now) {
                    // A topic, or Thinking… while the runner works out when.
                    Text(words.text)
                        .font(.system(size: TypeScale.sidebarMeta))
                        .foregroundStyle(SidebarMetrics.faint)
                        .lineLimit(1)
                        .truncationMode(.tail)
                        .frame(maxWidth: zoomed(110), alignment: .trailing)
                        .tip(words.tip)
                } else if let wakeText {
                    Text(wakeText).font(.system(size: TypeScale.sidebarMeta)).foregroundStyle(SidebarMetrics.faint)
                }
            } else if look.woke, let woke = thread.woke {
                // Back from hibernating by itself; the time comes back
                // once it's been opened.
                Text("Woke up")
                    .font(.system(size: TypeScale.sidebarMeta, weight: .medium))
                    .foregroundStyle(Color.accentColor)
                    .tip(WokeWords.tip(woke))
            } else if section == .hibernating, let wake = app.wakes[thread.id], let next = wake.nextRunAt {
                // When its schedule messages it next, where the time would be.
                Text(RelativeTime.until(next, now: app.now))
                    .font(.system(size: TypeScale.sidebarMeta))
                    .monospacedDigit()
                    .foregroundStyle(SidebarMetrics.faint)
                    .tip("Scheduled: \(wake.whenText)")
            } else {
                time.foregroundStyle(SidebarMetrics.faint)
            }
        case .working:
            HStack(alignment: .firstTextBaseline, spacing: zoomed(5)) {
                // An accent arc turned in the render server (SpinnerView):
                // the system mini spinner drew grey whatever the tint, and
                // the symbol's variable colour left it a pale asterisk.
                SpinnerMark(color: .controlAccentColor)
                    .frame(width: zoomed(12), height: zoomed(12))
                    // On the text's baseline, centred on its lowercase.
                    .alignmentGuide(.firstTextBaseline) { $0[VerticalAlignment.center] + zoomed(4) }
                // How long the turn has run, ticking once a second. No
                // rolling digits: each roll animated for a moment, and every
                // frame of it laid the whole window out again. With a dozen
                // threads running, ticking out of step, that kept the main
                // thread over half busy doing nothing, and every click and
                // scroll waited behind it (29 Oct).
                TimelineView(.periodic(from: .now, by: 1)) { context in
                    let elapsed = ThreadRowLook.workingLabel(since: thread.lastActivityAt, now: context.date)
                    Text(look.labelled ? "Working " + elapsed : elapsed).monospacedDigit()
                }
            }
            .font(.system(size: TypeScale.sidebarMeta, weight: .medium))
            .foregroundStyle(Color.accentColor)
            .tip("Working")
        case .background:
            // Still being worked on, but by sub-agents or jobs in the
            // background: the same spinner in grey, and what's running
            // instead of a clock. Visibly not a streaming turn.
            HStack(alignment: .firstTextBaseline, spacing: zoomed(5)) {
                SpinnerMark(color: .secondaryLabelColor)
                    .frame(width: zoomed(12), height: zoomed(12))
                    .alignmentGuide(.firstTextBaseline) { $0[VerticalAlignment.center] + zoomed(4) }
                Text(BackgroundWork.short(thread.background))
            }
            .font(.system(size: TypeScale.sidebarMeta, weight: .medium))
            .foregroundStyle(.secondary)
            .tip(BackgroundWork.detail(thread.background))
        case .needsYou:
            // The dot in the gutter says it.
            time.foregroundStyle(SidebarMetrics.faint)
        case .failed:
            Text("Failed").font(.system(size: TypeScale.sidebarMeta, weight: .medium)).foregroundStyle(Color(nsColor: Theme.failed))
                .tip("The last turn failed")
        case .stopped:
            Text("Stopped").font(.system(size: TypeScale.sidebarMeta)).foregroundStyle(.secondary)
                .tip("Stopped when the runner restarted")
        }
    }

    /// When the thread was last active (archived, in the archive).
    private var time: Text {
        Text(RelativeTime.short(mode == .archive ? thread.archivedAt ?? thread.lastActivityAt : thread.lastActivityAt, now: app.now))
            .font(.system(size: TypeScale.sidebarMeta))
            .monospacedDigit()
    }
}

/// A row's project as a tile two lines tall: the first project it joined,
/// with an edge of a second tile showing behind it when it's in more than
/// one. A quiet folder when it's in none. The front tile is the project's
/// icon: its picture filling the tile, or its symbol or first letter on it.
private struct ProjectTiles: View {
    @Environment(AppModel.self) private var app
    let projects: [ThreadProject]
    /// Another runner's thread: that Mac's symbol in place of the folder.
    var runnerIcon: String? = nil

    var body: some View {
        let size = zoomed(30)
        ZStack(alignment: .bottomLeading) {
            if projects.count > 1 {
                // Up and to the right, so the front tile keeps its place,
                // with the front tile's shape (and a hairline round it) cut
                // out: both are see-through, so the overlap would otherwise
                // show darker, and the selected row's highlight shows
                // through either way.
                RoundedRectangle(cornerRadius: zoomed(7))
                    .fill(Color.primary.opacity(0.08))
                    .frame(width: size, height: size)
                    .mask {
                        ZStack {
                            Rectangle()
                            RoundedRectangle(cornerRadius: zoomed(8))
                                .frame(width: size + zoomed(2), height: size + zoomed(2))
                                .offset(x: -zoomed(4), y: zoomed(4))
                                .blendMode(.destinationOut)
                        }
                        .compositingGroup()
                    }
                    .offset(x: zoomed(4), y: -zoomed(4))
            }
            let icon = projects.first.flatMap { app.project($0.id)?.icon }
            if let path = icon?.image?.path, let image = ProjectIconImages.image(at: path) {
                Image(nsImage: image)
                    .resizable()
                    .interpolation(.high)
                    .aspectRatio(contentMode: .fit)
                    .frame(width: size, height: size)
                    .clipShape(RoundedRectangle(cornerRadius: zoomed(7), style: .continuous))
            } else {
                Group {
                    if let symbol = icon?.symbol, ProjectIconImages.symbolExists(symbol) {
                        Image(systemName: symbol)
                            .font(.system(size: zoomed(14)))
                            .foregroundStyle(.secondary)
                    } else if let project = projects.first {
                        Text(ProjectMark.letter(project.title))
                            .font(.system(size: zoomed(14), weight: .semibold))
                            .foregroundStyle(.secondary)
                    } else if let runnerIcon {
                        // Wider than tall (a Mac mini is a flat box), so a
                        // little larger than the folder to read at a glance.
                        Image(systemName: runnerIcon)
                            .font(.system(size: zoomed(16)))
                            .foregroundStyle(.secondary)
                    } else {
                        Image(systemName: "folder")
                            .font(.system(size: zoomed(12)))
                            .foregroundStyle(SidebarMetrics.faint)
                    }
                }
                .frame(width: size, height: size)
                .background(Color.primary.opacity(projects.isEmpty ? 0.04 : 0.08), in: RoundedRectangle(cornerRadius: zoomed(7)))
            }
        }
        .frame(width: size + zoomed(4), height: size + zoomed(4), alignment: .bottomLeading)
        .accessibilityHidden(true)
    }
}

/// The small buttons a row shows on hover in place of its time.
private struct RowActions: View {
    @Environment(AppModel.self) private var app
    let thread: ThreadSummary
    let actions: [RowAction]

    var body: some View {
        HStack(spacing: zoomed(2)) {
            ForEach(Array(actions.enumerated()), id: \.offset) { _, action in
                switch action {
                case .star:
                    Button { app.setStarred(thread.id, !thread.isStarred) } label: {
                        Image(systemName: thread.isStarred ? "star.fill" : "star")
                    }
                    .buttonStyle(RowIconButtonStyle())
                    .tip(thread.isStarred ? "Remove star" : "Star: keep at the top")
                case .snooze:
                    HibernateButton(threadId: thread.id)
                case .archive:
                    Button {
                        guard BusyConfirm.allowed(.archive, threadId: thread.id, app: app) else { return }
                        app.archive(thread.id)
                    } label: { Image(systemName: "archivebox") }
                        .buttonStyle(RowIconButtonStyle())
                        .tip(AppShortcuts.shared.tip("Archive", .archive))
                case .unsnooze:
                    Button { app.unsnooze(thread.id) } label: { Image(systemName: "arrow.uturn.backward") }
                        .buttonStyle(RowIconButtonStyle())
                        .tip("Wake")
                case .unarchive:
                    Button { app.unarchive(thread.id) } label: { Image(systemName: "arrow.uturn.backward") }
                        .buttonStyle(RowIconButtonStyle())
                        .tip("Unarchive")
                }
            }
        }
    }
}

/// The moon: a plain button that pops the Hibernate menu up from AppKit.
private struct HibernateButton: View {
    @Environment(AppModel.self) private var app
    let threadId: String
    @State private var anchor = MenuAnchor()

    var body: some View {
        Button {
            // The row keeps its buttons, the moon among them, while the menu
            // is open: on the way down into it the pointer leaves the row.
            anchor.held = { [app, threadId] open in
                if open { app.menuOpenRow = threadId } else if app.menuOpenRow == threadId { app.menuOpenRow = nil }
            }
            anchor.popUp(SnoozeNSMenu.make(threadId: threadId, app: app), below: true)
        } label: { Image(systemName: "moon.zzz") }
            .buttonStyle(RowIconButtonStyle())
            .background(MenuAnchorView(anchor: anchor))
            .tip("Hibernate")
    }
}

/// A 22 pt (at 100%) borderless icon button with its own faint hover square.
struct RowIconButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        RowIconButton(configuration: configuration)
    }

    private struct RowIconButton: View {
        let configuration: ButtonStyleConfiguration
        @State private var hovering = false

        var body: some View {
            configuration.label
                .font(.system(size: zoomed(13)))
                .foregroundStyle(hovering ? .primary : .secondary)
                .frame(width: zoomed(22), height: zoomed(22))
                .background(
                    Color.primary.opacity(configuration.isPressed ? 0.14 : hovering ? 0.08 : 0),
                    in: RoundedRectangle(cornerRadius: zoomed(5))
                )
                .contentShape(Rectangle())
                .onHover { hovering = $0 }
        }
    }
}

/// A full-width sidebar row that does one thing: New schedule at the top
/// of Scheduled, New project, Show more under the archive.
struct SidebarButtonRow: View {
    let icon: String
    let title: String
    /// The tooltip, if the title alone doesn't say enough.
    var tip: String? = nil
    var active = false
    /// Its work is on the way: a spinner for the icon, and no more clicks.
    var busy = false
    let action: () -> Void
    @State private var hovering = false
    @Environment(\.controlActiveState) private var activeState

    var body: some View {
        Button(action: action) {
            HStack(spacing: zoomed(8)) {
                Group {
                    if busy {
                        SpinnerMark(color: .secondaryLabelColor).frame(width: zoomed(12), height: zoomed(12))
                    } else {
                        Image(systemName: icon)
                            .font(.system(size: TypeScale.sidebarButton))
                            .foregroundStyle(.secondary)
                    }
                }
                .frame(width: zoomed(16))
                Text(title)
                    .font(.system(size: TypeScale.sidebarButton))
                    .foregroundStyle(.primary)
                Spacer(minLength: zoomed(6))
            }
            // The icon sits where thread titles start, Codex style.
            .padding(.leading, SidebarMetrics.leading - zoomed(2))
            .padding(.trailing, SidebarMetrics.trailing)
            .padding(.vertical, zoomed(7))
            .background(background, in: RoundedRectangle(cornerRadius: SidebarMetrics.corner))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(busy)
        .onHover { hovering = $0 }
        .tip(tip ?? title)
    }

    private var background: Color {
        if active { return Color.primary.opacity(activeState == .key ? 0.08 : 0.06) }
        return hovering ? SidebarMetrics.hover : .clear
    }
}

/// Snooze, archive and copy, shared by the context menu and the toolbar.
struct ThreadMenu: View {
    @Environment(AppModel.self) private var app
    let thread: ThreadSummary

    var body: some View {
        // So several threads can be open at once (Mike, 28 Oct).
        if app.dock.layout.contains(WindowDock.threadPanel(thread.id)) {
            Button("Move to Main Panel", systemImage: "rectangle.portrait.and.arrow.forward") {
                app.dock.close(WindowDock.threadPanel(thread.id))
                app.select(thread.id)
            }
        } else {
            Button("Open in New Panel", systemImage: "rectangle.split.2x1") { app.openThreadInPanel(thread.id) }
        }
        Divider()
        Button("Rename", systemImage: "pencil") { app.startRenaming(thread.id) }
        Button(thread.isStarred ? "Remove Star" : "Star", systemImage: thread.isStarred ? "star.slash" : "star") {
            app.setStarred(thread.id, !thread.isStarred)
        }
        SnoozeMenu(threadId: thread.id)
        if thread.snoozedUntil != nil {
            Button("Wake", systemImage: "sun.max") { app.unsnooze(thread.id) }
        }
        if thread.isArchived {
            Button("Unarchive", systemImage: "tray.and.arrow.up") { app.unarchive(thread.id) }
        } else {
            Button("Archive", systemImage: "archivebox") { app.archive(thread.id) }
        }
        // Projects are this Mac's runner's; another runner's threads
        // aren't in them.
        if app.projectsSupported, !thread.isRemote {
            ThreadProjectsMenu(thread: thread)
        }
    }
}

/// "Projects ▸": a tick by each project the thread is in (choosing one
/// puts it in or takes it out, by hand, so it's pinned or remembered), a
/// new one, and asking the librarian to look at it now.
struct ThreadProjectsMenu: View {
    @Environment(AppModel.self) private var app
    let thread: ThreadSummary

    var body: some View {
        IconMenu("Projects", systemImage: "square.stack") {
            let live = app.projects.filter { !$0.archived }.sorted { $0.title.localizedStandardCompare($1.title) == .orderedAscending }
            ForEach(live) { project in
                let inIt = thread.projects.contains { $0.id == project.id }
                Toggle(project.title, systemImage: "square.stack", isOn: Binding(
                    get: { inIt },
                    set: { on in app.setProjects(thread.id, add: on ? [project.id] : [], remove: on ? [] : [project.id]) }
                ))
            }
            if !live.isEmpty { Divider() }
            Button("New project…", systemImage: "plus") { app.newProject(with: thread.id) }
                .disabled(app.isBusy(BusyKey.newProject))
            Button("Ask the librarian to look", systemImage: "books.vertical") { app.runLibrarian(threadId: thread.id) }
                .disabled(app.isBusy(BusyKey.runLibrarian(thread.id)))
        }
    }
}

struct SnoozeMenu: View {
    let threadId: String

    var body: some View {
        IconMenu("Hibernate", systemImage: "moon.zzz") { SnoozeMenuItems(threadId: threadId) }
    }
}

/// The snooze presets and "Pick a time…". Titles follow `app.now`; the date
/// is worked out when an item is chosen, not when the menu was built.
struct SnoozeMenuItems: View {
    @Environment(AppModel.self) private var app
    let threadId: String

    var body: some View {
        ForEach(Snooze.presets(now: app.now)) { preset in
            Button(preset.title, systemImage: preset.symbol) {
                app.snooze(threadId, until: Snooze.date(for: preset.id, now: Date()))
            }
        }
        if app.restartPending {
            Button(Snooze.untilRestartTitle, systemImage: "arrow.clockwise") {
                app.snoozeUntilRestart(threadId)
            }
        }
        Divider()
        Button("Pick a time…", systemImage: "calendar") {
            SnoozePicker.show(threadId: threadId, app: app)
        }
        Button(WakeWords.menuTitle, systemImage: "text.bubble") {
            WakeWhenPrompt.show(threadId: threadId, app: app)
        }
    }
}

/// The Hibernate menu as an AppKit menu, for the row's moon button: the
/// same presets, "Until the runner restarts" while one's waiting, then
/// "Pick a time…" and "Wake when…".
@MainActor
enum SnoozeNSMenu {
    static func make(threadId: String, app: AppModel) -> NSMenu {
        // From a hover button, so ask before snoozing a thread whose turn
        // is underway, which stops the turn. Asked when an item is chosen.
        func allowed() -> Bool { BusyConfirm.allowed(.snooze, threadId: threadId, app: app) }
        let menu = NSMenu()
        for preset in Snooze.presets(now: app.now) {
            menu.addItem(ActionMenuItem(preset.title, symbol: preset.symbol) {
                guard allowed() else { return }
                app.snooze(threadId, until: Snooze.date(for: preset.id, now: Date()))
            })
        }
        if app.restartPending {
            let restart = ActionMenuItem(Snooze.untilRestartTitle, symbol: "arrow.clockwise") {
                guard allowed() else { return }
                app.snoozeUntilRestart(threadId)
            }
            menu.addItem(restart)
        }
        menu.addItem(.separator())
        let pick = ActionMenuItem("Pick a time…", symbol: "calendar") {
            guard allowed() else { return }
            SnoozePicker.show(threadId: threadId, app: app)
        }
        menu.addItem(pick)
        let words = ActionMenuItem(WakeWords.menuTitle, symbol: "text.bubble") {
            guard allowed() else { return }
            WakeWhenPrompt.show(threadId: threadId, app: app)
        }
        menu.addItem(words)
        return menu
    }
}

/// Asks before a hover button stops a running turn (`BusyThreadAction`).
@MainActor
enum BusyConfirm {
    /// Whether to go ahead: the thread isn't busy, or Mike said yes. Its
    /// status is read now, not when the row was drawn.
    static func allowed(_ action: BusyThreadAction.Action, threadId: String, app: AppModel) -> Bool {
        guard let thread = app.threads[threadId], BusyThreadAction.needsConfirm(thread) else { return true }
        let prompt = BusyThreadAction.prompt(action, thread: thread)
        let alert = NSAlert()
        alert.messageText = prompt.title
        alert.informativeText = prompt.detail
        alert.addButton(withTitle: action == .archive ? "Archive" : "Hibernate")
        alert.addButton(withTitle: "Cancel")
        return alert.runModal() == .alertFirstButtonReturn
    }
}

struct EmptyNote: View {
    let text: String

    var body: some View {
        Text(text)
            .font(.system(size: TypeScale.sidebarPreview))
            .foregroundStyle(.secondary)
            .padding(.leading, SidebarMetrics.leading)
            .padding(.top, zoomed(10))
    }
}

/// The top of the Scheduled view: the view's name
/// and its count. The activity bar's top icon (or Esc) goes back to the
/// inbox, so there's no back button.
struct ModeHeader: View {
    let title: String
    let count: Int?

    var body: some View {
        HStack(spacing: zoomed(6)) {
            Text(title)
                .font(.system(size: TypeScale.sidebarButton, weight: .semibold))
            Spacer()
            if let count, count > 0 {
                Text("\(count)").font(.system(size: TypeScale.sidebarFooter)).foregroundStyle(SidebarMetrics.faint).monospacedDigit()
            }
        }
        // On the same column as the titles below.
        .padding(.leading, SidebarMetrics.outerInset + SidebarMetrics.leading)
        .padding(.trailing, SidebarMetrics.outerInset + SidebarMetrics.trailing)
        .padding(.top, zoomed(4))
        .frame(height: zoomed(34))
    }
}

struct SearchField: View {
    @Binding var text: String
    let prompt: String
    /// Puts the cursor in it when it appears, for a page with nothing else
    /// to type in.
    var focusOnAppear = false
    @FocusState private var focused: Bool

    var body: some View {
        // The glass and the prompt on the same columns as a
        // SidebarButtonRow's icon and title.
        HStack(spacing: zoomed(8)) {
            Image(systemName: "magnifyingglass")
                .font(.system(size: zoomed(12.5)))
                .foregroundStyle(SidebarMetrics.faint)
                .frame(width: zoomed(16))
            TextField(prompt, text: $text)
                .textFieldStyle(.plain)
                .font(.system(size: TypeScale.sidebarButton))
                .focused($focused)
                .onAppear { if focusOnAppear { focused = true } }
                .tip(prompt)
            if !text.isEmpty {
                Button {
                    text = ""
                } label: {
                    Image(systemName: "xmark.circle.fill").foregroundStyle(.tertiary)
                }
                .buttonStyle(.plain)
                .tip("Clear")
            }
        }
        .padding(.leading, SidebarMetrics.leading - zoomed(2))
        .padding(.trailing, zoomed(9))
        .padding(.vertical, zoomed(6))
        // A field, not a row: a lighter fill and a hairline. At the selected
        // row's fill it read as a selected item stacked on the list.
        .background(Color.primary.opacity(0.035), in: RoundedRectangle(cornerRadius: SidebarMetrics.corner))
        .overlay(RoundedRectangle(cornerRadius: SidebarMetrics.corner).strokeBorder(.separator, lineWidth: 0.5))
    }
}

/// "Wake when…": a text box for when, in Mike's own words. The runner's
/// model turns them into a time or a topic (protocol "Hibernate in words").
@MainActor
enum WakeWhenPrompt {
    static func show(threadId: String, app: AppModel) {
        let field = NSTextField(frame: NSRect(x: 0, y: 0, width: 320, height: 24))
        field.placeholderString = WakeWords.placeholder
        field.cell?.isScrollable = true
        field.cell?.wraps = false
        let alert = NSAlert()
        alert.messageText = "Hibernate until"
        alert.accessoryView = field
        alert.addButton(withTitle: "Hibernate")
        alert.addButton(withTitle: "Cancel")
        alert.window.initialFirstResponder = field
        guard alert.runModal() == .alertFirstButtonReturn else { return }
        let said = field.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !said.isEmpty else { return }
        app.hibernateWhen(threadId, said: said)
    }
}

/// "Pick a time" for snoozing: a month calendar to click a day on, with
/// a time field under it. Mike asked for a calendar (2 Nov): the stepper
/// field alone meant typing or nudging a date digit by digit.
@MainActor
enum SnoozePicker {
    static func show(threadId: String, app: AppModel) {
        let start = Date().addingTimeInterval(3 * 3600)

        let calendar = NSDatePicker()
        calendar.datePickerStyle = .clockAndCalendar
        calendar.datePickerElements = .yearMonthDay
        calendar.isBezeled = false
        calendar.drawsBackground = false
        calendar.dateValue = start
        // Today stays clickable: a later time today is fine, and the time
        // field is checked against now below.
        calendar.minDate = Calendar.current.startOfDay(for: Date())
        calendar.sizeToFit()
        calendar.setTip("Day to wake it")

        // Its own picker, not the calendar's: with .hourMinute the
        // graphical style draws an analogue clock face.
        let time = NSDatePicker()
        time.datePickerStyle = .textFieldAndStepper
        time.datePickerElements = .hourMinute
        time.dateValue = start
        time.sizeToFit()
        time.setTip("Time to wake it")

        let stack = NSStackView(views: [calendar, time])
        stack.orientation = .vertical
        stack.alignment = .centerX
        stack.spacing = 10
        stack.frame = NSRect(origin: .zero, size: stack.fittingSize)

        let alert = NSAlert()
        alert.messageText = "Hibernate until"
        alert.accessoryView = stack
        alert.addButton(withTitle: "Hibernate")
        alert.addButton(withTitle: "Cancel")
        while alert.runModal() == .alertFirstButtonReturn {
            let when = combine(day: calendar.dateValue, time: time.dateValue)
            if when > Date() {
                app.snooze(threadId, until: when)
                return
            }
            // An earlier time today: ask again rather than hibernating
            // into the past, which would wake it straight back up.
            alert.informativeText = "That time has already gone. Pick a later one."
        }
    }

    /// The calendar's day at the time field's hour and minute.
    static func combine(day: Date, time: Date) -> Date {
        let cal = Calendar.current
        var parts = cal.dateComponents([.year, .month, .day], from: day)
        let clock = cal.dateComponents([.hour, .minute], from: time)
        parts.hour = clock.hour
        parts.minute = clock.minute
        return cal.date(from: parts) ?? day
    }
}
