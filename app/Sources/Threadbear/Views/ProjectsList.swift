import AppKit
import SwiftUI
import ThreadbearCore

/// The sidebar's Projects view: a section per project, newest activity
/// first, with its open threads under it (a thread in two projects is
/// under both), then the threads in no project. A project's header opens
/// its page. A project's archived threads are folded away under its open
/// ones, a few at a time.
struct ProjectsList: View {
    @Environment(AppModel.self) private var app
    @State private var showArchived = false
    /// How many archived threads each unfolded project shows.
    @State private var archivedShown: [String: Int] = [:]

    var body: some View {
        let built = app.projectSections
        let archived = app.projects.filter(\.archived)
        // Each thread's first row, for the arrow keys to scroll to.
        var firstRow: [String: String] = [:]
        for section in built.sections {
            for thread in section.threads where firstRow[thread.id] == nil {
                firstRow[thread.id] = SectionRow.id(section: section.id, thread: thread.id)
            }
        }
        for thread in built.unfiled where firstRow[thread.id] == nil {
            firstRow[thread.id] = SectionRow.id(section: Self.unfiledId, thread: thread.id)
        }
        return VStack(spacing: 0) {
            ModeHeader(title: "Projects", count: built.sections.count)
            SidebarButtonRow(icon: "plus", title: "New project", tip: "Make a new project", busy: app.isBusy(BusyKey.newProject)) {
                app.newProject(with: nil)
            }
            .padding(.horizontal, SidebarMetrics.outerInset)
            ThreadList(order: built.order, scrollID: { firstRow[$0] ?? $0 }) { select in
                if app.threadsLoaded {
                    ForEach(built.sections) { section in
                        ProjectHeader(project: section.project, count: section.threads.count)
                        ForEach(section.threads.map { SectionRow(section: section.id, thread: $0) }) { row in
                            ThreadRowView(thread: row.thread, mode: .projects, heading: section.project.id) { select(row.thread.id) }
                        }
                        if !section.archived.isEmpty {
                            let shown = archivedShown[section.id] ?? 0
                            ArchivedFold(count: section.archived.count, open: shown > 0) {
                                archivedShown[section.id] = shown > 0 ? nil : Self.archivedStep
                            }
                            // Their own section ids: a row id is a section's and a thread's.
                            ForEach(section.archived.prefix(shown).map { SectionRow(section: section.id + Self.archivedSuffix, thread: $0) }) { row in
                                ThreadRowView(thread: row.thread, mode: .archive, heading: section.project.id) { select(row.thread.id) }
                            }
                            if shown > 0 && section.archived.count > shown {
                                ShowMoreRow(more: min(Self.archivedStep, section.archived.count - shown)) {
                                    archivedShown[section.id] = shown + Self.archivedStep
                                }
                            }
                        }
                    }
                    if !built.unfiled.isEmpty {
                        SectionHeading(title: "Not in a project", icon: "square.dashed")
                        ForEach(built.unfiled.map { SectionRow(section: Self.unfiledId, thread: $0) }) { row in
                            ThreadRowView(thread: row.thread, mode: .projects) { select(row.thread.id) }
                        }
                    }
                    if built.sections.isEmpty && built.unfiled.isEmpty {
                        EmptyNote(text: "No projects yet.")
                    }
                    if !archived.isEmpty {
                        ArchivedProjects(projects: archived, shown: $showArchived)
                    }
                }
            }
        }
    }

    static let unfiledId = "-"
    static let archivedSuffix = "/archived"
    /// Archived threads shown at a time.
    static let archivedStep = 5
}

/// Under a project's open threads: how many it has archived, a click
/// showing the newest of them.
private struct ArchivedFold: View {
    let count: Int
    let open: Bool
    let toggle: () -> Void
    @State private var hovering = false

    var body: some View {
        Button(action: toggle) {
            HStack(spacing: zoomed(5)) {
                Text("\(count) archived").monospacedDigit()
                Image(systemName: open ? "chevron.down" : "chevron.right")
                    .font(.system(size: zoomed(8), weight: .semibold))
                Spacer(minLength: 0)
            }
            .font(.system(size: TypeScale.sidebarMeta))
            .foregroundStyle(hovering ? AnyShapeStyle(.secondary) : AnyShapeStyle(SidebarMetrics.faint))
            .padding(.leading, SidebarMetrics.leading)
            .padding(.trailing, SidebarMetrics.trailing)
            .padding(.vertical, zoomed(4))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .onHover { hovering = $0 }
        .tip(open ? "Hide archived threads" : "Show archived threads")
    }
}

/// After the archived threads shown so far, when there are more.
private struct ShowMoreRow: View {
    let more: Int
    let action: () -> Void
    @State private var hovering = false

