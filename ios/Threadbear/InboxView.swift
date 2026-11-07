import SwiftUI
import ThreadbearKit

/// How many cards are in the Pocket: grey once they've all been seen, the
/// accent colour when one's been filed or changed since.
private struct PocketBadge: View {
    var count: Int
    var hasNew: Bool

    var body: some View {
        if count > 0 {
            Text(count, format: .number)
                .font(.system(size: 10, weight: .bold))
                .monospacedDigit()
                .foregroundStyle(.white)
                .padding(.horizontal, 4)
                .frame(minWidth: 15, minHeight: 15)
                .background(hasNew ? Color.accentColor : Color.gray, in: .capsule)
                .allowsHitTesting(false)
        }
    }
}

struct InboxView: View {
    @Environment(AppModel.self) private var model
    @Environment(QuickAskModel.self) private var quick
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var path: [String] = []
    @State private var composing = false
    @State private var composeText = ""
    @State private var hibernateTarget: PhoneThread?
    @State private var query = ""
    @State private var olderArchived: [PhoneThread] = []
    @State private var pocketOpen = false
    /// Settings pushed at launch (`-ThreadbearSettings`, for screenshots).
    @State private var settingsOpen = false
    @State private var afterPocket: PocketView.Next?
    /// A thread started from the sheet that's ready before the sheet's gone,
    /// to open once it has.
    @State private var afterCompose: String?
    /// The start the sheet closed with, until it's slid away: only that one's
    /// thread waits to open, not one asked for earlier landing meanwhile.
    @State private var closingFor: String?
    /// A failed start, back in the sheet as it was.
    @State private var composeDraft: NewThreadDraft?
    /// How far the list's pulled down, for the bear peeking over it. Only the
    /// bear reads it, so a pull redraws the bear and not the whole list.
    @State private var pull = PullState()

    private var pocketValue: String {
        let count = model.pocket.count
        guard count > 0 else { return "Empty" }
        return "\(count) \(count == 1 ? "card" : "cards")\(model.pocketHasNew ? ", new since you last looked" : "")"
    }

