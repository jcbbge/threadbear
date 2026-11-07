import AppKit
import SwiftUI
import ThreadbearCore

/// The sidebar's Librarian view: what the runner's background job that
/// keeps projects up to date is doing, what it will look at next, and what
/// it has done, with a way to pause it and to ask it to look at everything.
struct LibrarianView: View {
    @Environment(AppModel.self) private var app

    var body: some View {
        VStack(spacing: 0) {
            ModeHeader(title: "Librarian", count: nil)
            if let status = app.librarian {
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 0) {
                        LibrarianState(status: status)
                        SectionHeading(title: "Next", icon: "hourglass")
                        ForEach(status.queue, id: \.threadId) { job in
                            QueueRow(job: job)
                        }
                        if status.queue.isEmpty {
                            EmptyNote(text: "Nothing waiting.")
                        }
                        SectionHeading(title: "Recent", icon: "clock.arrow.circlepath")
                        ForEach(status.recent) { entry in
                            EntryRow(entry: entry)
                        }
                        if status.recent.isEmpty {
                            EmptyNote(text: "Nothing yet.")
                        }
                    }
                    .padding(.horizontal, SidebarMetrics.outerInset)
                    .padding(.bottom, zoomed(32))
                }
                .scrollIndicators(.never)
            } else {
                EmptyNote(text: "Loading…")
                    .padding(.horizontal, SidebarMetrics.outerInset)
                    .frame(maxWidth: .infinity, alignment: .leading)
                Spacer()
            }
        }
        .onExitCommand { app.sidebarMode = .inbox }
    }
}

/// What it's doing now, the day's looks and spend, Pause and Look at
/// everything.
private struct LibrarianState: View {
    @Environment(AppModel.self) private var app
    let status: LibrarianStatus

    var body: some View {
        VStack(alignment: .leading, spacing: zoomed(6)) {
            Text(LibrarianText.state(status))
                .font(.system(size: TypeScale.sidebarTitle))
                .foregroundStyle(.primary)
                .lineLimit(2)
                // In the rows' leading gutter, as a thread's unread dot is,
                // so the words line up with the titles below.
                .overlay(alignment: .topLeading) {
                    // On the first line when the words wrap.
                    indicator
                        .frame(width: zoomed(12), height: zoomed(12))
                        .offset(x: -(SidebarMetrics.leading + zoomed(12)) / 2, y: zoomed(4))
                }
            if let current = status.current, status.state == .working {
                Text(working(current))
                    .font(.system(size: TypeScale.sidebarPreview))
                    .foregroundStyle(.secondary)
                    .lineLimit(2)
            }
            Text(LibrarianText.today(status))
                .font(.system(size: TypeScale.sidebarMeta))
                .foregroundStyle(SidebarMetrics.faint)
                .monospacedDigit()
                .tip("Today's looks, quiet catch-ups it skipped without asking the model, and tokens used on your Claude login")
            HStack(spacing: zoomed(8)) {
                Button(status.paused ? "Resume" : "Pause") { app.setLibrarianPaused(!status.paused) }
                    .disabled(app.isBusy(BusyKey.pauseLibrarian))
                    .tip(status.paused ? "Let it look at threads again" : "Stop looking at threads; what's queued waits")
                Button("Look at everything") { app.runLibrarian() }
                    .busy(app.isBusy(BusyKey.runLibrarian(nil)))
                    .tip("Queue a look at every thread it hasn't looked at yet, newest first")
            }
            .controlSize(.small)
            .padding(.top, zoomed(4))
        }
        .padding(.leading, SidebarMetrics.leading)
        .padding(.trailing, SidebarMetrics.trailing)
        .padding(.top, zoomed(8))
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    @ViewBuilder
    private var indicator: some View {
        switch status.state {
        case .working:
            SpinnerMark(color: .controlAccentColor)
        case .paused:
            Image(systemName: "pause.circle").font(.system(size: zoomed(12))).foregroundStyle(.secondary)
        case .off:
            Image(systemName: "exclamationmark.circle").font(.system(size: zoomed(12))).foregroundStyle(.secondary)
        case .idle:
            Circle().fill(SidebarMetrics.faint).frame(width: zoomed(6), height: zoomed(6))
        }
    }

    private func working(_ job: LibrarianJob) -> String {
        let why = LibrarianText.why(job)
        guard let started = job.startedAt else { return why }
        let ago = RelativeTime.short(started, now: app.now)
        return "\(why) · started \(ago == "now" ? "just now" : ago + " ago")"
    }
}

/// A look it will take: the thread (which opens), why, and when.
private struct QueueRow: View {
    @Environment(AppModel.self) private var app
    let job: LibrarianJob

