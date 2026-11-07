import AppKit
import SwiftUI
import ThreadbearCore

/// The activity bar's Runners icon: the machines threads run on (Mike, 5
/// Nov: the website's runner view, on the Mac). Only with more than one
/// runner, as a panel of just this Mac says nothing the app doesn't. The
/// grey dot while one's offline or updating: worth a look, but not Mike's
/// to fix from here.
struct RunnersActivityButton: View {
    @Environment(AppModel.self) private var app

    var body: some View {
        let runners = app.runners
        ActivityButton(symbol: WindowDock.runnersSymbol, title: "Runners",
                       tip: RunnersText.tooltip(runners),
                       quietDot: runners.contains { RunnersText.state($0) != .online },
                       active: app.runnersShown) {
            app.runnersShown.toggle()
        }
    }
}

/// Each runner: whether it's up and for how long, the build it's on, and
/// the threads running there, which open on a click. A panel in the dock
/// beside Usage and Connectors. `runners.list` is only asked at hello and
/// by the schedule editor otherwise, so this asks again while it's open.
struct RunnersPanel: View {
    @Environment(AppModel.self) private var app
    @State private var aboutShown = false
    /// The runners whose details are open, kept across launches.
    @AppStorage("runnersPanelOpen") private var openIds = ""
    /// Some Threadbear window can be seen: not hidden, minimised, covered,
    /// or the screen locked or asleep.
    @State private var onScreen = NSApp.occlusionState.contains(.visible)

    var body: some View {
        let runners = app.runners
        let open = Set(openIds.split(separator: ",").map(String.init))
        let running = app.sections.running
        ScrollView {
            VStack(alignment: .leading, spacing: zoomed(14)) {
                HStack(alignment: .firstTextBaseline, spacing: zoomed(6)) {
                    Text(summary(runners))
                        .font(.system(size: zoomed(11), weight: .medium))
                        .foregroundStyle(.tertiary)
                    Spacer(minLength: 0)
                    Button { app.refreshRunners() } label: {
                        Image(systemName: "arrow.clockwise").font(.system(size: zoomed(11)))
                    }
                    .buttonStyle(.borderless)
                    .busy(app.isBusy(BusyKey.refreshRunners))
                    .foregroundStyle(.secondary)
                    .tip("Check the runners again now")
                    Button { aboutShown.toggle() } label: {
                        Image(systemName: "info.circle").font(.system(size: zoomed(11)))
                    }
                    .buttonStyle(.borderless)
                    .foregroundStyle(.secondary)
                    .tip("What this panel shows")
                    .popover(isPresented: $aboutShown, arrowEdge: .bottom) { RunnersAbout() }
                }
                ForEach(runners) { runner in
                    RunnerCard(runner: runner, running: RunnersText.running(on: runner, in: running),
                               open: open.contains(runner.id)) {
                        var next = open
                        if next.contains(runner.id) { next.remove(runner.id) } else { next.insert(runner.id) }
                        openIds = next.sorted().joined(separator: ",")
                    }
                }
            }
            .padding(zoomed(16))
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        // Who's online goes stale in a few minutes; the runner's own
        // list is only as fresh as the backend's heartbeats (a minute).
        .task {
            while !Task.isCancelled {
                app.loadRunners()
                try? await Task.sleep(for: .seconds(30))
            }
        }
        // The figures, only while some runner's details are open and
        // Threadbear can be seen: asking has every runner report every
        // 10 s, a write each in the backend, and the panel stays docked
        // all day (the Convex I/O work, 5 Nov).
        .onReceive(NotificationCenter.default.publisher(for: NSApplication.didChangeOcclusionStateNotification)) { _ in
            onScreen = NSApp.occlusionState.contains(.visible)
        }
        .task(id: !open.isEmpty && onScreen) {
            guard !open.isEmpty, onScreen else { return }
            while !Task.isCancelled {
                app.loadRunnerStats()
                try? await Task.sleep(for: .seconds(10))
            }
        }
    }

    private func summary(_ runners: [RunnerInfo]) -> String {
        let up = runners.filter { RunnersText.state($0) != .offline }.count
        return up == runners.count ? "All online" : "\(up) of \(runners.count) online"
    }
}

private struct RunnerCard: View {
    @Environment(AppModel.self) private var app
    let runner: RunnerInfo
    let running: [ThreadSummary]
    /// Its details (CPU, memory, disk) are showing.
    let open: Bool
    let toggle: () -> Void
    @State private var hovered = false
    /// Past this many the rest are a count: the panel is a glance, and
    /// the sidebar's Running section has them all.
    private static let shownThreads = 6