    var body: some View {
        NavigationStack(path: $path) {
            List {
                if let problem = model.backendProblem {
                    Section {
                        Label(problem, systemImage: "arrow.down.circle")
                            .font(.subheadline)
                            .foregroundStyle(.secondary)
                    }
                }
                if let offline = model.offlineText {
                    Section {
                        Label(offline, systemImage: "moon.zzz")
                            .font(.subheadline)
                            .foregroundStyle(.secondary)
                    } footer: {
                        Text("Anything you send waits until it's back.")
                    }
                }
                if query.trimmingCharacters(in: .whitespaces).isEmpty, !model.starting.isEmpty {
                    Section { ForEach(model.starting) { startingRow($0) } }
                }
                let sections = model.sections
                if !query.trimmingCharacters(in: .whitespaces).isEmpty {
                    results(ThreadSearch(query, sections: sections, hibernating: model.hibernating, archived: model.den, olderArchived: olderArchived))
                } else if !model.loaded.contains(.inbox) {
                    LoadingRows()
                }
                if query.trimmingCharacters(in: .whitespaces).isEmpty, model.loaded.contains(.inbox) {
                    ForEach(sections.lines(folded: { model.folds.isFolded($0) })) { line(for: $0) }
                    section(.hibernating)
                    section(.archived)
                }
            }
            // A flat list with the Mac sidebar's headings, not grouped cards.
            .listStyle(.plain)
            .listSectionSeparator(.hidden)
            // Folded headings sit one under another, without the gap an
            // empty section would leave.
            .listSectionSpacing(0)
            .navigationTitle("Threadbear")
            // As it sits anyway with the search field always showing. A large
            // title also grew out of it on a pull, over the bear peeking up.
            .navigationBarTitleDisplayMode(.inline)
            // Always showing, rather than tucked under the title until you
            // pull down: on the phone it's the quickest way to an old thread.
            .searchable(text: $query, placement: .navigationBarDrawer(displayMode: .always))
            // The phone has only the newest 100 archived threads, so Convex
            // looks through the rest, once typing pauses.
            .task(id: query) {
                olderArchived = []
                let text = query.trimmingCharacters(in: .whitespaces)
                guard !text.isEmpty else { return }
                try? await Task.sleep(for: .milliseconds(300))
                guard !Task.isCancelled else { return }
                let found = await model.searchOlderArchived(text)
                if !Task.isCancelled { olderArchived = found }
            }
            .navigationDestination(for: String.self) { ThreadView(threadId: $0) }
            .navigationDestination(isPresented: $settingsOpen) {
                if model.opensRunnerOrderAtLaunch { RunnerOrderView() } else { SettingsView() }
            }
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Menu {
                        NavigationLink { SettingsView() } label: { Label("Settings", systemImage: "gear") }
                        if model.isFake {
                            Button { model.leaveDemo() } label: {
                                Label("Leave the demo", systemImage: "rectangle.portrait.and.arrow.right")
                            }
                        }
                    } label: {
                        Image(systemName: "line.3.horizontal")
                    }
                }
                if model.showsPocket {
                    ToolbarItem(placement: .topBarTrailing) {
                        Button { pocketOpen = true } label: {
                            // A frame with room for the badge: the toolbar clips a
                            // button's label to its bounds, so an offset badge lost its top.
                            Image(systemName: "wallet.pass")
                                .frame(width: 44, height: 36)
                                .overlay(alignment: .topTrailing) {
                                    PocketBadge(count: model.pocket.count, hasNew: model.pocketHasNew)
                                }
                                .compositingGroup()
                        }
                        .accessibilityLabel("Pocket")
                        .accessibilityValue(pocketValue)
                    }
                }
                if quick.settings.isReady {
                    ToolbarItem(placement: .topBarTrailing) {
                        Button { quick.open() } label: { Image(systemName: "waveform") }
                            .accessibilityLabel("Ask")
                    }
                }
                ToolbarItem(placement: .topBarTrailing) {
                    Button { composing = true } label: { Image(systemName: "square.and.pencil") }
                        .accessibilityLabel("New thread")
                }
            }
            .fullScreenCover(isPresented: $pocketOpen, onDismiss: {
                // Only once the cover has gone: nothing else can present
                // or push while it's still up.
                switch afterPocket {
                case let .thread(id): path.append(id)
                case .add: model.composeText = "Add to my pocket: "
                case nil: break
                }
                afterPocket = nil
            }) {
                PocketView { afterPocket = $0 }
            }
            .onAppear {
                if model.opensPocketAtLaunch {
                    model.opensPocketAtLaunch = false
                    pocketOpen = true
                }
                if model.opensSettingsAtLaunch || model.opensRunnerOrderAtLaunch {
                    model.opensSettingsAtLaunch = false
                    settingsOpen = true
                }
            }
            .sheet(isPresented: $composing, onDismiss: {
                composeText = ""
                // Only once the sheet has gone, as with the Pocket's cover. Pushed while
                // it was still sliding away with the keyboard, the thread could open
                // blank on the phone until you went back and in again.
                composeDraft = nil
                closingFor = nil
                if let id = afterCompose, path.isEmpty { path.append(id) }
                afterCompose = nil
            }) {
                if let composeDraft {
                    NewThreadView(draft: composeDraft) { closingFor = $0 }
                } else {
                    NewThreadView(text: composeText) { closingFor = $0 }
                }
            }
            // A thread that started soon after Start opens, as the sheet
            // used to wait to do, unless you've gone into another or are
            // writing the next one meanwhile.
            .onChange(of: model.justStarted?.threadId) {
                guard let started = model.justStarted else { return }
                model.justStarted = nil
                if started.commandId == closingFor { afterCompose = started.threadId }
                else if !composing, path.isEmpty { path.append(started.threadId) }
            }
            .onChange(of: model.retryDraft != nil) {
                guard let draft = model.retryDraft else { return }
                model.retryDraft = nil
                composeDraft = draft
                composing = true
            }
            .onChange(of: model.composeText, initial: true) { _, text in
                guard let text else { return }
                composeText = text
                composing = true
                model.composeText = nil
            }
            .hibernateDialog(for: $hibernateTarget)
            // Its own pull to refresh rather than .refreshable, whose spinner
            // holds back until the list's been pulled about 190 pt: the bear
            // blinks at 80, as in the mockup Mike picked, and letting go there
            // refreshes, holding the list open while it does.
            .onScrollGeometryChange(for: CGPoint.self) { CGPoint(x: $0.contentInsets.top, y: $0.contentOffset.y) } action: { _, g in
                pull.scrolled(offset: g.y, topInset: g.x)
            }
            .onScrollPhaseChange { old, new in
                if new == .interacting { pull.touching = true }
                if old == .interacting, new != .interacting {
                    pull.touching = false
                    if pull.letGo() { Task { await refresh() } }
                }
            }
            .contentMargins(.top, pull.holding ? PullPeek.hold : 0, for: .scrollContent)
            .accessibilityAction(named: "Reconnect") { Task { await refresh() } }
            .overlay(alignment: .top) {
                if query.trimmingCharacters(in: .whitespaces).isEmpty { PullPeekBear(pull: pull) }
            }
            .overlay(alignment: .bottom) { ConnectionToast() }
            .onChange(of: query, initial: true) { _, text in
                model.setSearching(!text.trimmingCharacters(in: .whitespaces).isEmpty)
            }
            .onChange(of: model.searchText, initial: true) { _, text in
                guard let text else { return }
                query = text
                model.searchText = nil
            }
            .onChange(of: path.isEmpty, initial: true) { _, empty in model.threadOpen = !empty }
            .onChange(of: model.openThreadId, initial: true) { _, id in
                guard let id else { return }
                path = [id]
                model.openThreadId = nil
            }
        }
        .environment(\.pushThread) { path.append($0) }
    }

    /// Pull to refresh: the bear blinks with a light tap as the list's held open,
    /// the app reconnects to Convex for real, the bear nods, then ducks back
    /// behind the list as it slides home.
    private func refresh() async {
        guard !pull.refreshing else { return }
        pull.refreshing = true
        pull.holding = true
        await model.reconnect()
        if !reduceMotion {
            pull.nods += 1
            try? await Task.sleep(for: .milliseconds(560))
        }
        withAnimation(.easeIn(duration: 0.2)) { pull.ducked = true }
        try? await Task.sleep(for: .milliseconds(200))
        withAnimation(.snappy(duration: 0.32)) { pull.holding = false }
        try? await Task.sleep(for: .milliseconds(320))
        pull.refreshing = false
    }

    /// One line of the flat top of the list: Starred, Inbox and Running, where
    /// a row keeps its identity under any heading, so the List can glide it to
    /// another (`InboxSections.lines`).
    @ViewBuilder private func line(for line: InboxLine) -> some View {
        switch line {
        case let .heading(section):
            heading(section)
                .listRowInsets(EdgeInsets(top: 0, leading: 16, bottom: 0, trailing: 16))
                .listRowSeparator(.hidden)
                .listRowBackground(Color.clear)
        case let .thread(thread, under):
            row(thread, running: under == .running, starred: under == .starred)
        case .inboxZero:
            // In the Inbox's place, so anything still running sits under it.
            InboxZeroView(celebrating: model.inboxJustCleared)
                .listRowBackground(Color.clear)
                .listRowSeparator(.hidden)
        }
    }

    /// As on the Mac's sidebar: tap a heading to fold it away, and folded it says
    /// how many it hides. The Inbox never folds.
    @ViewBuilder private func heading(_ section: PhoneSection) -> some View {
        if section == .inbox {
            SectionHeading(title: section.title, icon: section.icon)
        } else {
            let folded = model.folds.isFolded(section)
            // A tap rather than a Button: a button in a list header
            // is drawn dimmed, so the heading looked disabled.
            SectionHeading(title: section.title, icon: section.icon, fold: .init(folded: folded, count: model.count(section)),
                           bounce: section == .hibernating && !reduceMotion ? model.tucks.bounces : 0)
                .onTapGesture { withAnimation(.snappy(duration: 0.2)) { model.toggle(section) } }
                .accessibilityAction { model.toggle(section) }
                .accessibilityHint(folded ? "Shows these threads" : "Hides these threads")
        }
    }

    /// Hibernating or Archived: a real section, loaded only once it's opened.
    /// A folded one with no count (an older backend) still shows its heading, so
    /// there's a way to open it. Empty, it's left out.
    @ViewBuilder private func section(_ section: PhoneSection) -> some View {
        let count = model.count(section)
        if count != 0 {
            Section {
                if !model.folds.isFolded(section) {
                    if section == .hibernating {
                        // The scheduled ones are in the inbox list already;
                        // the snoozed ones load once it's opened.
                        hibernatingRows(model.threads(section))
                        if !model.loaded.contains(.hibernating) { LoadingRows(count: 3) }
                    } else if let view = section.view {
                        if !model.loaded.contains(view) {
                            LoadingRows(count: 3)
                        } else {
                            putAwayRows(model.threads(section), from: view)
                        }
                    }
                }
            } header: {
                heading(section)
            }
        }
    }

    /// What the search found, under the same headings as the Mac's sidebar,
    /// the put-away threads too.
    @ViewBuilder private func results(_ search: ThreadSearch) -> some View {
        if search.isEmpty {
            ContentUnavailableView.search(text: query.trimmingCharacters(in: .whitespaces))
                .listRowBackground(Color.clear)
                .listRowSeparator(.hidden)
        }
        if !search.starred.isEmpty {
            Section { rows(search.starred, starred: true) } header: { SectionHeading(title: "Starred", icon: "star") }
        }
        if !search.inbox.isEmpty {
            Section { rows(search.inbox) } header: { SectionHeading(title: "Inbox", icon: "tray") }
        }
        if !search.running.isEmpty {
            Section { rows(search.running, running: true) } header: { SectionHeading(title: "Running", icon: "bolt") }
        }
        if !search.hibernating.isEmpty {
            Section { hibernatingRows(search.hibernating) } header: { SectionHeading(title: "Hibernating", icon: "moon.zzz") }
        }
        if !search.archived.isEmpty {
            Section { putAwayRows(search.archived, from: .den) } header: { SectionHeading(title: "Archived", icon: "archivebox") }
        }
    }

    /// Hibernating or archived rows: open on a tap, and swipe to bring
    /// back.
    private func putAwayRows(_ threads: [PhoneThread], from view: ThreadsView) -> some View {
        ForEach(threads) { putAwayRow($0, from: view) }
    }

    private func putAwayRow(_ thread: PhoneThread, from view: ThreadsView) -> some View {
        Button { path.append(thread.threadId) } label: { ThreadRow(thread: thread) }
            .buttonStyle(.plain)
            .listRowInsets(ThreadRow.insets)
            .listRowSeparator(.hidden)
            .bringBackSwipe(thread, from: view)
    }

    /// Under Hibernating, snoozed threads wake with a swipe. One only
    /// waiting on a schedule isn't snoozed, so it gets an inbox row that
    /// says when the schedule runs, and can be hibernated for real.
    private func hibernatingRows(_ threads: [PhoneThread]) -> some View {
        ForEach(threads) { thread in
            if InboxSections.isSnoozed(thread, now: model.now) {
                putAwayRow(thread, from: .hibernating)
            } else {
                row(thread, scheduled: true)
            }
        }
    }

    /// A new thread the runner hasn't made yet. A failed one opens the sheet
    /// again with what was typed, or swipes away.
    private func startingRow(_ row: StartingThread) -> some View {
        Button { if row.failed != nil { model.retryStarting(row) } } label: { StartingRow(row: row) }
            .buttonStyle(.plain)
            .disabled(row.failed == nil)
            .listRowInsets(ThreadRow.insets)
            .listRowSeparator(.hidden)
            .swipeActions(edge: .trailing) {
                if row.failed != nil {
                    Button(role: .destructive) { model.dropStarting(row.id) } label: { Label("Remove", systemImage: "xmark") }
                }
            }
    }

    private func rows(_ threads: [PhoneThread], running: Bool = false, starred: Bool = false) -> some View {
        ForEach(threads) { row($0, running: running, starred: starred) }
    }

    @ViewBuilder private func row(_ thread: PhoneThread, running: Bool = false, scheduled: Bool = false, starred: Bool = false) -> some View {
        // Only under Starred can a row be asleep: elsewhere it's in Hibernating.
        let asleep = starred && InboxSections.isSnoozed(thread, now: model.now)
        // A plain row, not a NavigationLink: the Mac's rows have no
        // chevron, and the status sits where it would go.
        Button { path.append(thread.threadId) } label: {
            ThreadRow(thread: thread, underRunning: running, wake: scheduled ? model.wakes[thread.threadId] : nil, asleep: asleep)
                // Off to the left, the way a swipe to archive goes.
                .offset(x: model.slidingOff.contains(thread.threadId) && !reduceMotion ? -500 : 0)
                // Hibernating goes down instead, towards its heading.
                .offset(y: model.sinking.contains(thread.threadId) && !reduceMotion ? 14 : 0)
                .scaleEffect(model.sinking.contains(thread.threadId) && !reduceMotion ? 0.96 : 1)
                .opacity(model.slidingOff.contains(thread.threadId) || model.sinking.contains(thread.threadId) ? 0 : 1)
        }
        .buttonStyle(.plain)
        .listRowInsets(ThreadRow.insets)
        .listRowSeparator(.hidden)
        .swipeActions(edge: .trailing) {
            Button { model.archive(thread.threadId) } label: { Label("Archive", systemImage: "archivebox") }
                .tint(.brown)
        }
        .swipeActions(edge: .leading) {
            if asleep {
                Button { Task { await perform(thread, .wake) } } label: { Label("Wake", systemImage: "sun.max") }
                    .tint(.accentColor)
            } else {
                Button { hibernateTarget = thread } label: { Label("Hibernate", systemImage: "moon.zzz") }
                    .tint(.indigo)
            }
            if model.canStar { starButton(thread).tint(.yellow) }
        }
        .contextMenu {
            if model.canStar { starButton(thread) }
            if asleep {
                Button { Task { await perform(thread, .wake) } } label: { Label("Wake", systemImage: "sun.max") }
            } else {
                Button { hibernateTarget = thread } label: { Label("Hibernate…", systemImage: "moon.zzz") }
            }
            Button { model.archive(thread.threadId) } label: { Label("Archive", systemImage: "archivebox") }
            if thread.unread || thread.needsYou {
                Button { Task { await perform(thread, .markSeen) } } label: { Label("Mark as read", systemImage: "envelope.open") }
            }
            Button { UIPasteboard.general.string = thread.threadId } label: { Label("Copy Thread ID", systemImage: "number") }
        }
    }

    private func starButton(_ thread: PhoneThread) -> some View {
        let starred = thread.starredAt != nil
        return Button { Task { await perform(thread, .star(!starred)) } } label: {
            Label(starred ? "Remove Star" : "Star", systemImage: starred ? "star.slash" : "star")
        }
    }

    private func perform(_ thread: PhoneThread, _ change: ThreadChange) async {
        guard let backend = model.backend else { return }
        do { _ = try await backend.update(threadId: thread.threadId, change: change) } catch { model.report(error) }
    }
}

