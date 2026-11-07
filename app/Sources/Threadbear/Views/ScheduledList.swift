import AppKit
import SwiftUI
import ThreadbearCore

/// The sidebar's Scheduled view, reached from its footer like the Den:
/// every schedule under Active, Paused and Done headings that fold like
/// the inbox's, soonest first in each. Clicking a row opens the editor;
/// its target opens the thread.
struct ScheduledList: View {
    @Environment(AppModel.self) private var app

    var body: some View {
        let schedules = app.schedules
        VStack(spacing: 0) {
            ModeHeader(title: "Scheduled", count: app.activeScheduleCount)
            SidebarButtonRow(icon: "plus", title: "New schedule", tip: "Schedule a message for later") {
                app.newSchedule(from: nil)
            }
            .padding(.horizontal, SidebarMetrics.outerInset)
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 0) {
                    let groups = ScheduleSection.group(schedules)
                    ForEach(ScheduleSection.allCases, id: \.self) { section in
                        if let rows = groups[section] {
                            ScheduleSectionView(section: section, schedules: rows)
                        }
                    }
                    if schedules.isEmpty {
                        EmptyNote(text: "Nothing scheduled.")
                    }
                }
                .padding(.horizontal, SidebarMetrics.outerInset)
                .padding(.top, zoomed(4))
                .padding(.bottom, zoomed(32))
            }
            .scrollIndicators(.never)
            .onExitCommand { app.sidebarMode = .inbox }
        }
    }
}

/// One heading and its rows; a heading with nothing under it isn't drawn.
private struct ScheduleSectionView: View {
    @Environment(AppModel.self) private var app
    let section: ScheduleSection
    let schedules: [Schedule]

    var body: some View {
        let collapsed = app.collapsedScheduleSections.contains(section)
        SectionHeading(title: section.title, icon: section.icon, fold: .init(collapsed: collapsed, count: schedules.count) {
            withAnimation(.snappy(duration: 0.2)) {
                if collapsed { app.collapsedScheduleSections.remove(section) } else { app.collapsedScheduleSections.insert(section) }
            }
        })
        if !collapsed {
            ForEach(schedules) { schedule in
                ScheduleRowView(schedule: schedule)
                    .transition(Juice.row)
            }
        }
    }
}

extension ScheduleSection {
    var icon: String {
        switch self {
        case .active: return "clock"
        case .paused: return "pause"
        case .done: return "checkmark"
        }
    }
}

private struct ScheduleRowView: View {
    @Environment(AppModel.self) private var app
    let schedule: Schedule
    @State private var hovering = false

    private var running: Bool { app.isBusy(BusyKey.runSchedule(schedule.id)) }
    /// Stays out while Run now is on its way, so its spinner shows wherever
    /// it was asked from (the row's menu, or a pointer that's moved on).
    private var showsActions: Bool { hovering || running || app.hoverOverride == schedule.id }

    var body: some View {
        VStack(alignment: .leading, spacing: zoomed(3)) {
            HStack(alignment: .firstTextBaseline, spacing: zoomed(6)) {
                Text(schedule.title.isEmpty ? "Untitled" : schedule.title)
                    .font(.system(size: TypeScale.sidebarTitle))
                    // A paused or finished one is there to be found, not
                    // something coming up.
                    .foregroundStyle(schedule.isActive ? .primary : .secondary)
                    .lineLimit(1)
                Spacer(minLength: zoomed(6))
                if showsActions {
                    // Room for the hover buttons, drawn over the row.
                    Color.clear.frame(width: 3 * zoomed(24) - zoomed(6), height: 1)
                } else {
                    state
                }
            }
            HStack(alignment: .firstTextBaseline, spacing: zoomed(4)) {
                Text(schedule.whenText)
                    .lineLimit(1)
                    .layoutPriority(2)
                if let away {
                    // Quiet, like the rest of the line: most schedules are
                    // this Mac's, and those say nothing about it.
                    Text("·").foregroundStyle(SidebarMetrics.faint)
                    // Its Mac's icon, so runners tell apart at a glance.
                    HStack(spacing: zoomed(3)) {
                        Image(systemName: app.runnerIcon(schedule)).imageScale(.small)
                        Text(away).lineLimit(1)
                    }
                    .layoutPriority(1)
                    .tip("Runs on \(away)")
                }
                Text("·").foregroundStyle(SidebarMetrics.faint)
                TargetButton(schedule: schedule)
            }
            .font(.system(size: TypeScale.sidebarPreview))
            .foregroundStyle(.secondary)
            if let away, let asked = schedule.runRequestedAt {
                Text("Waiting for \(away) to run it")
                    .font(.system(size: TypeScale.sidebarMeta))
                    .foregroundStyle(SidebarMetrics.faint)
                    .lineLimit(1)
                    .tip("Asked at \(asked.formatted(date: .omitted, time: .shortened)). It runs as soon as \(away) picks it up.")
            } else if let problem {
                Text(problem.text)
                    .font(.system(size: TypeScale.sidebarMeta))
                    .foregroundStyle(problem.failed ? Color(nsColor: Theme.failed) : SidebarMetrics.faint)
                    .lineLimit(1)
                    .tip(problem.text)
            }
        }
        .padding(EdgeInsets(top: 8, leading: SidebarMetrics.leading, bottom: 8, trailing: SidebarMetrics.trailing))
        .background(showsActions ? SidebarMetrics.hover : .clear, in: RoundedRectangle(cornerRadius: SidebarMetrics.corner))
        .contentShape(RoundedRectangle(cornerRadius: SidebarMetrics.corner))
        .onTapGesture { app.editSchedule(schedule.id) }
        // What it sends, which the row doesn't show. Click to edit it.
        .tip(String(schedule.text.prefix(300)))
        .overlay(alignment: .topTrailing) {
            if showsActions {
                actions
                    .padding(.top, zoomed(5))
                    .padding(.trailing, SidebarMetrics.trailing - 5)
            }
        }
        .onHover { hovering = $0 }
        .iconContextMenu {
            Button("Edit…", systemImage: "pencil") { app.editSchedule(schedule.id) }
            Button("Run now", systemImage: "play") { app.runSchedule(schedule.id) }
                .disabled(running)
            if !schedule.isFinished {
                Button(schedule.paused ? "Resume" : "Pause", systemImage: schedule.paused ? "playpause" : "pause") { app.setSchedulePaused(schedule.id, !schedule.paused) }
                    .disabled(app.isBusy(BusyKey.pauseSchedule(schedule.id)))
            }
            Divider()
            Button("Delete…", systemImage: "trash") { app.deleteSchedule(schedule.id) }
        }
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(.isButton)
        .accessibilityAction { app.editSchedule(schedule.id) }
    }

