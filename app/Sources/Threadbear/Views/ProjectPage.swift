import AppKit
import SwiftUI
import ThreadbearCore

/// A project's page, in the detail area in place of a thread: its title,
/// goals, state and notes (each editable), its folders, its threads and the
/// patches its folders give them. Archive, merge and delete are in the
/// toolbar's ... menu.
struct ProjectPage: View {
    @Environment(AppModel.self) private var app
    let project: Project

    var body: some View {
        let threads = ProjectSections.threads(in: project.id, from: app.threads.values)
        ScrollView {
            VStack(alignment: .leading, spacing: zoomed(30)) {
                HStack(alignment: .center, spacing: zoomed(14)) {
                    IconButton(project: project)
                    VStack(alignment: .leading, spacing: zoomed(6)) {
                        TitleField(project: project)
                        Text(ProjectPage.madeBy(project, threads: threads.count, app: app))
                            .font(.system(size: TypeScale.label))
                            .foregroundStyle(Color(nsColor: Theme.faintText))
                    }
                }
                TextSection(project: project, field: .goals)
                TextSection(project: project, field: .state)
                TasksSection(project: project)
                TextSection(project: project, field: .notes)
                FoldersSection(project: project)
                ThreadsSection(project: project, threads: threads)
                PatchesSection(project: project, threads: threads)
            }
            .frame(maxWidth: zoomed(720), alignment: .leading)
            .padding(.horizontal, zoomed(32))
            .padding(.top, zoomed(28))
            .padding(.bottom, zoomed(48))
            .frame(maxWidth: .infinity)
        }
        .id(project.id)
    }

    /// "Made by the librarian on 20 Oct · 5 threads".
    static func madeBy(_ project: Project, threads: Int, app: AppModel) -> String {
        let who: String
        switch project.createdBy {
        case .mike: who = "Made by you"
        case .agent: who = "Made by an agent"
        case .librarian: who = "Made by the librarian"
        }
        var parts = [who + " on " + project.createdAt.formatted(.dateTime.day().month(.abbreviated))]
        let count = max(threads, project.threadCount)
        parts.append(count == 1 ? "1 thread" : "\(count) threads")
        if project.archived { parts.append("Archived") }
        return parts.joined(separator: " · ")
    }
}

/// The project's icon, big, with a menu to choose another or go back to
/// the one the librarian finds. The tooltip says where it came from.
private struct IconButton: View {
    @Environment(AppModel.self) private var app
    let project: Project
    @State private var hovering = false

    var body: some View {
        IconMenu {
            Button("Choose a Picture…", systemImage: "photo") { app.chooseProjectIcon(project.id) }
            if project.icon?.isChosen == true {
                Button("Use the Librarian's Icon", systemImage: "books.vertical") { app.setProjectIconAutomatic(project.id) }
            }
            if let from = project.icon?.from {
                Divider()
                Button("Show Original in Finder", systemImage: "folder") { NSWorkspace.shared.activateFileViewerSelecting([URL(fileURLWithPath: from)]) }
            }
        } label: {
            ProjectIconView(project: project, size: 44)
                .opacity(hovering ? 0.8 : 1)
        }
        .menuStyle(.button)
        .buttonStyle(.plain)
        .menuIndicator(.hidden)
        .fixedSize()
        .busy(app.isBusy(BusyKey.projectIcon(project.id)))
        .onHover { hovering = $0 }
        .tip(Self.help(project))
    }

    static func help(_ project: Project) -> String {
        guard let icon = project.icon else { return "No icon yet: the librarian looks in the project's folders for one. Click to choose a picture." }
        let source = icon.from.map { "from \($0.abbreviatingHome)" } ?? icon.symbol.map { "the \($0) symbol" } ?? ""
        switch icon.by {
        case .librarian: return "The librarian found this (\(source)) and keeps it up to date. Click to choose another."
        case .mike: return "You chose this (\(source)). Click to change it."
        case .agent: return "An agent chose this (\(source)). Click to change it."
        }
    }
}

/// The title, edited in place; Return saves it, Esc puts it back.
private struct TitleField: View {
    @Environment(AppModel.self) private var app
    let project: Project
    @State private var draft = ""
    @FocusState private var focused: Bool