extension View {
    /// Wake a hibernating thread, or put an archived one back in the inbox.
    func bringBackSwipe(_ thread: PhoneThread, from view: ThreadsView) -> some View {
        modifier(BringBackSwipe(thread: thread, view: view))
    }
}

private struct BringBackSwipe: ViewModifier {
    @Environment(AppModel.self) private var model
    var thread: PhoneThread
    var view: ThreadsView

    func body(content: Content) -> some View {
        content.swipeActions(edge: .trailing) {
            Button {
                Task {
                    guard let backend = model.backend else { return }
                    do { _ = try await backend.update(threadId: thread.threadId, change: view == .den ? .unarchive : .wake) }
                    catch { model.report(error) }
                }
            } label: {
                Label(view == .den ? "Back to inbox" : "Wake", systemImage: view == .den ? "tray.and.arrow.up" : "sun.max")
            }
            .tint(.accentColor)
        }
    }
}

/// A row as the Mac sidebar draws one: the project's tile two lines tall,
/// the title across the width, and under it where the thread belongs and
/// what it's doing, with the unread dot (or the done tick) in the gutter
/// left of the tile.
/// A thread row's look for a new thread on its way: what was asked, and
/// "Starting" with a spinner where a working row's time goes, until the
/// runner has made it and its own row takes over.
private struct StartingRow: View {
    @Environment(AppModel.self) private var model
    var row: StartingThread

