import AppKit
import SwiftUI
import ThreadbearCore

/// A project's Notion board in a thread's Highlights: its columns side by
/// side, Complete ones folded to a strip. A click on a card mentions it in
/// the thread's message, so Mike can ask about it without copying anything
/// (Mike asked 3 Nov).
///
/// Too many columns for the panel scroll sideways. macOS hides its scrollers
/// and a mouse wheel only scrolls up and down, so a bar with arrows sits under
/// the board whenever there's more to see, and the columns fade at the edge
/// they carry on past.
struct HighlightsBoard: View {
    @Environment(AppModel.self) private var app
    let tasks: ProjectTasks
    let thread: ThreadSummary

    @State private var position = ScrollPosition(x: 0)
    @State private var scroll = ScrollMetrics()
    @State private var width: CGFloat = 0
    /// Complete columns Mike has unfolded, and columns showing every card.
    @State private var unfolded: Set<String> = []
    @State private var showingAll: Set<String> = []

    private struct ScrollMetrics: Equatable {
        var offset: CGFloat = 0
        var content: CGFloat = 0
        var visible: CGFloat = 0
        var maximum: CGFloat { max(0, content - visible) }
    }

    private var spacing: CGFloat { zoomed(6) }
    private var foldedWidth: CGFloat { zoomed(28) }
    private var minimumWidth: CGFloat { zoomed(146) }
    private var inset: CGFloat { SidebarMetrics.outerInset }

    var body: some View {
        let board = tasks.board(threadId: thread.id)
        if !board.isEmpty {
            let folded = board.filter(isFolded)
            let columnWidth = BoardLayout.columnWidth(
                available: Double(width - inset * 2), columns: board.count - folded.count, folded: folded.count,
                spacing: Double(spacing), foldedWidth: Double(foldedWidth), minimum: Double(minimumWidth))
            VStack(spacing: zoomed(4)) {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(alignment: .top, spacing: spacing) {
                        ForEach(board) { column in
                            if isFolded(column) {
                                FoldedColumn(column: column) { toggleFold(column) }
                            } else {
                                columnView(column, width: columnWidth)
                            }
                        }
                    }
                    .padding(.horizontal, inset)
                }
                .scrollPosition($position)
                .onScrollGeometryChange(for: ScrollMetrics.self) { geometry in
                    ScrollMetrics(offset: geometry.contentOffset.x, content: geometry.contentSize.width, visible: geometry.containerSize.width)
                } action: { _, new in
                    scroll = new
                }
                .mask(edgeFade)
                if scroll.maximum > 1 {
                    BoardScrollBar(offset: scroll.offset, maximum: scroll.maximum, visible: scroll.visible, content: scroll.content) { x, animated in
                        move(to: x, animated: animated)
                    } onPage: { direction in
                        let step = Double(columnWidth + spacing)
                        move(to: BoardLayout.page(from: Double(scroll.offset), by: direction, step: step, maximum: Double(scroll.maximum)), animated: true)
                    }
                    .padding(.horizontal, inset)
                }
            }
            .padding(.top, zoomed(4))
            .onGeometryChange(for: CGFloat.self) { $0.size.width } action: { width = $0 }
        }
    }

    private func isFolded(_ column: ProjectTasks.BoardColumn) -> Bool {
        column.column.kind == .done && !unfolded.contains(column.id)
    }

    private func toggleFold(_ column: ProjectTasks.BoardColumn) {
        if unfolded.contains(column.id) { unfolded.remove(column.id) } else { unfolded.insert(column.id) }
    }

    private func move(to x: Double, animated: Bool) {
        if animated {
            withAnimation(.easeOut(duration: 0.2)) { position.scrollTo(x: x) }
        } else {
            position.scrollTo(x: x)
        }
    }

    /// Fades the edge the board carries on past, so the cut-off column reads
    /// as more to come rather than a clipped one.
    private var edgeFade: some View {
        let fade = zoomed(22)
        return HStack(spacing: 0) {
            LinearGradient(colors: [scroll.offset > 1 ? .clear : .black, .black], startPoint: .leading, endPoint: .trailing)
                .frame(width: fade)
            Color.black
            LinearGradient(colors: [.black, scroll.offset < scroll.maximum - 1 ? .clear : .black], startPoint: .leading, endPoint: .trailing)
                .frame(width: fade)
        }
    }

    private func columnView(_ column: ProjectTasks.BoardColumn, width: CGFloat) -> some View {
        let limit = HighlightSections.taskLimit
        let all = showingAll.contains(column.id)
        let cards = all ? column.cards : Array(column.cards.prefix(limit))
        return VStack(alignment: .leading, spacing: zoomed(5)) {
            columnHeader(column)
            ForEach(cards) { pick in
                BoardCard(pick: pick, thread: thread)
            }
            if column.cards.count > limit {
                PlainLink(title: all ? "Show fewer" : "\(column.cards.count - limit) more", help: all ? "Show the first \(limit) cards" : "Show every card in \(column.column.name)") {
                    if all { showingAll.remove(column.id) } else { showingAll.insert(column.id) }
                }
                .font(.system(size: TypeScale.small))
                .foregroundStyle(Color(nsColor: Theme.faintText))
                .padding(.horizontal, zoomed(4))
            }
        }
        .padding(zoomed(6))
        .frame(width: width, alignment: .topLeading)
        .background(Color(nsColor: Theme.cardBackground), in: RoundedRectangle(cornerRadius: zoomed(8)))
    }

    @ViewBuilder
    private func columnHeader(_ column: ProjectTasks.BoardColumn) -> some View {
        let header = HStack(spacing: zoomed(5)) {
            Circle().fill(TaskColors.color(column.column.color)).frame(width: zoomed(6), height: zoomed(6))
            Text(column.column.name)
                .font(.system(size: TypeScale.small, weight: .semibold))
                .foregroundStyle(.secondary)
                .lineLimit(1)
            Spacer(minLength: 0)
            Text("\(column.cards.count)")
                .font(.system(size: TypeScale.small))
                .foregroundStyle(Color(nsColor: Theme.faintText))
                .monospacedDigit()
        }
        .padding(.horizontal, zoomed(3))
        .contentShape(Rectangle())
        if column.column.kind == .done {
            Button { toggleFold(column) } label: { header }
                .buttonStyle(.plain)
                .tip("Fold \(column.column.name)")
        } else {
            header
        }
    }
}

