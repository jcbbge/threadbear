import SwiftUI
import ThreadbearCore

/// Settings > Runners: the machines Threadbear runs threads on, and which
/// one new threads start on. Deliberately thin: a runner is set up on its
/// own machine (its runner.json, INSTALL.md section 6 for a Linux server),
/// so naming, adding or pairing one is a job for an agent, which the ⓘ
/// says. The controls are the default, which is this Mac's own choice, and
/// the runners' order, which is everyone's: it's the one the phone sets,
/// and its new threads start on the first one online in it (backend API 58).
struct RunnersSettings: View {
    @Environment(AppModel.self) private var app

    var body: some View {
        Form {
            SettingsSection("Default runner",
                            about: "Where a new thread runs unless you pick another machine on the composer. This is this Mac's own choice.",
                            ask: "change it, or to set up another machine to run threads on.") {
                LabeledContent("New threads start on") {
                    Picker("New threads start on", selection: defaultBinding) {
                        Label("This Mac", systemImage: app.selfRunnerIcon).tag(String?.none)
                        ForEach(app.remoteRunners) { runner in
                            Label(runner.name, systemImage: RunnerIcon.symbol(runner.icon)).tag(String?.some(runner.id))
                        }
                    }
                    .labelsHidden()
                    .fixedSize()
                    .tip("Where a new thread runs unless you pick another machine on the composer")
                }
            }

            SettingsSection("Runners",
                            about: canOrder
                                ? "The machines your threads can run on, in your order. New threads from your phone start on the first one that's online. Drag a runner to change the order. Each runner is set up on its own machine."
                                : "The machines your threads can run on. Each runner is set up on its own machine.",
                            ask: "add one, rename one, pair it with this Mac or change how it runs. It knows how, and a Linux server's steps are in INSTALL.md.") {
                if canOrder {
                    RunnerOrderList(ids: app.orderedRunnerIds, preview: app.runnerDragPreview, commit: app.setRunnerOrder) { id in
                        row(for: id, movable: true)
                            .accessibilityAction(named: "Move up") { app.moveRunner(id, by: -1) }
                            .accessibilityAction(named: "Move down") { app.moveRunner(id, by: 1) }
                    }
                } else {
                    RunnerRow(icon: app.selfRunnerIcon, name: selfName, status: "This Mac", isDefault: app.defaultRunnerId == nil)
                    ForEach(app.remoteRunners) { runner in
                        RunnerRow(icon: RunnerIcon.symbol(runner.icon), name: runner.name, status: status(runner), isDefault: app.defaultRunnerId == runner.id)
                    }
                }
            }

            SettingsSection("Other machines' threads",
                            about: "Threads on other machines open through this Mac's runner and Convex, with no network link between the machines. Tool output stays on the machine that ran it for now. Connecting directly reaches the other machine over Tailscale instead, and needs it paired with this Mac.",
                            ask: "explain how other machines' threads reach this Mac, or pair one for a direct connection.") {
                @Bindable var app = app
                Toggle("Connect to other machines directly", isOn: $app.directRemoteLink)
                    .tip("Open other machines' threads over Tailscale instead of through Convex")
            }
        }
        .formStyle(.grouped)
        .fixedSize(horizontal: false, vertical: true)
        .scrollIndicators(.never)
        .scrollDisabled(true)
    }

    private var defaultBinding: Binding<String?> {
        Binding(get: { app.defaultRunnerId }, set: { app.setDefaultRunner($0) })
    }

    /// The order is in once this Mac's runner and its backend have it (API 58).
    /// Not before this Mac's own id is known (runners.list): a move then
    /// would save an order without it and push it down the phone's list.
    private var canOrder: Bool { app.runnerOrder != nil && !app.remoteRunners.isEmpty && app.runners.contains(where: \.isSelf) }