    var body: some View {
        HStack(alignment: .center, spacing: 10) {
            ProjectTiles(projects: [])
            VStack(alignment: .leading, spacing: 3) {
                Text(title)
                    .font(.body)
                    .foregroundStyle(row.failed == nil ? .secondary : .primary)
                    .lineLimit(1)
                HStack(alignment: .firstTextBaseline, spacing: 6) {
                    Text(line2).font(.subheadline).foregroundStyle(.secondary).lineLimit(1)
                    Spacer(minLength: 6)
                    if row.failed != nil {
                        Text("Failed").font(.footnote.weight(.medium)).foregroundStyle(Look.failed)
                    } else {
                        HStack(alignment: .firstTextBaseline, spacing: 5) {
                            ProgressView()
                                .controlSize(.mini)
                                .tint(.accentColor)
                                .alignmentGuide(.firstTextBaseline) { $0[VerticalAlignment.center] + 4 }
                            Text("Starting")
                        }
                        .font(.footnote.weight(.medium))
                        .foregroundStyle(Color.accentColor)
                    }
                }
            }
        }
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
        .accessibilityHint(row.failed != nil ? "Opens it again to try once more" : "")
    }

    private var title: String {
        let first = row.message.split(whereSeparator: \.isNewline).first.map(String.init) ?? ""
        if !first.isEmpty { return first }
        let photos = row.draft.photos.count
        return photos == 1 ? "A photo" : "\(photos) photos"
    }