    var body: some View {
        TextField("Title", text: $draft)
            .textFieldStyle(.plain)
            .font(.system(size: zoomed(24), weight: .semibold))
            .focused($focused)
            .onAppear { draft = project.title }
            .onChange(of: project.title) { _, title in if !focused { draft = title } }
            .onSubmit(save)
            .onChange(of: focused) { _, now in if !now { save() } }
            .onExitCommand {
                draft = project.title
                focused = false
            }
            .tip("The project's name")
    }

    private func save() {
        let title = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !title.isEmpty else { draft = project.title; return }
        if title != project.title { app.updateProject(project.id, ProjectUpdate(title: title)) }
    }
}

/// A section's heading, with anything that acts on the section at its right.
private struct PageHeading<Trailing: View>: View {
    let title: String
    var detail: String? = nil
    @ViewBuilder var trailing: () -> Trailing

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: zoomed(8)) {
            Text(title)
                .font(.system(size: TypeScale.label, weight: .semibold))
                .foregroundStyle(.secondary)
            if let detail {
                Text(detail)
                    .font(.system(size: TypeScale.small))
                    .foregroundStyle(Color(nsColor: Theme.faintText))
            }
            Spacer(minLength: zoomed(8))
            trailing()
        }
        .padding(.bottom, zoomed(6))
        .overlay(alignment: .bottom) { Rectangle().fill(Color(nsColor: Theme.hairline)).frame(height: 0.5) }
        .padding(.bottom, zoomed(8))
    }
}

extension PageHeading where Trailing == EmptyView {
    init(title: String, detail: String? = nil) {
        self.init(title: title, detail: detail) { EmptyView() }
    }
}

/// Goals, state or notes: the text, and Edit to change it in a box with
/// Save and Cancel. Not saved as it's typed, so the librarian's or an
/// agent's update arriving meanwhile doesn't fight the typing.
private struct TextSection: View {
    enum Field {
        case goals, state, notes

        var title: String {
            switch self {
            case .goals: return "Goals"
            case .state: return "State"
            case .notes: return "Notes"
            }
        }

        var empty: String {
            switch self {
            case .goals: return "What it's for and what done looks like."
            case .state: return "Where it's up to, what's next and what's blocked."
            case .notes: return "Decisions, gotchas, commands and links worth keeping."
            }
        }
    }

    @Environment(AppModel.self) private var app
    let project: Project
    let field: Field
    @State private var editing = false
    @State private var draft = ""
    @State private var hovering = false

    private var text: String {
        switch field {
        case .goals: return project.goals
        case .state: return project.state
        case .notes: return project.notes
        }
    }

    private var detail: String? {
        guard field == .state, let at = project.stateUpdatedAt else { return nil }
        let ago = RelativeTime.short(at, now: app.now)
        return "updated " + (ago == "now" ? "just now" : ago + " ago")
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            PageHeading(title: field.title, detail: detail) {
                if !editing {
                    Button("Edit") { start() }
                        .buttonStyle(.borderless)
                        .tip("Edit the \(field.title.lowercased()) (or double-click it)")
                        .font(.system(size: TypeScale.detail))
                        .opacity(hovering ? 1 : 0.6)
                }
            }
            if editing {
                VStack(alignment: .trailing, spacing: zoomed(8)) {
                    TextEditor(text: $draft)
                        .font(.system(size: TypeScale.label))
                        .scrollContentBackground(.hidden)
                        .padding(zoomed(6))
                        .frame(minHeight: zoomed(field == .notes ? 220 : 90))
                        .background(Color.primary.opacity(0.035), in: RoundedRectangle(cornerRadius: zoomed(6)))
                        .overlay(RoundedRectangle(cornerRadius: zoomed(6)).strokeBorder(.separator, lineWidth: 0.5))
                    HStack(spacing: zoomed(8)) {
                        Button("Cancel") { editing = false }
                            .keyboardShortcut(.cancelAction)
                            .tip("Put it back as it was (Esc)")
                        Button("Save") { save() }
                            .keyboardShortcut(.return, modifiers: .command)
                            .tip("Save (⌘Return)")
                    }
                    .controlSize(.small)
                }
            } else if text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                Text(field.empty)
                    .font(.system(size: TypeScale.label))
                    .foregroundStyle(Color(nsColor: Theme.faintText))
                    .onTapGesture(count: 2) { start() }
            } else {
                Text(TextSection.markdown(text))
                    .environment(\.openURL, OpenGate.urlAction(files: .thisMac))
                    .font(.system(size: TypeScale.label))
                    .lineSpacing(zoomed(3))
                    .foregroundStyle(.primary)
                    .textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
        .onHover { hovering = $0 }
    }