    @ViewBuilder private func row(for id: String, movable: Bool) -> some View {
        if let runner = app.remoteRunners.first(where: { $0.id == id }) {
            RunnerRow(icon: RunnerIcon.symbol(runner.icon), name: runner.name, status: status(runner), isDefault: app.defaultRunnerId == runner.id, movable: movable)
        } else {
            RunnerRow(icon: app.selfRunnerIcon, name: selfName, status: "This Mac", isDefault: app.defaultRunnerId == nil, movable: movable)
        }
    }

    /// This runner's own name, as other machines see it ("M5").
    private var selfName: String { app.runners.first(where: \.isSelf)?.name ?? "This Mac" }

    private func status(_ runner: RemoteRunner) -> String {
        if app.directRemoteLink, runner.tokenFile == nil { return "Not paired with this Mac" }
        return runner.online ? "Online" : "Offline"
    }
}

/// The runners in Mike's order, dragged by anywhere on the row. System drag
/// and drop only offers a thumbnail and a drop target, and Mike wanted the
/// list to rearrange as you drag (7 Nov): the row lifts and floats under the
/// pointer, a dashed slot shows where it'll land, and the others slide round
/// the slot. So the rows are placed by hand, in one row of the Form.
private struct RunnerOrderList<Row: View>: View {
    let ids: [String]
    var preview: CGSize?
    let commit: ([String]) -> Void
    @ViewBuilder let row: (String) -> Row

    /// A Form row's height on the Mac, so these match the sections around them.
    private static var rowHeight: CGFloat { 38 }
    private static var space: String { "runnerOrder" }

    private struct Active {
        let id: String
        let ids: [String]
        let drag: ReorderDrag
        var translation: CGSize = .zero
        var slot: Int
    }

    @State private var active: Active?
    /// Goes false by itself when a gesture ends in any way, which is the
    /// only word SwiftUI gives of one being cancelled.
    @GestureState private var gestureLive = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    private var slide: Animation? { reduceMotion ? nil : .spring(response: 0.26, dampingFraction: 0.82) }

    var body: some View {
        let shown = active?.ids ?? ids
        ZStack(alignment: .topLeading) {
            if let active {
                // Where it'll land.
                RoundedRectangle(cornerRadius: 7, style: .continuous)
                    .strokeBorder(.tertiary, style: StrokeStyle(lineWidth: 1.5, dash: [5, 4]))
                    .frame(height: Self.rowHeight - 6)
                    .padding(.horizontal, -3)
                    .offset(y: CGFloat(active.slot) * Self.rowHeight + 3)
                    .animation(slide, value: active.slot)
            }
            ForEach(Array(shown.enumerated()), id: \.element) { index, id in
                rowView(id, index: index, count: shown.count)
            }
        }
        .frame(height: Self.rowHeight * CGFloat(shown.count), alignment: .top)
        .coordinateSpace(name: Self.space)
        .onChange(of: gestureLive) { _, live in
            // A drop clears `active` in onEnded, which can come just after
            // this: only a drag still going a moment later was cancelled.
            guard !live else { return }
            DispatchQueue.main.async { cancel() }
        }
        .onChange(of: ids) { _, next in
            // A runner came or went mid-drag: the slots no longer mean what
            // they did. Only the order changing (from the phone) is fine:
            // the drop decides it.
            if let active, Set(active.ids) != Set(next) { cancel() }
        }
        .onAppear {
            guard let preview, let first = ids.first else { return }
            let drag = ReorderDrag(from: 0, count: ids.count, rowHeight: Self.rowHeight)
            active = Active(id: first, ids: ids, drag: drag, translation: preview, slot: drag.slot(translationY: preview.height))
        }
    }