/// A Complete column folded out of the way: its name running down a strip,
/// and its count. A click opens it.
private struct FoldedColumn: View {
    let column: ProjectTasks.BoardColumn
    let action: () -> Void
    @State private var hovering = false

    var body: some View {
        // Buttons here and on the cards, not tap gestures: a gesture ignores
        // the click that brings a background window forward, and Mike often
        // has another app in front while a thread runs.
        Button(action: action) {
            VStack(spacing: zoomed(6)) {
                Circle().fill(TaskColors.color(column.column.color)).frame(width: zoomed(6), height: zoomed(6))
                Sideways {
                    Text(column.column.name)
                        .font(.system(size: TypeScale.small, weight: .semibold))
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                        .fixedSize()
                        .rotationEffect(.degrees(90))
                }
                Text("\(column.cards.count)")
                    .font(.system(size: TypeScale.small))
                    .foregroundStyle(Color(nsColor: Theme.faintText))
                    .monospacedDigit()
            }
            .padding(.vertical, zoomed(8))
            .frame(width: zoomed(28))
            .background(hovering ? Color(nsColor: Theme.hoverFill) : Color(nsColor: Theme.cardBackground), in: RoundedRectangle(cornerRadius: zoomed(8)))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .onHover { hovering = $0 }
        .tip("Show \(column.cards.count) in \(column.column.name)")
    }
}

/// Lays out a view turned a quarter by its turned size, which
/// `rotationEffect` alone leaves as it was.
private struct Sideways: Layout {
    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        guard let size = subviews.first?.sizeThatFits(.unspecified) else { return .zero }
        return CGSize(width: size.height, height: size.width)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        subviews.first?.place(at: CGPoint(x: bounds.midX, y: bounds.midY), anchor: .center, proposal: .unspecified)
    }
}