    private func start() {
        draft = text
        editing = true
    }

    private func save() {
        editing = false
        guard draft != text else { return }
        switch field {
        case .goals: app.updateProject(project.id, ProjectUpdate(goals: draft))
        case .state: app.updateProject(project.id, ProjectUpdate(state: draft))
        case .notes: app.updateProject(project.id, ProjectUpdate(notes: draft))
        }
    }

    /// Bold, code and links, with the line breaks kept. Headings and lists
    /// show as their plain lines, which reads well enough for notes.
    static func markdown(_ text: String) -> AttributedString { .inlineMarkdown(text) }
}

extension AttributedString {
    /// Bold, code and links, with the line breaks kept, for an agent's
    /// short text in a SwiftUI view (a project's notes, a review's notes).
    static func inlineMarkdown(_ text: String) -> AttributedString {
        (try? AttributedString(markdown: text, options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace))) ?? AttributedString(text)
    }
}

/// Its task board, read from the Notion database on its page
/// (docs/protocol.md, "Project tasks"): a column per Status option, cards
/// with who and when. Read-only: a card opens in Notion, where it's moved.
/// Opening the page asks the runner to read it again if it's over a
/// minute old.
private struct TasksSection: View {
    @Environment(AppModel.self) private var app
    let project: Project

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            PageHeading(title: "Tasks", detail: detail) {
                if let notion = project.notion {
                    HStack(spacing: zoomed(10)) {
                        Button { app.refreshProjectTasks(project.id, force: true) } label: { Image(systemName: "arrow.clockwise") }
                            .buttonStyle(.borderless)
                            .busy(app.isBusy(BusyKey.projectTasks(project.id)))
                            .tip("Read the board from Notion again")
                        Button { if let url = URL(string: project.tasks?.url ?? notion) { OpenGate.openWeb(url) } } label: { Image(systemName: "arrow.up.forward.square") }
                            .buttonStyle(.borderless)
                            .tip("Open the board in Notion, where cards are moved")
                    }
                    .font(.system(size: TypeScale.detail))
                } else {
                    Button("Add Notion page…") { app.linkProjectNotion(project.id) }
                        .buttonStyle(.borderless)
                        .tip("Show a task board from a Notion page here")
                        .font(.system(size: TypeScale.detail))
                }
            }
            if project.notion == nil {
                Text("None yet. A Notion page with a Tasks database shows here as a board.")
                    .font(.system(size: TypeScale.label))
                    .foregroundStyle(Color(nsColor: Theme.faintText))
            } else if let tasks = project.tasks, !tasks.columns.isEmpty {
                if let error = tasks.error {
                    Text(error)
                        .font(.system(size: TypeScale.detail))
                        .foregroundStyle(.orange)
                        .padding(.bottom, zoomed(8))
                }
                TaskBoard(tasks: tasks)
            } else if let error = project.tasks?.error {
                Text(error)
                    .font(.system(size: TypeScale.label))
                    .foregroundStyle(.orange)
                    .textSelection(.enabled)
            } else {
                Text(project.tasks?.loading == false ? "No cards yet." : "Reading the board from Notion…")
                    .font(.system(size: TypeScale.label))
                    .foregroundStyle(Color(nsColor: Theme.faintText))
            }
        }
        .onAppear { app.refreshProjectTasks(project.id) }
    }

    /// "8 open · read 2m ago".
    private var detail: String? {
        guard let tasks = project.tasks, !tasks.loading else { return nil }
        var parts = ["\(tasks.openCount) open"]
        if let at = tasks.fetchedAt {
            let ago = RelativeTime.short(at, now: app.now)
            parts.append("read " + (ago == "now" ? "just now" : ago + " ago"))
        }
        return parts.joined(separator: " · ")
    }
}

/// The columns side by side, each as wide as the others. A Complete
/// column shows its newest few; the rest are a click away in Notion.
private struct TaskBoard: View {
    let tasks: ProjectTasks
    static let doneShown = 3