    private var line2: String {
        if let failed = row.failed { return "Tap to try again · \(failed)" }
        // Its Mac asleep: it starts when it's back, maybe much later.
        // No runner picked: the backend's, which with one runner is that one.
        let picked = row.draft.runnerId.flatMap { id in model.runners.first { $0.runnerId == id } }
        guard let runner = picked ?? (model.runners.count == 1 ? model.runners.first : nil) else { return model.offlineText ?? "On its way" }
        guard runner.isOnline(at: model.now) else { return "\(runner.name) offline, starts when it's back" }
        return runner.name
    }
}

struct ThreadRow: View {
    @Environment(AppModel.self) private var model
    var thread: PhoneThread
    /// Under the Running heading a working row shows just its spinner and
    /// time, as on the Mac: the heading says what it's doing.
    var underRunning = false
    /// Under the Waiting heading, the schedule that messages it next: the
    /// row says when, where the time would be, as on the Mac.
    var wake: PhoneSchedule?
    /// Under Starred and hibernating: a moon says so, as there's no heading to.
    var asleep = false

    /// Room on the left for the gutter mark; the trailing edge like the Mac's.
    static let insets = EdgeInsets(top: 6, leading: 28, bottom: 6, trailing: 16)

    var body: some View {
        let kind = RowStatus.kind(thread)
        HStack(alignment: .center, spacing: 10) {
            ProjectTiles(projects: thread.projects ?? [])
                .overlay(alignment: .leading) {
                    if model.landing.contains(thread.threadId) {
                        // On its way to a new heading: the mark pops in as it lands.
                    } else if done {
                        // Finished with nothing needed: a tick where the
                        // unread dot would be.
                        Image(systemName: "checkmark")
                            .font(.system(size: 9, weight: .bold))
                            .foregroundStyle(Color.accentColor)
                            .frame(width: 10, height: 10)
                            .offset(x: -19)
                            .accessibilityLabel("Done, unread")
                            .transition(Juice.popIn)
                    } else if unread {
                        Circle()
                            .fill(Color.accentColor)
                            .frame(width: 7, height: 7)
                            .offset(x: -17)
                            .accessibilityLabel("Needs you")
                            .transition(Juice.popIn)
                    }
                }
            VStack(alignment: .leading, spacing: 3) {
                Text(thread.title.isEmpty ? "Untitled" : thread.title)
                    .font(.body.weight(emphasised ? .semibold : .regular))
                    .foregroundStyle(.primary)
                    .lineLimit(1)
                HStack(alignment: .firstTextBaseline, spacing: 6) {
                    HStack(alignment: .firstTextBaseline, spacing: 4) {
                        if let startedBy = thread.startedBy {
                            // Mike didn't start it: the mark alone says so,
                            // before the place every row names.
                            Image(systemName: UIImage(systemName: startedBy.symbol) == nil ? "wrench.and.screwdriver" : startedBy.symbol)
                                .font(.footnote)
                                .accessibilityLabel(thread.bylineText ?? startedBy.label)
                        }
                        Text(line2)
                            .font(.subheadline)
                            .lineLimit(1)
                    }
                    .foregroundStyle(.secondary)
                    Spacer(minLength: 6)
                    if asleep {
                        Image(systemName: "moon.zzz").font(.footnote).foregroundStyle(Look.faint).accessibilityLabel("Hibernating")
                    }
                    trailing(kind)
                }
            }
        }
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
    }

