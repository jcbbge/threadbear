import AppKit
import ThreadbearCore

/// What the schedule editor sheet is editing: a new schedule (from the
/// Scheduled view, or a composer's draft) or one that exists.
struct ScheduleEditorState: Identifiable, Equatable {
    let id = UUID()
    /// The schedule being edited; nil for a new one.
    var scheduleId: String?
    var text = ""
    var title = ""
    var once = false
    var at = Date()
    var repeatChoice = RepeatChoice()
    /// Sends here; nil starts a new thread each time.
    var threadId: String?
    /// The thread it was opened from, which "This thread" means. Nil from
    /// the Scheduled view or the new-thread composer.
    var fromThreadId: String?
    /// Settings for a new thread each time, as the composer would use.
    var cwd = ""
    var accountId: String?
    /// The composer's pool, which then picks each run's login rather than
    /// the one it happened to be on (`accountId` goes unsent).
    var poolId: String?
    var model: String?
    var effort: String?
    var ask = false
    /// Another runner it runs on (`runners.list`); nil is this one. Only
    /// for a new thread each time. There the folder is a path on that
    /// runner's Mac, typed as is ("" for its default folder), and the
    /// account and model are left to it: its accounts aren't this Mac's.
    var runnerId: String?
    /// That runner's name, for an existing schedule's read-only line.
    var runnerName: String?
    /// The composer draft it came from, emptied once it's saved.
    var draftKey: String?
    /// Images in that draft, which a schedule can't send.
    var draftImages = 0

    var isNew: Bool { scheduleId == nil }
    /// Runs on another runner's Mac.
    var isAway: Bool { runnerId != nil }
    var when: ScheduleWhen { once ? .at(at) : .cron(repeatChoice.cron) }
}

extension AppModel {
    // MARK: Loading

    /// The list after hello; `schedules.updated` replaces it from then on.
    func loadSchedules() {
        guard let client else { return }
        Task {
            do {
                schedules = try await client.listSchedules()
                schedulesSupported = true
            } catch RPCError.server(let code, _) where code == RPCError.methodNotFound {
                // A runner from before schedules.
                schedulesSupported = false
                schedules = []
                showsScheduledHome = false
            } catch {
                AppLog.write("rpc", "schedules.list failed: \(error.localizedDescription)")
            }
        }
    }

    /// Where a schedule can run. Asked at hello and again as the editor
    /// opens, so who's offline is fresh when it matters.
    func loadRunners() {
        guard let client else { return }
        Task {
            do {
                runners = try await client.listRunners()
            } catch {
                AppLog.write("rpc", "runners.list failed: \(error.localizedDescription)")
            }
        }
    }

    /// The Runners panel's refresh button: its icon spins, and it says if
    /// the runners couldn't be read.
    func refreshRunners() {
        guard let client else { return }
        whileBusy(BusyKey.refreshRunners) { [self] in
            do {
                runners = try await client.listRunners()
            } catch {
                show(error)
            }
        }
    }

    /// Every runner's latest figures, for the Runners panel's details.
    func loadRunnerStats() {
        guard let client else { return }
        Task {
            do {
                let list = try await client.runnerStats()
                let byId = Dictionary(list.map { ($0.runnerId, $0) }, uniquingKeysWith: { a, b in a.at > b.at ? a : b })
                if byId != runnerStats { runnerStats = byId }
                runnerStatsAsked = true
            } catch {
                AppLog.write("rpc", "runners.stats failed: \(error.localizedDescription)")
            }
        }
    }

    /// The runner this app talks to, as the backend knows it.
    var selfRunnerId: String? { runners.first(where: \.isSelf)?.id }

    /// The other runner a schedule runs on, by name; nil when it's this one.
    func awayRunnerName(_ schedule: Schedule) -> String? {
        guard schedule.runsElsewhere(than: selfRunnerId), let runnerId = schedule.runnerId else { return nil }
        return schedule.runnerName ?? runners.first { $0.id == runnerId }?.name ?? "another Mac"
    }

    /// The SF Symbol of the runner a schedule runs on.
    func runnerIcon(_ schedule: Schedule) -> String {
        RunnerIcon.symbol(schedule.runnerIcon ?? runners.first { $0.id == schedule.runnerId }?.icon)
    }

    /// This runner's own, for "This Mac" in the picker.
    var selfRunnerIcon: String { RunnerIcon.symbol(runners.first(where: \.isSelf)?.icon) }
}