    var body: some View {
        HStack(alignment: .top, spacing: zoomed(8)) {
            ForEach(tasks.columns) { column in
                let items = tasks.items(in: column)
                VStack(alignment: .leading, spacing: zoomed(6)) {
                    HStack(spacing: zoomed(6)) {
                        Circle().fill(TaskBoard.color(column.color)).frame(width: zoomed(6), height: zoomed(6))
                        Text(column.name)
                            .font(.system(size: TypeScale.detail, weight: .semibold))
                            .foregroundStyle(.secondary)
                            .lineLimit(1)
                        Spacer(minLength: 0)
                        Text("\(items.count)")
                            .font(.system(size: TypeScale.detail))
                            .foregroundStyle(Color(nsColor: Theme.faintText))
                            .monospacedDigit()
                    }
                    .padding(.horizontal, zoomed(4))
                    .padding(.bottom, zoomed(2))
                    let shown = column.kind == .done ? Array(items.prefix(Self.doneShown)) : items
                    ForEach(shown) { TaskCard(task: $0, done: column.kind == .done) }
                    if shown.count < items.count, let url = URL(string: tasks.url) {
                        PlainLink(title: "\(items.count - shown.count) more", help: "See them in Notion") { OpenGate.openWeb(url) }
                            .font(.system(size: TypeScale.detail))
                            .foregroundStyle(Color(nsColor: Theme.faintText))
                            .padding(.horizontal, zoomed(4))
                    }
                }
                .padding(zoomed(6))
                .frame(maxWidth: .infinity, minHeight: zoomed(80), alignment: .topLeading)
                .background(Color(nsColor: Theme.cardBackground), in: RoundedRectangle(cornerRadius: zoomed(8)))
            }
        }
    }

    static func color(_ name: String?) -> Color { TaskColors.color(name) }
}

/// Notion's colour names as SwiftUI colours, for a column's dot on the
/// board and a card's icon in Highlights.
enum TaskColors {
    static func color(_ name: String?) -> Color {
        switch name {
        case "blue": return .blue
        case "green": return .green
        case "orange": return .orange
        case "yellow": return .yellow
        case "red": return .red
        case "purple": return .purple
        case "pink": return .pink
        case "brown": return .brown
        default: return Color(nsColor: Theme.faintText)
        }
    }
}

/// One card: its title, then who, when and the thread working on it. A
/// click opens it in Notion; the thread chip opens the thread.
struct TaskCard: View {
    @Environment(AppModel.self) private var app
    let task: ProjectTask
    let done: Bool
    @State private var hovering = false

    private var thread: ThreadSummary? {
        guard let id = task.thread?.lowercased(), id.count >= 6 else { return nil }
        return app.threads[id] ?? app.threads.values.first { $0.id.hasPrefix(id) }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: zoomed(4)) {
            Text(task.title)
                .font(.system(size: TypeScale.detail))
                .foregroundStyle(done ? .secondary : .primary)
                .lineLimit(4)
                .fixedSize(horizontal: false, vertical: true)
            if !task.who.isEmpty || task.due != nil || thread != nil {
                // One line when it fits, else who over when, so a date
                // range in a narrow column isn't cut off.
                ViewThatFits(in: .horizontal) {
                    HStack(spacing: zoomed(6)) { meta }
                    VStack(alignment: .leading, spacing: zoomed(2)) { meta }
                }
                .font(.system(size: TypeScale.small))
                .foregroundStyle(Color(nsColor: Theme.faintText))
            }
        }
        .padding(.horizontal, zoomed(8))
        .padding(.vertical, zoomed(7))
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(hovering ? Color(nsColor: Theme.hoverFill) : Color(nsColor: Theme.codeBackground), in: RoundedRectangle(cornerRadius: zoomed(6)))
        .overlay(RoundedRectangle(cornerRadius: zoomed(6)).strokeBorder(Color(nsColor: Theme.cardBorder), lineWidth: 0.5))
        .contentShape(Rectangle())
        .onTapGesture { if let url = URL(string: task.url) { OpenGate.openWeb(url) } }
        .onHover { hovering = $0 }
        .tip("Open in Notion")
    }

    @ViewBuilder private var meta: some View {
                    if !task.who.isEmpty {
                        Text(task.who.joined(separator: ", ")).lineLimit(1)
                    }
                    if let due = TaskCard.due(task) { Text(due).lineLimit(1) }
                    if let thread {
                        Button { app.openThread(thread.id) } label: {
                            HStack(spacing: zoomed(3)) {
                                if thread.status.isBusy { Circle().fill(Color.accentColor).frame(width: zoomed(5), height: zoomed(5)) }
                                Image(systemName: "bubble.left")
                            }
                            .padding(.horizontal, zoomed(4))
                            .padding(.vertical, zoomed(1))
                            .background(Color.primary.opacity(0.07), in: RoundedRectangle(cornerRadius: zoomed(4)))
                        }
                        .buttonStyle(.plain)
                        .tip("Open the thread working on it: \(thread.title)")
                    }
    }

    /// "29 Nov" or "29 Nov to 4 Dec".
    static func due(_ task: ProjectTask) -> String? {
        func day(_ s: String) -> String? {
            let f = DateFormatter()
            f.locale = Locale(identifier: "en_US_POSIX")
            f.dateFormat = "yyyy-MM-dd"
            guard let d = f.date(from: String(s.prefix(10))) else { return nil }
            return d.formatted(.dateTime.day().month(.abbreviated))
        }
        guard let start = task.due.flatMap(day) else { return nil }
        if let end = task.dueEnd.flatMap(day) { return "\(start) to \(end)" }
        return start
    }
}

