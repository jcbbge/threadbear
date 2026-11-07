import SwiftUI
import ThreadbearCore

/// The keys the palette takes from the composer while it's open; the
/// cursor stays in the box, so typing keeps narrowing the list.
enum PaletteKey {
    case up, down, tab, enter, escape
}

/// What the composer keeps for its palette: which category and command
/// are picked, and the text it was closed at with Esc (it stays closed
/// until the text changes).
struct PaletteState: Equatable {
    var category: SlashPalette.Category = .all
    var selected: String?
    var closedAt: String?
}

/// The palette over the composer while a message starts with "/" (mockup
/// C, picked 6 Nov): categories with counts, the matches, and the picked
/// command in full. Arrows move, Tab fills it in for its arguments,
/// Return runs it, Esc closes it.
struct SlashPaletteView: View {
    let commands: [SlashCommand]?
    let query: String
    let provider: String
    let recent: [String]
    @Binding var state: PaletteState
    /// What a Threadbear command would change, as it is now, by name
    /// ("model": "Fable 5.1").
    var current: [String: String] = [:]
    var onFill: (SlashCommand) -> Void
    var onRun: (SlashCommand) -> Void
    /// Opens a command's file in the side pane; nil when the thread's
    /// runner is another Mac's, whose files aren't here.
    var onOpen: ((String) -> Void)?

    /// The column widths Mike dragged (AppModel.slashPaletteLayout).
    @Binding var layout: SlashPalette.Layout

    var body: some View {
        let all = commands ?? []
        let matches = SlashPalette.matches(all, query: query, category: state.category, recent: recent)
        let picked = matches.first { $0.name == state.selected } ?? matches.first
        // Each column as wide as its longest entry needs, the description
        // the rest (SlashPalette.columnWidths). Measured over every command,
        // not just the matches, so the columns hold still while typing.
        GeometryReader { geo in
            let total = geo.size.width
            let widths = SlashPalette.columnWidths(
                total: total,
                categories: layout.categories ?? Self.categoriesWidth(all, query: query, recent: recent, provider: provider),
                list: layout.list ?? Self.listWidth(all),
                chosen: layout.list != nil
            )
            HStack(spacing: 0) {
                categories(all)
                    .frame(width: widths.categories)
                // The dividers drag to size the column on their left.
                ResizeHandle(edge: .column, tip: "Drag to size the categories; double-click for their own width",
                             start: { widths.categories },
                             drag: { base, moved in layout.categories = SlashPalette.Layout.column(base + moved.width, least: 110, others: widths.list + 200, total: total) },
                             reset: { layout.categories = nil })
                list(matches, picked: picked)
                    .frame(width: widths.list)
                ResizeHandle(edge: .column, tip: "Drag to size the list; double-click for its own width",
                             start: { widths.list },
                             drag: { base, moved in layout.list = SlashPalette.Layout.column(base + moved.width, least: 120, others: widths.categories + 200, total: total) },
                             reset: { layout.list = nil })
                detail(picked)
                    .frame(maxWidth: .infinity, alignment: .topLeading)
            }
        }
        // It fills its panel (SlashPalettePanel), whose own edges size it.
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background {
            RoundedRectangle(cornerRadius: zoomed(14), style: .continuous)
                .fill(Color(nsColor: .windowBackgroundColor))
        }
        .overlay(RoundedRectangle(cornerRadius: zoomed(14), style: .continuous).strokeBorder(Color(nsColor: .separatorColor), lineWidth: 0.5))
        .clipShape(RoundedRectangle(cornerRadius: zoomed(14), style: .continuous))
        // Its edges are a window's, which have no double-click of their own.
        .iconContextMenu {
            Button("Default Size", systemImage: "arrow.down.right.and.arrow.up.left") {
                layout.width = nil
                layout.height = nil
            }
            Button("Default Column Widths", systemImage: "rectangle.split.3x1") {
                layout.categories = nil
                layout.list = nil
            }
        }
    }