/// A runner's icon (`RunnerInfo.icon`) as a symbol this Mac can draw: one
/// named by a runner on a newer macOS, or none at all from a runner before
/// icons, is the plain desktop.
enum RunnerIcon {
    static let fallback = "desktopcomputer"

    static func symbol(_ name: String?) -> String {
        guard let name, NSImage(systemSymbolName: name, accessibilityDescription: nil) != nil else { return fallback }
        return name
    }
}

extension AppModel {

    var activeScheduleCount: Int { schedules.reduce(0) { $0 + ($1.isActive ? 1 : 0) } }

    func schedule(_ id: String) -> Schedule? { schedules.first { $0.id == id } }

    /// Where a schedule sends: its thread's title, or "New thread in misc".
    func scheduleTarget(_ schedule: Schedule) -> String {
        if let threadId = schedule.threadId {
            guard let thread = threads[threadId] else { return "A thread that's gone" }
            return thread.title.isEmpty ? "Untitled" : thread.title
        }
        if awayRunnerName(schedule) != nil {
            // That Mac's default folder isn't known here.
            return schedule.cwd.map { "New thread in \(FolderName.short($0))" } ?? "New thread"
        }
        return "New thread in \(FolderName.short(schedule.cwd ?? defaults.cwd))"
    }

    /// The Scheduled view in the sidebar, and its page in the detail area.
    func showSchedules() {
        sidebarMode = .scheduled
        openProjectId = nil
        showsScheduledHome = true
    }

    // MARK: The editor

    /// A new schedule. From a composer it starts with the draft and that
    /// composer's thread (or, from the new-thread composer, a new thread
    /// each time on the composer's folder, account and model).
    func newSchedule(from thread: ThreadSummary?, draftKey: String? = nil) {
        let settings = ThreadSettings(app: self, thread: thread)
        var state = ScheduleEditorState()
        if let draftKey, let draft = drafts[draftKey] {
            // Pictures can't go with a schedule, so their chips stay out of its words.
            state.text = InlinePictures.words(draft.text).trimmingCharacters(in: .whitespacesAndNewlines)
            state.draftImages = draft.images.count
            state.draftKey = draftKey
        }
        state.at = ScheduleTime.defaultOnce(now: Date())
        state.threadId = thread?.id
        state.fromThreadId = thread?.id
        state.cwd = draftKey == nil ? defaults.cwd : settings.cwd
        state.accountId = settings.account
        state.poolId = settings.pool?.id
        state.model = settings.model
        state.effort = settings.effort
        // The editor only offers Ask or Full; Auto carries over as the safer one.
        state.ask = settings.permissionMode != .full
        scheduleEditor = state
        loadRunners()
    }

    func editSchedule(_ id: String) {
        guard let schedule = schedule(id) else { return }
        var state = ScheduleEditorState(scheduleId: id)
        state.text = schedule.text
        state.title = schedule.title
        state.once = schedule.isOneOff
        state.at = schedule.at ?? ScheduleTime.defaultOnce(now: Date())
        if let cron = schedule.cron { state.repeatChoice = RepeatChoice(cron: cron) }
        state.threadId = schedule.threadId
        if let name = awayRunnerName(schedule) {
            state.runnerId = schedule.runnerId
            state.runnerName = name
            state.cwd = schedule.cwd ?? ""
        } else {
            state.cwd = schedule.cwd ?? defaults.cwd
        }
        scheduleEditor = state
        loadRunners()
    }