/// Its folders: patches load from each of them. A folder shows in Finder;
/// the minus takes it out.
private struct FoldersSection: View {
    @Environment(AppModel.self) private var app
    let project: Project

    var body: some View {
        VStack(alignment: .leading, spacing: zoomed(2)) {
            PageHeading(title: "Folders") {
                Button("Add folder…") { app.addProjectFolder(project.id) }
                    .buttonStyle(.borderless)
                    .tip("Add a folder: the project's threads get the patches in it")
                    .font(.system(size: TypeScale.detail))
            }
            ForEach(project.folders, id: \.self) { folder in
                FolderRow(project: project, folder: folder)
            }
            if project.folders.isEmpty {
                Text("None yet. A thread in the project gets the patches in each of its folders.")
                    .font(.system(size: TypeScale.label))
                    .foregroundStyle(Color(nsColor: Theme.faintText))
            }
        }
    }
}

private struct FolderRow: View {
    @Environment(AppModel.self) private var app
    let project: Project
    let folder: String
    @State private var hovering = false

    var body: some View {
        HStack(spacing: zoomed(8)) {
            Image(systemName: "folder")
                .font(.system(size: zoomed(12)))
                .foregroundStyle(.secondary)
                .frame(width: zoomed(16))
            PlainLink(title: folder.abbreviatingHome, help: "Show in Finder") {
                NSWorkspace.shared.activateFileViewerSelecting([URL(fileURLWithPath: folder)])
            }
            .font(.system(size: TypeScale.label))
            Spacer(minLength: zoomed(8))
            Button { app.removeProjectFolder(project.id, folder) } label: { Image(systemName: "minus.circle") }
                .buttonStyle(RowIconButtonStyle())
                .tip("Take this folder out of the project")
                .opacity(hovering ? 1 : 0)
        }
        .padding(.vertical, zoomed(3))
        .contentShape(Rectangle())
        .onHover { hovering = $0 }
    }
}

/// Its threads, put away ones too, newest first. A row opens its thread.
private struct ThreadsSection: View {
    @Environment(AppModel.self) private var app
    let project: Project
    let threads: [ThreadSummary]

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            PageHeading(title: "Threads", detail: threads.isEmpty ? nil : "\(threads.count)")
            ForEach(threads) { thread in
                ProjectThreadRow(project: project, thread: thread)
            }
            if threads.isEmpty {
                Text("No threads in it yet. The librarian puts threads here as they work in its folders, or add one from a thread's ... menu.")
                    .font(.system(size: TypeScale.label))
                    .foregroundStyle(Color(nsColor: Theme.faintText))
            }
        }
    }
}

private struct ProjectThreadRow: View {
    @Environment(AppModel.self) private var app
    let project: Project
    let thread: ThreadSummary
    @State private var hovering = false