    @ViewBuilder private func rowView(_ id: String, index: Int, count: Int) -> some View {
        let dragged = active?.id == id
        let translation = dragged ? active?.translation ?? .zero : .zero
        row(id)
            .frame(maxWidth: .infinity, minHeight: Self.rowHeight, maxHeight: Self.rowHeight)
            .background {
                if dragged {
                    // Solid, as the rows slide underneath it, and lighter
                    // than the group so it reads as lifted.
                    RoundedRectangle(cornerRadius: 8, style: .continuous)
                        .fill(Color(nsColor: .windowBackgroundColor))
                        .overlay {
                            RoundedRectangle(cornerRadius: 8, style: .continuous).fill(.primary.opacity(0.1))
                        }
                        .overlay {
                            RoundedRectangle(cornerRadius: 8, style: .continuous).strokeBorder(.separator)
                        }
                        .shadow(color: .black.opacity(0.4), radius: 10, y: 5)
                        .padding(.horizontal, -5)
                }
            }
            .overlay(alignment: .bottom) {
                // The row's divider: a lifted row has none, and the last has none.
                if active == nil, index < count - 1 {
                    Divider()
                }
            }
            .contentShape(Rectangle())
            .pointerStyle(dragged ? .grabActive : .grabIdle)
            .rotationEffect(.degrees(dragged && !reduceMotion ? tilt(translation.width) : 0))
            .offset(x: dragged ? drift(translation.width) : 0, y: y(of: index, id: id, translation: translation))
            // A lifted row follows the pointer exactly; the rest slide.
            .animation(dragged ? nil : slide, value: y(of: index, id: id, translation: translation))
            .zIndex(dragged ? 1 : 0)
            .gesture(
                DragGesture(minimumDistance: 2, coordinateSpace: .named(Self.space))
                    .updating($gestureLive) { _, live, _ in live = true }
                    .onChanged { moved(id, index: index, translation: $0.translation) }
                    .onEnded { _ in drop() }
            )
    }

    private func y(of index: Int, id: String, translation: CGSize) -> CGFloat {
        guard let active else { return CGFloat(index) * Self.rowHeight }
        if active.id == id { return active.drag.draggedY(translationY: translation.height) }
        return active.drag.restingY(ofRow: index, slot: active.slot)
    }

    /// Loose sideways, but only a little: the Form cuts off what leaves its
    /// row, about 10 points each side, and the fill takes 5 of those.
    private func drift(_ width: CGFloat) -> CGFloat { min(max(-4, width * 0.25), 4) }
    private func tilt(_ width: CGFloat) -> Double { min(max(-1, Double(width) / 40), 1) }

    private func moved(_ id: String, index: Int, translation: CGSize) {
        var next = active ?? Active(id: id, ids: ids, drag: ReorderDrag(from: index, count: ids.count, rowHeight: Self.rowHeight), slot: index)
        guard next.id == id else { return }
        next.translation = translation
        next.slot = next.drag.slot(translationY: translation.height)
        active = next
    }

    private func drop() {
        guard let done = active else { return }
        withAnimation(slide) {
            active = nil
            if done.slot != done.drag.from { commit(ReorderDrag.moving(done.ids, from: done.drag.from, to: done.slot)) }
        }
    }

    /// Everything goes back where it was, and the order stays as it is.
    private func cancel() {
        guard active != nil else { return }
        withAnimation(slide) { active = nil }
    }
}

/// A runner: its icon, name and how it is, with a star on the default, and
/// in the ordered list a drag handle on the left, as on the phone.
private struct RunnerRow: View {
    let icon: String
    let name: String
    let status: String
    let isDefault: Bool
    var movable = false

    var body: some View {
        HStack(spacing: 8) {
            if movable {
                Image(systemName: "line.3.horizontal")
                    .foregroundStyle(.tertiary)
                    .tip("Drag to change the order")
                    .accessibilityHidden(true)
            }
            Image(systemName: icon)
                .foregroundStyle(.secondary)
                .frame(width: 20)
                .accessibilityHidden(true)
            Text(name)
            if isDefault {
                Image(systemName: "star.fill")
                    .font(.system(size: 9))
                    .foregroundStyle(.tertiary)
                    .tip("New threads start here")
                    .accessibilityLabel("Default")
            }
            Spacer(minLength: 8)
            Text(status)
                .foregroundStyle(.secondary)
        }
    }
}