    /// The Mac's ThreadRowLook, as far as the phone's row knows: unread
    /// with nothing waiting on Mike is "done" (a tick); needing him, a dot.
    private var done: Bool { RowStatus.kind(thread) == .time && thread.unread && !thread.needsYou }
    private var unread: Bool {
        let kind = RowStatus.kind(thread)
        return kind == .needsYou || (thread.needsYou && kind != .working) || done
    }
    private var emphasised: Bool { thread.needsYou || RowStatus.kind(thread) == .needsYou || done }

    private var line2: String {
        var parts = [thread.placeText]
        // What a hibernating thread waits for, before where it is.
        if let wake = InboxSections.wakeLine(thread, now: model.now) { parts.insert(wake, at: 0) }
        if let runner = model.runnerName(thread.runnerId) { parts.append(runner) }
        if let working = thread.working, thread.isBusy || (thread.pendingApproval == nil && !thread.waitingOnMike) { parts.append(working) }
        return parts.joined(separator: " · ")
    }

    @ViewBuilder private func trailing(_ kind: RowStatus.Kind) -> some View {
        switch kind {
        case .working:
            HStack(alignment: .firstTextBaseline, spacing: 5) {
                ProgressView()
                    .controlSize(.mini)
                    .tint(.accentColor)
                    .alignmentGuide(.firstTextBaseline) { $0[VerticalAlignment.center] + 4 }
                // How long the turn has run, ticking once a second.
                TimelineView(.periodic(from: .now, by: 1)) { context in
                    let elapsed = RowStatus.workingLabel(since: thread.lastActivityAt, now: context.date)
                    Text(underRunning ? elapsed : "Working " + elapsed)
                        .monospacedDigit()
                        .contentTransition(.numericText(countsDown: false))
                        .animation(.default, value: elapsed)
                }
            }
            .font(.footnote.weight(.medium))
            .foregroundStyle(Color.accentColor)
        case .needsYou:
            // The dot before the tile says it, as on the Mac.
            Text(RelativeTime.short(thread.lastActivityAt, now: model.now)).font(.footnote).monospacedDigit().foregroundStyle(Look.faint)
        case .failed:
            Text("Failed").font(.footnote.weight(.medium)).foregroundStyle(Look.failed)
        case .waitingForConnection:
            // Its turn lost the internet; it carries on by itself.
            Text(RowStatus.text(thread, now: model.now)).font(.footnote).foregroundStyle(Look.faint).lineLimit(1)
        case .stopped:
            Text("Stopped").font(.footnote).foregroundStyle(.secondary)
        case .time where thread.woke != nil:
            // Back from hibernating by itself; the time comes back once
            // it's been opened.
            Text(RowStatus.text(thread, now: model.now)).font(.footnote.weight(.medium)).foregroundStyle(Color.accentColor)
        case .time where wake?.nextRunAt != nil:
            // When its schedule messages it next: "10:42", "Mon 10:42".
            Text(RelativeTime.clock(wake?.nextRunAt ?? model.now, now: model.now))
                .font(.footnote).monospacedDigit().foregroundStyle(Look.faint)
                .accessibilityLabel("Scheduled: \(wake?.whenText ?? "")")
        case .time:
            Text(RowStatus.text(thread, now: model.now)).font(.footnote).monospacedDigit().foregroundStyle(Look.faint)
        }
    }
}