    /// Makes or updates the schedule. Returns the runner's reason when it
    /// says no, for the sheet to show (it stays open).
    func saveSchedule(_ state: ScheduleEditorState) async -> String? {
        guard let client, connection == .connected else { return "Not connected to the runner." }
        let text = state.text.trimmingCharacters(in: .whitespacesAndNewlines)
        let title = state.title.trimmingCharacters(in: .whitespacesAndNewlines)
        do {
            let saved: Schedule
            if let id = state.scheduleId {
                saved = try await client.updateSchedule(id, ScheduleUpdate(
                    title: title.isEmpty ? nil : title, text: text, when: state.when,
                    cwd: state.threadId == nil ? state.cwd.trimmingCharacters(in: .whitespacesAndNewlines) : nil
                ))
            } else if state.isAway && state.threadId == nil {
                // Its folder is sent as typed and checked on that Mac when
                // it runs; this Mac's account, model and effort mean
                // nothing there, so they're left to that runner's defaults.
                let cwd = state.cwd.trimmingCharacters(in: .whitespacesAndNewlines)
                saved = try await client.createSchedule(NewScheduleRequest(
                    text: text, title: title.isEmpty ? nil : title, when: state.when,
                    cwd: cwd.isEmpty ? nil : cwd, permissionMode: state.ask ? .ask : .full, runnerId: state.runnerId
                ))
            } else {
                saved = try await client.createSchedule(NewScheduleRequest(
                    text: text, title: title.isEmpty ? nil : title, when: state.when, threadId: state.threadId,
                    cwd: state.cwd, accountId: state.accountId, poolId: state.poolId, model: state.model, effort: state.effort,
                    permissionMode: state.ask ? .ask : .full
                ))
            }
            replace(saved)
            if let key = state.draftKey {
                // Images can't go with a schedule, so they stay in the box.
                if var draft = drafts[key], !draft.images.isEmpty {
                    draft.text = ""
                    drafts[key] = draft
                } else {
                    drafts[key] = nil
                }
            }
            return nil
        } catch {
            AppLog.write("rpc", "saving a schedule failed: \(error.localizedDescription)")
            return error.localizedDescription
        }
    }

    /// What the runner makes of a time as it's typed: its words and the
    /// next runs, or why it can't read it.
    func previewSchedule(_ when: ScheduleWhen) async -> Result<SchedulePreview, PreviewError> {
        guard let client else { return .failure(PreviewError(message: "Not connected to the runner.")) }
        do {
            return .success(try await client.previewSchedule(when))
        } catch {
            return .failure(PreviewError(message: error.localizedDescription))
        }
    }

    struct PreviewError: Error, Equatable {
        var message: String
    }

    // MARK: Row actions

    /// Another runner's schedule comes back queued, with `runRequestedAt`
    /// set, which its row shows until that runner has run it. The row spins
    /// until the reply.
    func runSchedule(_ id: String) {
        guard let client else { return }
        whileBusy(BusyKey.runSchedule(id)) { [self] in
            do {
                replace(try await client.runSchedule(id).schedule)
            } catch {
                show(error)
            }
        }
    }

    /// Shows at once, and goes back if the runner refuses. The control waits
    /// for one to land before taking another, so two can't overlap: if both
    /// failed, the second's rollback would leave the first's guess showing.
    func setSchedulePaused(_ id: String, _ paused: Bool) {
        let key = BusyKey.pauseSchedule(id)
        guard let client, !isBusy(key) else { return }
        let before = schedule(id)
        var guess = before
        guess?.paused = paused
        if let guess { replace(guess) }
        whileBusy(key) { [self] in
            do {
                replace(try await client.updateSchedule(id, ScheduleUpdate(paused: paused)))
            } catch {
                if let before, schedule(id) == guess { replace(before) }
                show(error)
            }
        }
    }

    /// Asks first: a deleted schedule can't be got back.
    func deleteSchedule(_ id: String) {
        guard let client, let schedule = schedule(id) else { return }
        let alert = NSAlert()
        alert.messageText = "Delete \u{201C}\(schedule.title)\u{201D}?"
        alert.informativeText = "It won't send its message again."
        alert.addButton(withTitle: "Delete")
        alert.addButton(withTitle: "Cancel")
        guard alert.runModal() == .alertFirstButtonReturn else { return }
        if scheduleEditor?.scheduleId == id { scheduleEditor = nil }
        confirmedDeleteSchedule(id, client: client)
    }

    /// Gone at once, and back where it was if the runner refuses.
    func confirmedDeleteSchedule(_ id: String, client: RPCClient) {
        guard let schedule = schedule(id) else { return }
        let index = schedules.firstIndex { $0.id == id } ?? 0
        schedules.removeAll { $0.id == id }
        Task {
            do {
                try await client.deleteSchedule(id)
                schedules.removeAll { $0.id == id }
            } catch {
                if self.schedule(id) == nil { schedules.insert(schedule, at: min(index, schedules.count)) }
                show(error)
                // It may have gone through and only the reply been lost.
                loadSchedules()
            }
        }
    }

    /// A reply's schedule goes in straight away; `schedules.updated` brings
    /// the whole list (in order) a moment later anyway.
    private func replace(_ schedule: Schedule) {
        if let index = schedules.firstIndex(where: { $0.id == schedule.id }) {
            schedules[index] = schedule
        } else {
            schedules.insert(schedule, at: 0)
        }
    }
}