    var body: some View {
        let state = RunnersText.state(runner)
        HStack(alignment: .top, spacing: zoomed(10)) {
            Image(systemName: RunnerIcon.symbol(runner.icon))
                .font(.system(size: zoomed(15)))
                .foregroundStyle(state == .offline ? .tertiary : .secondary)
                .frame(width: zoomed(22))
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: zoomed(3)) {
                // The name and state open the details (Mike, 5 Nov: "click
                // on them to get more info about that specific runner").
                Button(action: toggle) { header(state) }
                    .buttonStyle(.plain)
                    .onHover { hovered = $0 }
                    .tip(open ? "Hide \(runner.name)'s details" : "Show \(runner.name)'s CPU, memory and disk")
                    .accessibilityAddTraits(open ? [.isSelected] : [])
                if open {
                    RunnerDetails(runner: runner)
                        .padding(.top, zoomed(5))
                        .padding(.bottom, zoomed(2))
                        .transition(.opacity)
                }
                if !paired {
                    Text("Not paired with this Mac")
                        .font(.system(size: zoomed(11)))
                        .foregroundStyle(.tertiary)
                        .fixedSize(horizontal: false, vertical: true)
                }
                if !running.isEmpty {
                    VStack(alignment: .leading, spacing: zoomed(1)) {
                        ForEach(running.prefix(Self.shownThreads), id: \.id) { thread in
                            RunningThreadRow(thread: thread)
                        }
                        if running.count > Self.shownThreads {
                            Text("and \(running.count - Self.shownThreads) more")
                                .font(.system(size: zoomed(11)))
                                .foregroundStyle(.tertiary)
                                .padding(.leading, zoomed(21))
                                .padding(.top, zoomed(2))
                        }
                    }
                    .padding(.top, zoomed(3))
                }
            }
        }
        .animation(Juice.reduceMotion ? nil : .easeOut(duration: 0.15), value: open)
        .accessibilityElement(children: .contain)
    }

    /// The name, star, build and a chevron, then the state.
    private func header(_ state: RunnersText.State) -> some View {
        VStack(alignment: .leading, spacing: zoomed(3)) {
            HStack(alignment: .firstTextBaseline, spacing: zoomed(5)) {
                Text(runner.name)
                    .font(.system(size: zoomed(12), weight: .medium))
                    .lineLimit(1)
                if isDefault {
                    Image(systemName: "star.fill")
                        .font(.system(size: zoomed(8)))
                        .foregroundStyle(.tertiary)
                        .accessibilityLabel("Default")
                }
                Spacer(minLength: zoomed(6))
                if let build = RunnersText.build(runner) {
                    Text(build)
                        .font(.system(size: zoomed(10), design: .monospaced))
                        .foregroundStyle(.tertiary)
                        .lineLimit(1)
                }
                Image(systemName: "chevron.right")
                    .font(.system(size: zoomed(9), weight: .semibold))
                    .foregroundStyle(hovered ? .secondary : .tertiary)
                    .rotationEffect(.degrees(open ? 90 : 0))
                    .accessibilityHidden(true)
            }
            HStack(alignment: .firstTextBaseline, spacing: zoomed(5)) {
                Circle()
                    .fill(dotColor(state))
                    .frame(width: zoomed(6), height: zoomed(6))
                    .alignmentGuide(.firstTextBaseline) { $0[.bottom] - zoomed(1) }
                    .accessibilityHidden(true)
                Text(RunnersText.stateLine(runner, now: app.now))
                    .font(.system(size: zoomed(11)))
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                // No count of its running threads here: they're listed
                // just below (one mark, one meaning).
                Spacer(minLength: 0)
            }
        }
        .contentShape(Rectangle())
    }

    private var isDefault: Bool {
        runner.isSelf ? app.defaultRunnerId == nil : app.defaultRunnerId == runner.id
    }

    /// Its threads open from here: through Convex, or with the direct link
    /// on, once this Mac has the runner's token.
    private var paired: Bool {
        runner.isSelf || !app.directRemoteLink || app.remoteRunners.first { $0.id == runner.id }?.tokenFile != nil
    }

    private func dotColor(_ state: RunnersText.State) -> Color {
        switch state {
        case .online: return .green.opacity(0.85)
        case .updating: return .orange
        case .offline: return Color.secondary.opacity(0.35)
        }
    }
}