/// The inbox's pull, kept apart from InboxView so only the bear redraws as it
/// changes (`PullPeek` has the sums).
@MainActor @Observable
final class PullState {
    private(set) var peek = PullPeek()
    /// Held open while it reconnects: the whole head shows.
    var refreshing = false {
        didSet { if refreshing { ducked = false } }
    }
    /// Gone back down behind the list, until the list is home again.
    var ducked = false
    var blinks = 0
    var nods = 0

    /// The list held open below the search field while it reconnects.
    var holding = false
    /// A finger's on the list.
    var touching = false
    @ObservationIgnored private let tap = UIImpactFeedbackGenerator(style: .light)

    func scrolled(offset: CGFloat, topInset: CGFloat) {
        var next = peek
        next.scrolled(offset: offset, topInset: topInset, refreshing: refreshing)
        if touching, !refreshing, next.pulling(gap: next.gap) {
            // The refresh point: a blink and a light tap, so he knows letting go will do it.
            blinks += 1
            tap.impactOccurred()
        }
        // Every scroll lands here: only a change is news.
        if next != peek { peek = next }
        if ducked, !refreshing, peek.gap == 0 { ducked = false }
    }

    func letGo() -> Bool { peek.letGo() }
}

/// The sat bear's head coming up over the top of the inbox as it's pulled
/// down, in the gap between the search field and the list, as far as the
/// pull goes. Under Reduce Motion it fades in whole rather than rising.
private struct PullPeekBear: View {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    var pull: PullState

    var body: some View {
        let gap = pull.peek.gap
        let rising = pull.refreshing ? PullPeek.head : PullPeek.shown(gap: gap)
        let shown = pull.ducked ? 0 : reduceMotion ? (rising > 0 ? PullPeek.head : 0) : rising
        // The list's first heading has room above its words, so the bear can
        // come up from just behind them.
        let room = gap + 10
        PeekingBear(size: 64, blinks: pull.blinks, nods: pull.nods)
            .foregroundStyle(.secondary)
            .offset(y: room - shown)
            .opacity(reduceMotion && shown == 0 ? 0 : 1)
            .animation(reduceMotion ? .easeOut(duration: 0.15) : nil, value: shown)
            .frame(maxWidth: .infinity, maxHeight: room, alignment: .top)
            .frame(height: room, alignment: .top)
            .clipped()
            .allowsHitTesting(false)
            .opacity(gap > 0 || pull.refreshing ? 1 : 0)
    }
}