    private func categories(_ all: [SlashCommand]) -> some View {
        VStack(alignment: .leading, spacing: zoomed(2)) {
            ForEach(SlashPalette.counts(all, query: query, recent: recent), id: \.0) { category, count in
                let on = state.category == category
                Button {
                    state.category = category
                    state.selected = nil
                } label: {
                    HStack {
                        Text(category.title(provider: provider))
                            .lineLimit(1)
                        Spacer(minLength: zoomed(6))
                        Text("\(count)").monospacedDigit().foregroundStyle(.secondary)
                    }
                    .font(.system(size: TypeScale.label + 1))
                    .foregroundStyle(on ? .primary : .secondary)
                    .padding(.horizontal, zoomed(10))
                    .padding(.vertical, zoomed(6))
                    .background(RoundedRectangle(cornerRadius: zoomed(7)).fill(on ? Color.primary.opacity(0.1) : .clear))
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .tip(Self.categoryTip(category, provider: provider))
            }
            Spacer(minLength: 0)
        }
        .padding(zoomed(8))
    }

    @ViewBuilder
    private func list(_ matches: [SlashCommand], picked: SlashCommand?) -> some View {
        if commands == nil {
            placeholder("Getting this thread's commands…")
        } else if matches.isEmpty {
            placeholder(query.isEmpty ? "Nothing here yet." : "No command matches /\(query). Send it and it goes to the agent as words.")
        } else {
            ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 0) {
                        ForEach(matches) { command in
                            row(command, on: command == picked)
                                .id(command.name)
                        }
                    }
                }
                .onChange(of: picked?.name) { _, name in
                    if let name { proxy.scrollTo(name) }
                }
                // Outside the scroll view, so a row scrolled up stops short
                // of the panel's edge rather than half under it.
                .padding(.vertical, zoomed(6))
            }
        }
    }

    private func row(_ command: SlashCommand, on: Bool) -> some View {
        Text("/\(command.name)")
            .font(.system(size: TypeScale.label + 1))
            .lineLimit(1)
            .truncationMode(.middle)
            .foregroundStyle(on ? Color.white : .primary)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, zoomed(14))
            .padding(.vertical, zoomed(6))
            .background(on ? Color(nsColor: .controlAccentColor).opacity(0.75) : .clear)
            .contentShape(Rectangle())
            // Picked on the first click, at once: a double-tap gesture
            // beside a single one makes SwiftUI hold every click until the
            // double-click time has passed (half a second, Mike, 6 Nov).
            // A second click is read from the click itself instead.
            .onTapGesture {
                if NSApp.currentEvent?.clickCount ?? 1 >= 2, state.selected == command.name { onRun(command) }
                else { state.selected = command.name }
            }
            .tip("/\(command.name): double-click to run it")
    }

    @ViewBuilder
    private func detail(_ command: SlashCommand?) -> some View {
        if let command {
            // The words scroll; the buttons stay at the bottom. A long skill
            // description in a narrow window clipped the usage line before.
            VStack(alignment: .leading, spacing: 0) {
            ScrollView {
            VStack(alignment: .leading, spacing: zoomed(10)) {
                Text("/\(command.name)")
                    .font(.system(size: TypeScale.cardTitle + 3, weight: .semibold))
                if let text = command.description, !text.isEmpty {
                    Text(SlashPalette.description(text))
                        .font(.system(size: TypeScale.label + 1))
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
                Text(command.usage)
                    .font(.system(size: TypeScale.code, design: .monospaced))
                    .fixedSize(horizontal: false, vertical: true)
                    .textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, zoomed(10))
                    .padding(.vertical, zoomed(8))
                    .background(RoundedRectangle(cornerRadius: zoomed(7)).fill(Color.primary.opacity(0.06)))
                if let now = current[command.name] {
                    Text("Now: \(now)")
                        .font(.system(size: TypeScale.label + 1))
                }
                if let aliases = command.aliases, !aliases.isEmpty {
                    Text("Also " + aliases.map { "/\($0)" }.joined(separator: ", "))
                        .font(.system(size: TypeScale.label))
                        .foregroundStyle(.secondary)
                }
                origin(command)
            }
            .padding(zoomed(16))
            .frame(maxWidth: .infinity, alignment: .leading)
            }
                // On one row when they fit, else stacked: squeezed onto one
                // they read "Add d…" and "Open f…".
                ViewThatFits(in: .horizontal) {
                    HStack(spacing: zoomed(8)) { actions(command) }
                    VStack(alignment: .leading, spacing: zoomed(6)) { actions(command) }
                }
                .controlSize(.small)
                .padding(.horizontal, zoomed(16))
                .padding(.vertical, zoomed(12))
            }
        } else {
            Color.clear
        }
    }

    @ViewBuilder
    private func actions(_ command: SlashCommand) -> some View {
        // Return comes through the composer's own keys, so no
        // keyboard shortcut here to fight it.
        Button("Run") { onRun(command) }
            .tip("Send /\(command.name) now (Return)")
        Button("Add details") { onFill(command) }
            .tip("Put /\(command.name) in the box to type more after it (Tab)")
        // With the other buttons, so it's always in sight: under
        // the path it scrolled away in a short palette.
        if let path = command.path, let onOpen {
            Button("Open file") { onOpen(path) }
                .tip("Open \(SlashPalette.shortPath(path)) beside the thread")
        }
    }

    /// Where it comes from, and its file.
    private func origin(_ command: SlashCommand) -> some View {
        VStack(alignment: .leading, spacing: zoomed(3)) {
            Text(SlashPalette.origin(of: command, provider: provider))
                .font(.system(size: TypeScale.label))
                .foregroundStyle(.tertiary)
            if let path = command.path {
                // On lines of its own, wrapped: cut short in the middle it
                // showed only "~/.cl…ILL.md".
                Text(SlashPalette.shortPath(path))
                    .font(.system(size: TypeScale.label - 1, design: .monospaced))
                    .foregroundStyle(.tertiary)
                    .fixedSize(horizontal: false, vertical: true)
                    .textSelection(.enabled)
            }
        }
    }

    private func placeholder(_ text: String) -> some View {
        Text(text)
            .font(.system(size: TypeScale.label + 1))
            .foregroundStyle(.secondary)
            .padding(zoomed(16))
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    }
}