    /// Where the time goes on a thread's row: when it next runs, or why it
    /// won't.
    @ViewBuilder
    private var state: some View {
        Group {
            if schedule.paused {
                Text("Paused").foregroundStyle(.secondary)
            } else if schedule.isFinished {
                Text("Done").foregroundStyle(SidebarMetrics.faint)
            } else if let next = schedule.nextRunAt {
                Text(ScheduleTime.relative(next, now: app.now)).foregroundStyle(SidebarMetrics.faint).monospacedDigit()
                    .tip(next.formatted(date: .abbreviated, time: .shortened))
            }
        }
        .font(.system(size: TypeScale.sidebarMeta))
    }

    /// The other runner it runs on, by name; nil for this one's.
    private var away: String? { app.awayRunnerName(schedule) }

    /// The last run, only when it didn't send.
    private var problem: (text: String, failed: Bool)? {
        guard let last = schedule.lastRun else { return nil }
        switch last.outcome {
        case .sent: return nil
        case .failed: return ("Last run failed" + (last.note.map { ": \($0)" } ?? ""), true)
        case .skipped: return ("Skipped last run" + (last.note.map { ": \($0)" } ?? ""), false)
        }
    }

    private var actions: some View {
        HStack(spacing: zoomed(2)) {
            Button { app.runSchedule(schedule.id) } label: { Image(systemName: "paperplane") }
                .buttonStyle(RowIconButtonStyle())
                .busy(running)
                .tip(away.map { "Ask \($0) to run it now" } ?? "Run now")
            if !schedule.isFinished {
                Button { app.setSchedulePaused(schedule.id, !schedule.paused) } label: {
                    Image(systemName: schedule.paused ? "play" : "pause")
                }
                .buttonStyle(RowIconButtonStyle())
                .disabled(app.isBusy(BusyKey.pauseSchedule(schedule.id)))
                .tip(schedule.paused ? "Resume" : "Pause")
            }
            Button { app.deleteSchedule(schedule.id) } label: { Image(systemName: "trash") }
                .buttonStyle(RowIconButtonStyle())
                .tip("Delete")
        }
    }
}

/// The thread a schedule sends to, which opens it. A new thread each time
/// opens the last one it started, once there is one.
private struct TargetButton: View {
    @Environment(AppModel.self) private var app
    let schedule: Schedule
    @State private var hovering = false

    private var opens: String? {
        let id = schedule.threadId ?? schedule.lastRun?.threadId
        return id.flatMap { app.threads[$0] == nil ? nil : $0 }
    }

    var body: some View {
        let label = Text(app.scheduleTarget(schedule)).lineLimit(1)
        if let opens {
            Button { app.select(opens) } label: {
                label.underline(hovering, color: .secondary)
            }
            .buttonStyle(.plain)
            .onHover { hovering = $0 }
            .tip(schedule.threadId == nil ? "Open the last thread it started" : "Open the thread")
        } else {
            label
        }
    }
}