    var body: some View {
        VStack(alignment: .leading, spacing: zoomed(3)) {
            HStack(alignment: .firstTextBaseline, spacing: zoomed(6)) {
                ThreadLink(threadId: job.threadId, title: job.threadTitle)
                    .font(.system(size: TypeScale.sidebarTitle))
                Spacer(minLength: zoomed(6))
                Text(LibrarianText.due(job.dueAt, now: app.now))
                    .font(.system(size: TypeScale.sidebarMeta))
                    .foregroundStyle(SidebarMetrics.faint)
                    .monospacedDigit()
                    .tip(job.dueAt?.formatted(date: .abbreviated, time: .shortened) ?? "")
            }
            Text(LibrarianText.why(job))
                .font(.system(size: TypeScale.sidebarPreview))
                .foregroundStyle(.secondary)
                .lineLimit(1)
        }
        .padding(EdgeInsets(top: zoomed(7), leading: SidebarMetrics.leading, bottom: zoomed(7), trailing: SidebarMetrics.trailing))
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

/// Something it did: what, to which thread and projects (each opens), and
/// when.
private struct EntryRow: View {
    @Environment(AppModel.self) private var app
    let entry: LibrarianEntry

    var body: some View {
        VStack(alignment: .leading, spacing: zoomed(3)) {
            HStack(alignment: .firstTextBaseline, spacing: zoomed(6)) {
                Text(entry.text.isEmpty ? EntryRow.outcomeWords(entry.outcome) : entry.text)
                    .font(.system(size: TypeScale.sidebarTitle))
                    .foregroundStyle(entry.outcome == .failed ? Color(nsColor: Theme.failed) : entry.outcome == .nothing || entry.outcome == .skipped ? .secondary : .primary)
                    .lineLimit(2)
                Spacer(minLength: zoomed(6))
                if let at = entry.at {
                    Text(RelativeTime.short(at, now: app.now))
                        .font(.system(size: TypeScale.sidebarMeta))
                        .foregroundStyle(SidebarMetrics.faint)
                        .monospacedDigit()
                        .tip(at.formatted(date: .abbreviated, time: .shortened))
                }
            }
            // The thread, then the projects it touched. Tidying a
            // project's notes has no thread, just the project.
            HStack(alignment: .firstTextBaseline, spacing: zoomed(4)) {
                if !entry.threadId.isEmpty {
                    ThreadLink(threadId: entry.threadId, title: entry.threadTitle)
                        .layoutPriority(1)
                }
                ForEach(Array(entry.projectIds.enumerated()), id: \.element) { n, id in
                    if let project = app.project(id) {
                        if n > 0 || !entry.threadId.isEmpty { Text("·").foregroundStyle(SidebarMetrics.faint) }
                        PlainLink(title: project.title, help: "Open the project") { app.openProjectPage(id) }
                    }
                }
            }
            .font(.system(size: TypeScale.sidebarPreview))
            .foregroundStyle(.secondary)
        }
        .padding(EdgeInsets(top: zoomed(7), leading: SidebarMetrics.leading, bottom: zoomed(7), trailing: SidebarMetrics.trailing))
        .frame(maxWidth: .infinity, alignment: .leading)
        .tip(EntryRow.help(entry))
    }

    static func outcomeWords(_ outcome: LibrarianEntry.Outcome) -> String {
        switch outcome {
        case .joined: return "Put it in a project"
        case .created: return "Made a project"
        case .updated: return "Updated a project"
        case .left: return "Took it out of a project"
        case .nothing: return "Left it as it was"
        case .skipped: return "Skipped it"
        case .failed: return "Couldn't look"
        case .other: return "Looked"
        }
    }

    static func help(_ entry: LibrarianEntry) -> String {
        var parts = [LibrarianText.reason(entry.reason)]
        if let cost = CostText.format(entry.costUsd) { parts.append(cost) }
        return parts.joined(separator: " · ")
    }
}

/// A thread's title that opens it, or plain words for one that's gone.
private struct ThreadLink: View {
    @Environment(AppModel.self) private var app
    let threadId: String
    let title: String

    var body: some View {
        let shown = app.threads[threadId].map { $0.title.isEmpty ? "Untitled" : $0.title } ?? (title.isEmpty ? "A thread that's gone" : title)
        if app.threads[threadId] != nil {
            PlainLink(title: shown, help: "Open the thread") { app.openThread(threadId) }
        } else {
            Text(shown).lineLimit(1)
        }
    }
}

/// Words that do something when clicked: underlined on hover, as a
/// schedule's target is.
struct PlainLink: View {
    let title: String
    var help: String = ""
    let action: () -> Void
    @State private var hovering = false

    var body: some View {
        Button(action: action) {
            Text(title).lineLimit(1).underline(hovering, color: .secondary)
        }
        .buttonStyle(.plain)
        .onHover { hovering = $0 }
        .tip(help)
    }
}