/// "Nothing in the inbox". Having just taken the last row away, the bear stands
/// up and gives one wave as the row's collapse finishes, with one soft tap, as the
/// Mac's InboxZero does. Open the app to an empty inbox and it just sits there:
/// it's a reward for clearing it, not a launch animation.
private struct InboxZeroView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var shown: Bool
    @State private var waves = 0
    @State private var taps = 0

    init(celebrating: Bool) {
        // Hidden from the first frame when it's about to rise, or it flashes.
        _shown = State(initialValue: !celebrating)
    }

    var body: some View {
        ContentUnavailableView {
            Label { Text("Nothing in the inbox") } icon: { WaveOnceBear(size: 46, waves: waves) }
        } description: {
            Text("Threads that finish or need you turn up here.")
        }
        .opacity(shown ? 1 : 0)
        .offset(y: shown || reduceMotion ? 0 : 8)
        .sensoryFeedback(.impact(flexibility: .soft, intensity: 0.6), trigger: taps)
        .onAppear {
            // Asked here rather than from the archive call: the List only puts
            // this row in as the last one starts to collapse.
            guard model.takeInboxCleared() else { shown = true; return }
            if reduceMotion {
                withAnimation(.easeOut(duration: 0.2)) { shown = true }
                taps += 1
                return
            }
            // The collapse is 250 ms, then 100 ms, then the snappy rise. Waited for
            // here rather than with the animation's delay: a change made as a
            // List's row appears goes in with its first frame, not animated.
            Task {
                try? await Task.sleep(for: .milliseconds(350))
                withAnimation(.snappy(duration: 0.4)) { shown = true }
                try? await Task.sleep(for: .milliseconds(250))
                waves += 1
                taps += 1
            }
        }
    }
}

/// A small note at the bottom when Convex can't be reached, or a call failed.
struct ConnectionToast: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        Group {
            if !model.connected {
                toast("Reconnecting…", icon: "wifi.slash")
            } else if let error = model.lastError {
                toast(error, icon: "exclamationmark.triangle")
                    .onTapGesture { model.clearError() }
                    .task(id: error) {
                        try? await Task.sleep(for: .seconds(6))
                        model.clearError()
                    }
            }
        }
        .animation(.default, value: model.connected)
        .animation(.default, value: model.lastError)
    }

    private func toast(_ text: String, icon: String) -> some View {
        Label(text, systemImage: icon)
            .font(.footnote)
            .lineLimit(2)
            .padding(.horizontal, 14)
            .padding(.vertical, 10)
            .background(.regularMaterial, in: Capsule())
            .padding(.bottom, 12)
            .padding(.horizontal)
            .transition(.move(edge: .bottom).combined(with: .opacity))
    }
}

extension View {
    /// The Hibernate presets as a dialog, for a swipe or a menu. `leaving` is
    /// for a thread's own page: picking one goes back to the inbox, as archive
    /// does, rather than leaving him on a thread he's just put to sleep.
    func hibernateDialog(for target: Binding<PhoneThread?>, leaving: (() -> Void)? = nil) -> some View {
        modifier(HibernateDialog(target: target, leaving: leaving))
    }
}

private struct HibernateDialog: ViewModifier {
    @Environment(AppModel.self) private var model
    @Binding var target: PhoneThread?
    var leaving: (() -> Void)?

    func body(content: Content) -> some View {
        content.confirmationDialog("Hibernate until", isPresented: Binding(get: { target != nil }, set: { if !$0 { target = nil } }),
                                   titleVisibility: .visible, presenting: target) { thread in
            ForEach(Hibernate.presets(now: .now)) { preset in
                Button(preset.title) { change(thread, .snooze(until: preset.date)) }
            }
            Button("Until the runner restarts") { change(thread, .snoozeUntilRestart) }
        }
    }

    private func change(_ thread: PhoneThread, _ change: ThreadChange) {
        model.hibernate(thread.threadId, change, leavingThread: leaving != nil)
        leaving?()
    }
}

/// Grey placeholder rows, shaped like thread rows, while a list waits for
/// its first answer from Convex, so a list that's loading doesn't look
/// empty.
struct LoadingRows: View {
    var count = 6
    @State private var dim = false

    var body: some View {
        ForEach(0..<count, id: \.self) { i in
            HStack(alignment: .center, spacing: 10) {
                RoundedRectangle(cornerRadius: 5).frame(width: 22, height: 22)
                VStack(alignment: .leading, spacing: 7) {
                    // Varied widths, so it reads as rows of titles rather than bars.
                    Capsule().frame(width: [190, 150, 220, 170, 130, 200][i % 6], height: 11)
                    Capsule().frame(width: [110, 90, 130, 80, 120, 100][i % 6], height: 9)
                }
                Spacer()
                Capsule().frame(width: 24, height: 9)
            }
            .foregroundStyle(Color(.tertiarySystemFill))
            .opacity(dim ? 0.45 : 1)
            .listRowInsets(ThreadRow.insets)
            .listRowSeparator(.hidden)
            .accessibilityHidden(true)
        }
        .onAppear {
            withAnimation(.easeInOut(duration: 0.9).repeatForever(autoreverses: true)) { dim = true }
        }
        .accessibilityElement()
        .accessibilityLabel("Loading threads")
    }
}