    private var membership: ThreadProject? { thread.projects.first { $0.id == project.id } }

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: zoomed(8)) {
            Text(thread.title.isEmpty ? "Untitled" : thread.title)
                .font(.system(size: TypeScale.label))
                .foregroundStyle(thread.isArchived ? .secondary : .primary)
                .lineLimit(1)
            Text(FolderName.short(thread.cwd))
                .font(.system(size: TypeScale.detail))
                .foregroundStyle(Color(nsColor: Theme.faintText))
                .lineLimit(1)
            Spacer(minLength: zoomed(8))
            Text(meta)
                .font(.system(size: TypeScale.detail))
                .foregroundStyle(Color(nsColor: Theme.faintText))
                .monospacedDigit()
                .lineLimit(1)
        }
        .padding(.horizontal, zoomed(8))
        .padding(.vertical, zoomed(6))
        .background(hovering ? SidebarMetrics.hover : .clear, in: RoundedRectangle(cornerRadius: zoomed(6)))
        .padding(.horizontal, -zoomed(8))
        .contentShape(Rectangle())
        .onTapGesture { app.openThread(thread.id) }
        .onHover { hovering = $0 }
        .tip(by)
        .iconContextMenu {
            Button("Open", systemImage: "arrow.right.circle") { app.openThread(thread.id) }
            if membership?.pinned == false {
                Button("Keep it in \(project.title)", systemImage: "pin") { app.setProjects(thread.id, add: [project.id]) }
            }
            Button("Take it out of \(project.title)", systemImage: "minus.circle") { app.setProjects(thread.id, remove: [project.id]) }
        }
    }

    /// "Archived · 3d", or just when it was last active.
    private var meta: String {
        let when = RelativeTime.short(thread.lastActivityAt, now: app.now)
        if thread.isArchived { return "Archived · " + when }
        if thread.isSnoozed(at: app.now) { return "Hibernating · " + when }
        return when
    }

    /// Who put it here, for the tooltip.
    private var by: String {
        guard let membership else { return "" }
        switch membership.by {
        case .mike: return "You put it here"
        case .agent: return membership.pinned ? "Its agent put it here" : "An agent put it here"
        case .librarian: return membership.pinned ? "The librarian put it here and you kept it" : "The librarian put it here"
        }
    }
}

/// What the project's folders give its threads, as their summaries say,
/// and where each came from. Each patch once, however many threads have it.
private struct PatchesSection: View {
    @Environment(AppModel.self) private var app
    let project: Project
    let threads: [ThreadSummary]

    var body: some View {
        let found = PatchGroups.patches(of: project, in: threads)
        VStack(alignment: .leading, spacing: zoomed(12)) {
            PageHeading(title: "Patches", detail: found.isEmpty ? nil : "\(found.count)")
            ForEach(found, id: \.patch.id) { item in
                VStack(alignment: .leading, spacing: zoomed(3)) {
                    HStack(spacing: zoomed(6)) {
                        Image(systemName: "square.dashed")
                            .font(.system(size: zoomed(11), weight: .medium))
                            .foregroundStyle(.secondary)
                        Text(item.patch.id)
                            .font(.system(size: TypeScale.label, weight: .medium))
                        Text(PatchesList.sourceName(item.patch.source))
                            .font(.system(size: TypeScale.small))
                            .foregroundStyle(Color(nsColor: Theme.faintText))
                    }
                    if let error = item.patch.error {
                        Text(error)
                            .font(.system(size: TypeScale.detail))
                            .foregroundStyle(Color(nsColor: Theme.failed))
                            .textSelection(.enabled)
                    } else {
                        let gives = PatchesList.gives(item.patch.id, in: item.thread)
                        if !gives.isEmpty {
                            Text(gives)
                                .font(.system(size: TypeScale.detail))
                                .foregroundStyle(.secondary)
                        }
                    }
                    if item.patch.file == nil, item.thread.isRemote, let from = item.patch.folder {
                        // Another Mac's folder: nothing here to show it in.
                        Text(from.abbreviatingHome)
                            .font(.system(size: TypeScale.small))
                            .foregroundStyle(Color(nsColor: Theme.faintText))
                    } else if let from = item.patch.file ?? item.patch.folder {
                        PlainLink(title: from.abbreviatingHome, help: item.patch.file == nil ? "Show the folder in Finder" : "Open the file") {
                            if let file = item.patch.file {
                                app.openFile(file, of: item.thread)
                            } else if !item.thread.isRemote {
                                // Another Mac's folder isn't one here to show.
                                NSWorkspace.shared.activateFileViewerSelecting([URL(fileURLWithPath: from)])
                            }
                        }
                        .font(.system(size: TypeScale.small))
                        .foregroundStyle(Color(nsColor: Theme.faintText))
                    }
                }
            }
            if found.isEmpty {
                Text("None from its folders yet. A patch in .threadbear/patches in one of them shows here, and on every thread in the project.")
                    .font(.system(size: TypeScale.label))
                    .foregroundStyle(Color(nsColor: Theme.faintText))
            }
        }
    }
}