extension SlashPaletteView {
    private static func textWidth(_ text: String) -> Double {
        (text as NSString).size(withAttributes: [.font: NSFont.systemFont(ofSize: TypeScale.label + 1)]).width
    }

    /// The list's: the longest name, its row's padding and the scroller.
    static func listWidth(_ commands: [SlashCommand]) -> Double {
        let longest = commands.map { textWidth("/\($0.name)") }.max() ?? 0
        return longest + zoomed(14) * 2 + zoomed(14)
    }

    /// The categories': the longest title beside its count.
    static func categoriesWidth(_ commands: [SlashCommand], query: String, recent: [String], provider: String) -> Double {
        let longest = SlashPalette.counts(commands, query: "", recent: recent)
            .map { textWidth($0.0.title(provider: provider)) + textWidth("\($0.1)") }.max() ?? 0
        // Row and column padding, and the gap between title and count.
        return longest + zoomed(10) * 2 + zoomed(8) * 2 + zoomed(14)
    }

    static func categoryTip(_ category: SlashPalette.Category, provider: String) -> String {
        switch category {
        case .all: "Every command this thread can run"
        case .threadbear: "Threadbear's own, which change this thread's settings"
        case .cli: "\(SlashPalette.cliName(provider))'s own commands"
        case .skills: "Your skills and this folder's"
        case .recent: "The ones you picked lately"
        }
    }

    /// What a palette key does with these matches: moves the pick, or
    /// gives the command to fill in (Tab) or run (Return). Nil: not taken.
    static func handle(_ key: PaletteKey, matches: [SlashCommand], state: inout PaletteState, text: String) -> (SlashCommand, run: Bool)? {
        let index = matches.firstIndex { $0.name == state.selected } ?? 0
        switch key {
        case .up:
            if !matches.isEmpty { state.selected = matches[max(0, index - 1)].name }
        case .down:
            if !matches.isEmpty { state.selected = matches[min(matches.count - 1, index + 1)].name }
        case .escape:
            state.closedAt = text
        case .tab, .enter:
            guard matches.indices.contains(index) else { return nil }
            return (matches[index], key == .enter)
        }
        return nil
    }
}

extension AppModel {
    /// Asks for a thread's commands when the palette opens. The runner
    /// keeps each folder's list for ten minutes, so asking each time keeps
    /// skills added meanwhile coming in without waiting on a CLI.
    func loadSlashCommands(_ threadId: String) {
        guard slashFetches[threadId] == nil, let client = client(for: threadId) else { return }
        slashFetches[threadId] = Task { [weak self] in
            defer { self?.slashFetches[threadId] = nil }
            do {
                let list = try await client.threadCommands(threadId: threadId)
                if self?.slashCommands[threadId] != list { self?.slashCommands[threadId] = list }
            } catch {
                // An older runner (-32601) or one that couldn't list them:
                // the palette says there are none rather than spinning.
                if self?.slashCommands[threadId] == nil { self?.slashCommands[threadId] = [] }
                AppLog.write("rpc", "threads.commands failed: \(error.localizedDescription)")
            }
        }
    }
}

/// A line between the palette's columns that drags to size the column on
/// its left, with the resize pointer, and a double-click back to the
/// width worked out for it. (The palette's own edges are its panel's.)
struct ResizeHandle: View {
    enum Edge { case column }
    let edge: Edge
    let tip: String
    /// The size when the drag starts.
    let start: () -> Double
    /// The size at the start, and how far the pointer has moved since.
    let drag: (Double, CGSize) -> Void
    let reset: () -> Void
    @State private var base: Double?

    var body: some View {
        // A hairline to see, with a wider strip to grab.
        Rectangle().fill(Color(nsColor: .separatorColor)).frame(width: 1)
            .padding(.horizontal, zoomed(3))
            .contentShape(Rectangle())
            .pointerStyle(.columnResize)
        .gesture(
            DragGesture(minimumDistance: 1, coordinateSpace: .global)
                .onChanged { value in
                    let from = base ?? start()
                    base = from
                    drag(from, value.translation)
                }
                .onEnded { _ in base = nil }
        )
        .onTapGesture(count: 2) { reset() }
        .tip(tip)
    }
}