/// A runner's CPU, memory and disk as bars, then what the machine is and
/// how long it's been up. Orange only past the runner's own warning lines
/// (90% memory, under 10 GB of disk; 90% CPU too).
private struct RunnerDetails: View {
    @Environment(AppModel.self) private var app
    let runner: RunnerInfo

    var body: some View {
        if let s = app.runnerStats[runner.id] {
            VStack(alignment: .leading, spacing: zoomed(5)) {
                ForEach(RunnersText.gauges(s), id: \.title) { gauge in
                    GaugeRow(gauge: gauge)
                }
                VStack(alignment: .leading, spacing: zoomed(1)) {
                    ForEach(RunnersText.machineLines(s) + [RunnersText.staleLine(s, now: app.now)].compactMap { $0 }, id: \.self) { line in
                        Text(line)
                    }
                }
                .font(.system(size: zoomed(10.5)))
                .foregroundStyle(.tertiary)
                .lineLimit(2)
                .padding(.top, zoomed(2))
            }
        } else {
            Text(emptyLine)
                .font(.system(size: zoomed(11)))
                .foregroundStyle(.tertiary)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    private var emptyLine: String {
        if RunnersText.state(runner) == .offline { return "Offline, so it isn't sending figures." }
        return app.runnerStatsAsked ? "Waiting for its figures. An older runner doesn't send them." : "Asking for its figures…"
    }
}

private struct GaugeRow: View {
    let gauge: RunnersText.Gauge

    var body: some View {
        HStack(spacing: zoomed(8)) {
            Text(gauge.title)
                .font(.system(size: zoomed(11)))
                .foregroundStyle(.secondary)
                .frame(width: zoomed(48), alignment: .leading)
            GeometryReader { geo in
                ZStack(alignment: .leading) {
                    Capsule().fill(Color.primary.opacity(0.08))
                    Capsule()
                        .fill(gauge.high ? AnyShapeStyle(Color.orange) : AnyShapeStyle(Color.secondary.opacity(0.6)))
                        .frame(width: max(zoomed(3), geo.size.width * gauge.fraction))
                }
            }
            .frame(height: zoomed(5))
            .animation(.easeOut(duration: 0.3), value: gauge.fraction)
            Text(gauge.text)
                .font(.system(size: zoomed(11)))
                .monospacedDigit()
                .foregroundStyle(gauge.high ? .primary : .secondary)
                .lineLimit(1)
                .frame(minWidth: zoomed(84), alignment: .trailing)
        }
        .accessibilityElement(children: .combine)
    }
}

/// One of a runner's running threads: a spinner and its title, opening
/// it on a click.
private struct RunningThreadRow: View {
    @Environment(AppModel.self) private var app
    let thread: ThreadSummary
    @State private var hovered = false

    var body: some View {
        Button { app.openThread(thread.id) } label: {
            HStack(spacing: zoomed(7)) {
                SpinnerMark(color: .secondaryLabelColor)
                    .frame(width: zoomed(11), height: zoomed(11))
                Text(thread.title.isEmpty ? "Untitled" : thread.title)
                    .font(.system(size: zoomed(11)))
                    .foregroundStyle(hovered ? .primary : .secondary)
                    .lineLimit(1)
                    .truncationMode(.tail)
                Spacer(minLength: 0)
            }
            .padding(.vertical, zoomed(3))
            .padding(.horizontal, zoomed(4))
            .background {
                if hovered { RoundedRectangle(cornerRadius: SidebarMetrics.corner).fill(SidebarMetrics.hover) }
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .padding(.leading, zoomed(-4))
        .onHover { hovered = $0 }
        .tip("Open \(thread.title.isEmpty ? "this thread" : thread.title)")
    }
}

/// The ⓘ: where it comes from, and where runners are set up.
private struct RunnersAbout: View {
    var body: some View {
        VStack(alignment: .leading, spacing: zoomed(8)) {
            Text("The machines your threads run on, as your backend last heard from each. A runner that hasn't checked in for 3 minutes shows as offline. Updating means an old release is finishing its threads before handing over.")
            Text("The code on the right is the commit each one runs. Click a running thread to open it. A runner that isn't paired with this Mac lists its threads, but they open only once you run `tb pair` there.")
            Text("The star is where new threads start, which you can change in Settings > Runners. A runner is added or renamed on its own machine, so ask an agent to do it.")
        }
        .font(.system(size: zoomed(12)))
        .fixedSize(horizontal: false, vertical: true)
        .frame(width: zoomed(280), alignment: .leading)
        .padding(zoomed(14))
    }
}