/// A card on the board. A click mentions it in the thread's message; the
/// arrow on hover, or the right-click menu, opens it in Notion. The project
/// page's cards still open in Notion on a click, as no message box is there.
private struct BoardCard: View {
    @Environment(AppModel.self) private var app
    let pick: ProjectTasks.Pick
    let thread: ThreadSummary
    @State private var hovering = false

    private var task: ProjectTask { pick.task }
    private var done: Bool { pick.column.kind == .done }

    /// Another thread working on this card.
    private var other: ThreadSummary? {
        guard !pick.mine, let id = task.thread?.lowercased(), id.count >= 6 else { return nil }
        return app.threads[id] ?? app.threads.values.first { $0.id.hasPrefix(id) }
    }

    var body: some View {
        Button { app.mentionInComposer(task, in: thread.id) } label: {
            VStack(alignment: .leading, spacing: zoomed(3)) {
                Text(task.title)
                    .font(.system(size: TypeScale.small))
                    .foregroundStyle(done ? .secondary : .primary)
                    .lineLimit(2)
                    .multilineTextAlignment(.leading)
                    .fixedSize(horizontal: false, vertical: true)
                    .frame(maxWidth: .infinity, alignment: .leading)
                meta
            }
            .padding(.horizontal, zoomed(8))
            .padding(.vertical, zoomed(6))
            .background(hovering ? Color(nsColor: Theme.hoverFill) : Color(nsColor: Theme.codeBackground), in: RoundedRectangle(cornerRadius: zoomed(6)))
            .overlay(RoundedRectangle(cornerRadius: zoomed(6)).strokeBorder(Color(nsColor: Theme.cardBorder), lineWidth: 0.5))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        // Over the card's button rather than inside it, as a button in a
        // button's label doesn't get its own clicks.
        .overlay(alignment: .topTrailing) {
            if hovering { openButton.padding(zoomed(3)) }
        }
        .overlay(alignment: .bottomTrailing) {
            if let other { otherThreadButton(other).padding(.horizontal, zoomed(8)).padding(.vertical, zoomed(6)) }
        }
        .onHover { hovering = $0 }
        .tip("Mention this card in your message")
        .iconContextMenu {
            Button("Mention in Message", systemImage: "text.bubble") { app.mentionInComposer(task, in: thread.id) }
            Button("Open in Notion", systemImage: "arrow.up.forward.square") { openInNotion() }
            if let other {
                Button("Open the Thread Working on It", systemImage: "bubble.left") { app.openThread(other.id) }
            }
            Button("Copy Link", systemImage: "link") { app.copyToPasteboard(task.url) }
        }
    }

    private func openInNotion() {
        if let url = URL(string: task.url) { OpenGate.openWeb(url) }
    }

    private var openButton: some View {
        Button(action: openInNotion) {
            Image(systemName: "arrow.up.forward.square")
                .font(.system(size: TypeScale.small))
                .foregroundStyle(.secondary)
                .padding(zoomed(2))
                .background(Color(nsColor: Theme.hoverFill), in: RoundedRectangle(cornerRadius: zoomed(4)))
        }
        .buttonStyle(.plain)
        .tip("Open in Notion")
    }

    /// Who and when. A filled bubble says the card is this thread's; another
    /// thread's gets a button over this spot, so room is kept for it.
    private var meta: some View {
        HStack(spacing: zoomed(5)) {
            if !task.who.isEmpty {
                Text(task.who.joined(separator: ", ")).lineLimit(1)
            }
            if let due = TaskCard.due(task) { Text(due).lineLimit(1) }
            Spacer(minLength: 0)
            if pick.mine {
                Image(systemName: "bubble.left.fill").foregroundStyle(.secondary)
            } else if other != nil {
                Image(systemName: "bubble.left").hidden()
            }
        }
        .font(.system(size: zoomed(10.5)))
        .foregroundStyle(Color(nsColor: Theme.faintText))
    }

    private func otherThreadButton(_ other: ThreadSummary) -> some View {
        Button { app.openThread(other.id) } label: {
            HStack(spacing: zoomed(3)) {
                if other.status.isBusy { Circle().fill(Color.accentColor).frame(width: zoomed(5), height: zoomed(5)) }
                Image(systemName: "bubble.left")
            }
            .font(.system(size: zoomed(10.5)))
            .foregroundStyle(Color(nsColor: Theme.faintText))
        }
        .buttonStyle(.plain)
        .tip("Open the thread working on it: \(other.title)")
    }
}

/// The bar under a board that scrolls sideways: arrows a column at a time,
/// and a track to drag or click.
private struct BoardScrollBar: View {
    let offset: CGFloat
    let maximum: CGFloat
    let visible: CGFloat
    let content: CGFloat
    let onSeek: (Double, Bool) -> Void
    let onPage: (Int) -> Void
    @State private var hovering = false
    /// Where in the thumb the drag took hold, so it doesn't jump under the
    /// pointer.
    @State private var grab: CGFloat?