    var body: some View {
        Button(action: action) {
            Text("Show \(more) more")
                .font(.system(size: TypeScale.sidebarMeta))
                .foregroundStyle(hovering ? AnyShapeStyle(.secondary) : AnyShapeStyle(SidebarMetrics.faint))
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.leading, SidebarMetrics.leading)
                .padding(.vertical, zoomed(4))
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .onHover { hovering = $0 }
        .tip("Show more archived threads")
    }
}

/// A project's heading: its title, quiet like the inbox's headings but a
/// button, highlighted while its page is open.
private struct ProjectHeader: View {
    @Environment(AppModel.self) private var app
    @Environment(\.controlActiveState) private var activeState
    let project: Project
    /// Its open threads, listed under it.
    let count: Int
    @State private var hovering = false

    private var isOpen: Bool { app.openProjectId == project.id }

    var body: some View {
        Button { app.openProjectPage(project.id) } label: {
            HStack(spacing: zoomed(6)) {
                ProjectIconView(project: project, size: 15)
                .accessibilityHidden(true)
                Text(project.title)
                    .font(.system(size: TypeScale.sidebarHeading, weight: .semibold))
                    .foregroundStyle(isOpen || hovering ? .primary : .secondary)
                    .lineLimit(1)
                Spacer(minLength: zoomed(6))
                if hovering {
                    Image(systemName: "chevron.right")
                        .font(.system(size: zoomed(10), weight: .semibold))
                        .foregroundStyle(SidebarMetrics.faint)
                } else if count > 0 {
                    Text("\(count)")
                        .font(.system(size: TypeScale.sidebarMeta))
                        .foregroundStyle(SidebarMetrics.faint)
                        .monospacedDigit()
                }
            }
            .padding(.leading, SidebarMetrics.leading)
            .padding(.trailing, SidebarMetrics.trailing)
            .padding(.vertical, zoomed(6))
            .background(background, in: RoundedRectangle(cornerRadius: SidebarMetrics.corner))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .onHover { hovering = $0 }
        // The same room above each group as the inbox's headings.
        .padding(.top, zoomed(12))
        .padding(.bottom, zoomed(2))
        .tip("Open \(project.title)")
        .iconContextMenu { ProjectMenu(project: project) }
        .accessibilityAddTraits(.isHeader)
    }

    private var background: Color {
        if isOpen { return Color.primary.opacity(activeState == .key ? 0.08 : 0.06) }
        return hovering ? SidebarMetrics.hover : .clear
    }
}

/// Archived projects, folded away at the foot; each opens its page.
private struct ArchivedProjects: View {
    @Environment(AppModel.self) private var app
    let projects: [Project]
    @Binding var shown: Bool

    var body: some View {
        Button { shown.toggle() } label: {
            HStack(spacing: zoomed(5)) {
                Text("Archived projects")
                Image(systemName: shown ? "chevron.down" : "chevron.right")
                    .font(.system(size: zoomed(9), weight: .semibold))
                Spacer(minLength: 0)
                Text("\(projects.count)").monospacedDigit()
            }
            .font(.system(size: TypeScale.sidebarHeading, weight: .semibold))
            .foregroundStyle(.secondary)
            .padding(.leading, SidebarMetrics.leading)
            .padding(.trailing, SidebarMetrics.trailing)
            .padding(.top, zoomed(18))
            .padding(.bottom, zoomed(6))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .tip(shown ? "Hide archived projects" : "Show archived projects")
        if shown {
            ForEach(projects) { project in
                SidebarButtonRow(icon: "archivebox", title: project.title, tip: "Open \(project.title)", active: app.openProjectId == project.id) {
                    app.openProjectPage(project.id)
                }
            }
        }
    }
}

/// Archive, merge and delete: the project header's context menu and the
/// toolbar's ... menu while its page is open.
struct ProjectMenu: View {
    @Environment(AppModel.self) private var app
    let project: Project

    var body: some View {
        if app.openProjectId != project.id {
            Button("Open", systemImage: "arrow.right.circle") { app.openProjectPage(project.id) }
            Divider()
        }
        if project.archived {
            Button("Unarchive", systemImage: "tray.and.arrow.up") { app.setProjectArchived(project.id, false) }
        } else {
            Button("Archive", systemImage: "archivebox") { app.setProjectArchived(project.id, true) }
        }
        Button(project.notion == nil ? "Add Notion Page…" : "Notion Page…", systemImage: "checklist") { app.linkProjectNotion(project.id) }
        let others = app.projects.filter { $0.id != project.id && !$0.archived }
        if !others.isEmpty {
            IconMenu("Merge into", systemImage: "arrow.triangle.merge") {
                ForEach(others) { other in
                    Button(other.title, systemImage: "square.stack") { app.mergeProject(project.id, into: other.id) }
                }
            }
        }
        Divider()
        Button("Copy project id", systemImage: "number") { app.copyToPasteboard(project.id) }
        Divider()
        Button("Delete…", systemImage: "trash") { app.deleteProject(project.id) }
    }
}
