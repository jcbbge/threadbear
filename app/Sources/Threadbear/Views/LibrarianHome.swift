import AppKit
import SwiftUI
import ThreadbearCore

/// The Librarian's page: what clicking Librarian in the activity bar shows
/// in the detail area, beside the sidebar's queue and recent looks. The
/// bear at its card catalogue, a line on what the librarian is for, what
/// it's doing now and its numbers.
struct LibrarianHome: View {
    @Environment(AppModel.self) private var app

    var body: some View {
        HomePage(picture: Art.librarian, pictureLabel: "The librarian bear, filing a card in a card catalogue", pokes: PokeLines.librarian,
                 stats: app.librarian.map { LibrarianStats.tiles($0, projects: app.projects, threads: Array(app.threads.values)) } ?? []) {
            LibrarianAbout(status: app.librarian)
        } below: {
            if let status = app.librarian {
                LibrarianSettings(status: status)
            }
        }
    }
}

/// The name, a line on what it does (more behind the ⓘ), and what it's
/// doing now.
private struct LibrarianAbout: View {
    let status: LibrarianStatus?

    var body: some View {
        VStack(alignment: .leading, spacing: zoomed(12)) {
            HomeTitle(title: "Librarian",
                      line: "Keeps your projects tidy as your threads go.",
                      more: Self.more)
            if let status {
                HomeStatusLine(text: LibrarianText.state(status), busy: status.state == .working)
            }
        }
    }

    static let more = "It files each thread in a project, writes down where the project's up to, and renames threads that have wandered off from their title. It takes a look after a thread's first message and when a turn ends, then catches up at most every 20 minutes while the thread keeps going. A catch-up after only a quick reply is skipped without asking the model. Each look is one short call to Haiku, not the model your threads use, on the Claude login with the most room in the Runs on pool, and counts towards its usage. It waits when they're all out of room, and threads in a private folder are never sent. A thread you take out of a project is never put back in it."
}

/// What can be changed about the librarian, here rather than only in
/// Settings: whether it's looking at all, and which pool's Claude logins
/// it runs on. The pool is the runner's small-jobs setting, which titles
/// share, so a change here shows in Settings › Models too.
private struct LibrarianSettings: View {
    @Environment(AppModel.self) private var app
    let status: LibrarianStatus

    var body: some View {
        VStack(alignment: .leading, spacing: zoomed(12)) {
            Text("Settings")
                .font(.system(size: zoomed(17), weight: .semibold))
            Grid(alignment: .leadingFirstTextBaseline, horizontalSpacing: zoomed(16), verticalSpacing: zoomed(12)) {
                GridRow {
                    Text("Look at threads")
                        .foregroundStyle(.secondary)
                    Toggle("Look at threads", isOn: Binding(get: { !status.paused }, set: { app.setLibrarianPaused(!$0) }))
                        .labelsHidden()
                        .toggleStyle(.switch)
                        .controlSize(.small)
                        .disabled(app.isBusy(BusyKey.pauseLibrarian))
                        .tip(status.paused ? "Paused: what's queued waits. Turn it on to carry on" : "Turn it off to pause; what's queued waits")
                }
                if let settings = app.runnerSettings, settings.models.poolSupported {
                    GridRow {
                        Text("Runs on")
                            .foregroundStyle(.secondary)
                        Picker("Runs on", selection: Binding(get: { settings.models.pool }, set: { app.updateSettings(SettingsUpdate(pool: .some($0))) })) {
                            ForEach(app.claudePools) { pool in
                                Label(pool.title, systemImage: Pools.symbol(pool, accounts: app.accounts)).labelStyle(.titleAndIcon).tag(Optional(pool.id))
                            }
                            // What's set but can't take a look: None (from
                            // Settings), or a pool deleted since or with no
                            // Claude login. Shown so the picker still says
                            // what's set; not offered.
                            if let id = settings.models.pool, !app.claudePools.contains(where: { $0.id == id }) {
                                Label("\(id), which has no Claude login", systemImage: "exclamationmark.triangle").labelStyle(.titleAndIcon).tag(Optional(id))
                            } else if settings.models.pool == nil {
                                Label("No pool", systemImage: "nosign").labelStyle(.titleAndIcon).tag(String?.none)
                            }
                        }
                        .labelsHidden()
                        .fixedSize()
                        .tip("Which pool's Claude logins it uses, the one with the most room. It waits when they're all out of room. Titles use the same pool (Settings › Models)")
                    }
                }
            }
            .font(.system(size: TypeScale.label))
            Button("More in Settings…") { app.openModelSettings() }
                .controlSize(.small)
                .tip("Private folders, whose threads are never sent anywhere")
        }
        .padding(.top, zoomed(8))
    }
}

/// The page's numbers, from the status the runner sends and what the app
/// already knows about projects and threads.
enum LibrarianStats {
    typealias Tile = HomeStat

    static func tiles(_ status: LibrarianStatus, projects: [Project], threads: [ThreadSummary]) -> [Tile] {
        let made = projects.filter { $0.createdBy == .librarian && !$0.archived }.count
        let filed = threads.filter { $0.archivedAt == nil && $0.projects.contains { $0.by == .librarian } }.count
        return [
            Tile(value: "\(status.looksToday)", label: "Looks today",
                 help: "Threads it has looked at since midnight"),
            Tile(value: "\(status.skippedToday)", label: "Skipped today",
                 help: "Catch-ups after only a quick reply, skipped without asking the model"),
            Tile(value: LibrarianText.tokens(status.tokensToday), label: "Tokens today",
                 help: "What today's looks sent and got back"),
            Tile(value: "\(made)", label: made == 1 ? "Project it made" : "Projects it made",
                 help: "Projects the librarian started that aren't archived"),
            Tile(value: "\(filed)", label: filed == 1 ? "Thread it filed" : "Threads it filed",
                 help: "Open threads the librarian put in a project"),
            Tile(value: "\(status.queue.count)", label: "Waiting",
                 help: "Threads queued for a look, listed in the sidebar"),
        ]
    }
}