    var body: some View {
        HStack(spacing: zoomed(4)) {
            arrow("chevron.left", tip: "Scroll the board left", enabled: offset > 1) { onPage(-1) }
            GeometryReader { geometry in
                let track = geometry.size.width
                let thumb = max(zoomed(24), track * min(1, visible / max(content, 1)))
                let room = max(1, track - thumb)
                let x = room * min(1, max(0, offset / max(maximum, 1)))
                ZStack(alignment: .leading) {
                    Capsule().fill(Color.primary.opacity(0.08))
                    Capsule().fill(Color.primary.opacity(hovering || grab != nil ? 0.5 : 0.32))
                        .frame(width: thumb)
                        .offset(x: x)
                }
                .frame(height: zoomed(5))
                .frame(maxHeight: .infinity)
                .overlay {
                    TrackInput { point, phase in
                        switch phase {
                        case .ended:
                            grab = nil
                        case .began, .changed:
                            // A press on the thumb holds it where it was
                            // grabbed; one on the track brings its middle there.
                            let hold = grab ?? ((point >= x && point <= x + thumb) ? point - x : thumb / 2)
                            grab = hold
                            onSeek(Double(min(1, max(0, (point - hold) / room)) * maximum), false)
                        }
                    }
                }
            }
            .frame(height: zoomed(18))
            .onHover { hovering = $0 }
            .tip("Drag to scroll the board")
            arrow("chevron.right", tip: "Scroll the board right", enabled: offset < maximum - 1) { onPage(1) }
        }
    }

    private func arrow(_ symbol: String, tip: String, enabled: Bool, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Image(systemName: symbol)
                .font(.system(size: TypeScale.small, weight: .semibold))
                .frame(width: zoomed(18), height: zoomed(18))
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .foregroundStyle(enabled ? Color.secondary : Color(nsColor: Theme.faintText).opacity(0.5))
        .disabled(!enabled)
        .tip(tip)
    }
}

/// Presses and drags on the scroll bar's track, in an AppKit view so that,
/// like the buttons on the board, it takes the click that brings a background
/// window forward, and a drag carries on past the track's ends.
private struct TrackInput: NSViewRepresentable {
    enum Phase { case began, changed, ended }
    let onEvent: (CGFloat, Phase) -> Void

    final class Input: NSView {
        var onEvent: ((CGFloat, Phase) -> Void)?
        override var isFlipped: Bool { true }
        override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
        // A press here is the bar's, never a drag of the window.
        override var mouseDownCanMoveWindow: Bool { false }
        private func x(_ event: NSEvent) -> CGFloat { convert(event.locationInWindow, from: nil).x }
        override func mouseDown(with event: NSEvent) { onEvent?(x(event), .began) }
        override func mouseDragged(with event: NSEvent) { onEvent?(x(event), .changed) }
        override func mouseUp(with event: NSEvent) { onEvent?(x(event), .ended) }
    }

    func makeNSView(context: Context) -> Input {
        let view = Input()
        view.onEvent = onEvent
        return view
    }

    func updateNSView(_ view: Input, context: Context) {
        view.onEvent = onEvent
    }
}
