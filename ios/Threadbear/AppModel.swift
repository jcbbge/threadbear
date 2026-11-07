import Foundation
import Observation
import SwiftUI
import ThreadbearKit
import UIKit

/// The app's live state: who it's paired with, the runners and the three
/// thread lists, each a Convex subscription kept open while the app runs.
@MainActor @Observable
final class AppModel {
    private(set) var pairing: Pairing?
    private(set) var backend: (any Backend)?
    private(set) var runners: [PhoneRunner] = []
    /// The projects by id, for the rows' icons (backend API 5 carries them).
    private(set) var projects: [String: PhoneProject] = [:]
    /// The logins and their models (backend API 20), for the new thread pickers.
    private(set) var accounts: [PhoneAccount] = []
    /// The Pocket's cards, from the file until the backend answers, so they
    /// show with no signal.
    private(set) var pocket: [PocketCard] = []
    var showsPocket: Bool { isFake || !pocket.isEmpty || (apiVersion ?? 0) >= BackendCompatibility.pocketAPIVersion }
    /// The newest card's time when the Pocket was last open, for the badge
    /// on its button. Kept on this phone only: it's about what this phone has shown.
    private var pocketSeenUpTo = UserDefaults.standard.string(forKey: "pocketSeenUpTo")
    var pocketHasNew: Bool { PocketDeck.hasNew(pocket, seenUpTo: pocketSeenUpTo) }
    /// `-ThreadbearPocket`: start with the Pocket open, for screenshots and
    /// for checking it on the phone, where nothing can tap the button.
    var opensPocketAtLaunch = false
    var opensSettingsAtLaunch = false
    /// `-ThreadbearRunnerOrder`: Settings' runner order screen, for screenshots.
    let opensRunnerOrderAtLaunch = ProcessInfo.processInfo.arguments.contains("-ThreadbearRunnerOrder")
    private(set) var inbox: [PhoneThread] = []
    /// Rows sliding off the inbox on their way out (`archive`).
    private(set) var slidingOff: Set<String> = []
    /// Archived from this phone, kept out of the lists until Convex says the
    /// runner has done it, which waits for the Mac if it's asleep.
    private var archiving: Set<String> = []
    /// Whether a thread's page is over the inbox (InboxView says).
    @ObservationIgnored var threadOpen = false
    /// Rows sinking towards the Hibernating heading on their way out (`hibernate`).
    private(set) var sinking: Set<String> = []
    /// Hibernated from this phone, kept out of the lists and on the heading's
    /// count until Convex catches up.
    private(set) var tucks = Tucks()
    /// He's just taken the last row away, for the empty view to wave.
    private var inboxCleared = InboxCleared()
    var inboxJustCleared: Bool { inboxCleared.isPending(now: .now) }
    private(set) var hibernating: [PhoneThread] = []
    private(set) var den: [PhoneThread] = []
    /// For each thread a schedule will message, the one due soonest: the
    /// inbox's Waiting section.
    private(set) var wakes: [String: PhoneSchedule] = [:]
    /// How many are hibernating and archived (backend API 16), for the
    /// folded headings. Nil on an older backend.
    private(set) var counts: PhoneCounts?
    /// Which headings are folded, remembered across launches.
    private(set) var folds = SectionFolds(saved: UserDefaults.standard.stringArray(forKey: "foldedSections"))
    /// A search is on: it looks in the put-away lists too, so they load.
    private(set) var searching = false
    /// The live thread lists, one subscription per view that's wanted
    /// (`folds.views`). A folded Hibernating or Archived has none.
    private var listTasks: [ThreadsView: Task<Void, Never>] = [:]
    /// The lists that have had their first answer from Convex. Until then
    /// a list is loading, not empty: saying "Nothing in the inbox" at
    /// launch, before anything had arrived, read as if it was (Mike, 30 Oct).
    private(set) var loaded: Set<ThreadsView> = []
    private(set) var connected = true
    /// The token was refused (expired or revoked): the app shows pairing again.
    private(set) var authProblem: String?
    private(set) var lastError: String?
    /// Set when the Mac's backend is older than this app needs.
    private(set) var backendProblem: String?
    /// The backend's API version once phone:me has answered (nil before).
    private(set) var apiVersion: Int?
    /// Whether threads read phone:messages (API 2) rather than phone:thread's
    /// newest 20 plus the runner's paging.
    var hasMessagePages: Bool { (apiVersion ?? 0) >= BackendCompatibility.messagePagesAPIVersion }

    /// Archived threads past the den's newest 100 with these words in
    /// (API 16). Empty from an older backend, or when the call fails: the
    /// search still shows what the phone has, so a failure isn't worth a toast.
    func searchOlderArchived(_ text: String) async -> [PhoneThread] {
        guard let backend, (apiVersion ?? 0) >= BackendCompatibility.searchAPIVersion else { return [] }
        return (try? await backend.search(text)) ?? []
    }
    /// When this phone is notified, kept on the phone and sent to the backend
    /// with each registration and change (API 3).
    private(set) var notifyMode: NotifyMode = NotifyMode(rawValue: UserDefaults.standard.string(forKey: "notifyMode") ?? "") ?? .away
    /// The setting shows once the backend takes it and notifications are on.
    var canChooseNotifications: Bool {
        !isFake && apnsToken != nil && (apiVersion ?? 0) >= BackendCompatibility.notificationSettingAPIVersion
    }

    /// Whether to ask for notification permission. Only a backend that says
    /// it can't send any stops it: one that can't be reached right now is
    /// asked about as ever.
    func backendSendsNotifications() async -> Bool {
        guard let backend, let identity = try? await backend.me() else { return true }
        return identity.sendsNotifications
    }

    func setNotifyMode(_ mode: NotifyMode) {
        notifyMode = mode
        UserDefaults.standard.set(mode.rawValue, forKey: "notifyMode")
        guard let backend, let apnsToken, !isFake else { return }
        Task {
            do { try await backend.setNotifications(apnsToken: apnsToken, notify: mode) } catch {
                self.lastError = "Couldn't change notifications: \(error.localizedDescription)"
            }
        }
    }
    /// Ticks every 15 s so "5m" and "Mac offline" stay right.
    private(set) var now = Date.now
    /// A thread a notification tap asked for, for the inbox to open.
    var openThreadId: String?
    /// `-ThreadbearCompose <text>` (Debug only): open New thread with this
    /// typed in, for the screenshots.
    var composeText: String?
    /// `-ThreadbearSearch <text>` (Debug only): start with this in the
    /// inbox's search, for the screenshots.
    var searchText: String?
    /// `-ThreadbearPhoto <path>` (Debug only): start the composers with this
    /// photo, for the screenshots, as nothing can tap the system picker.
    /// With `-ThreadbearSlowPhoto` it takes a few seconds, to see the spinner tile.
    var loadSamplePhoto: (@Sendable () async -> Data?)?

    /// Whether this backend takes photos. The demo does, so App Review sees it.
    var canStar: Bool { isFake || (apiVersion ?? 0) >= BackendCompatibility.starsAPIVersion }
    var canSendPhotos: Bool { isFake || (apiVersion ?? 0) >= BackendCompatibility.photosAPIVersion }
    /// Whether a secret card can be answered here (backend API 35, phone:secret).
    var canAnswerSecrets: Bool { isFake || (apiVersion ?? 0) >= BackendCompatibility.secretsAPIVersion }
    /// Whether messages waiting for their runner can be listed and cancelled
    /// (backend API 57, phone:waiting and phone:cancel).
    var canSeeWaiting: Bool { isFake || (apiVersion ?? 0) >= BackendCompatibility.waitingSendsAPIVersion }

    /// The thread's own runner by name while it's offline. Not offlineText,
    /// which only speaks up once every runner is: with Bruce and the cloud
    /// box always up, a message to the sleeping M5 just said "Sending…".
    func offlineRunner(of thread: PhoneThread) -> String? {
        WaitingSends.offlineRunner(thread.runnerId, in: runners, at: now)
    }
    /// The demo's kept runner keys, in memory so it never writes the keychain,
    /// with the sample Mac's as if it came in a pairing link.
    private let demoRunnerKeys = MemoryRunnerKeyStore(FakeBackend.sampleRunnerKeys)
    /// Where the runner keys a secret may be sealed to are kept
    /// (docs/protocol.md, "Trusting the key"), per paired deployment.
    var runnerKeys: any RunnerKeyStore {
        guard !isFake, let pairing else { return demoRunnerKeys }
        return Self.runnerKeys(for: pairing)
    }
    private static func runnerKeys(for pairing: Pairing) -> KeychainRunnerKeyStore {
        KeychainRunnerKeyStore(scope: Pairing.serverName(pairing.deploymentURL))
    }
    /// Threads whose runner is already pinned this session, so a list
    /// arriving doesn't go to the keychain for every row each time.
    private var pinnedThreads = Set<String>()

    /// Pins each listed thread's runner the first time it's seen
    /// (RunnerKeyPins.noteThreads), so a secret card on a thread the
    /// backend later moves to another runner id is refused.
    private func pinRunners(_ list: [PhoneThread]) {
        let fresh = list.filter { !pinnedThreads.contains($0.threadId) }
        guard !fresh.isEmpty else { return }
        RunnerKeyPins.noteThreads(fresh.map { ($0.threadId, $0.runnerId) }, in: runnerKeys)
        pinnedThreads.formUnion(fresh.map(\.threadId))
    }

    /// The models a new thread can start on; empty hides the pickers, as an
    /// older backend would turn an effort down.
    /// The models a new thread on this runner can start on (nil: any runner's).
    func newThreadModels(on runnerId: String?) -> [PhoneModelChoice] {
        isFake || (apiVersion ?? 0) >= BackendCompatibility.modelsAPIVersion ? NewThreadChoices.models(accounts, runnerId: runnerId) : []
    }

    /// Whether there's a runner to choose (backend API 56, which lists them
    /// in Mike's order and keeps one he sets).
    var canChooseRunner: Bool {
        runners.count > 1 && (isFake || (apiVersion ?? 0) >= BackendCompatibility.runnerOrderAPIVersion)
    }

    /// The order last dragged to, until the backend's list comes back in it:
    /// a heartbeat's update in between would otherwise snap the list back,
    /// and the next drag would move the wrong row.
    private var pendingRunnerOrder: [String]?

    /// Puts the runners in this order, here at once and then on the backend,
    /// whose list then comes back the same.
    func setRunnerOrder(_ order: [PhoneRunner]) {
        let ids = order.map(\.runnerId)
        pendingRunnerOrder = ids
        runners = order.map { var r = $0; r.placed = true; return r }
        guard let backend else { return }
        Task {
            do { try await backend.setRunnerOrder(ids) } catch {
                if self.pendingRunnerOrder == ids { self.pendingRunnerOrder = nil }
                self.lastError = "Couldn't save the runner order: \(error.localizedDescription)"
            }
        }
    }

    /// The backend's runners, kept in a dragged order it hasn't caught up with.
    private func receiveRunners(_ list: [PhoneRunner]) {
        guard let pending = pendingRunnerOrder else { runners = list; return }
        // Caught up once its own runners come back in that order; one that's
        // first heartbeated meanwhile is only added at the end.
        if list.map(\.runnerId).filter(pending.contains) == pending.filter(list.map(\.runnerId).contains) {
            pendingRunnerOrder = nil
            runners = list
            return
        }
        let rank = { (r: PhoneRunner) in pending.firstIndex(of: r.runnerId) ?? pending.count }
        runners = list.enumerated().sorted { (rank($0.element), $0.offset) < (rank($1.element), $1.offset) }.map {
            var r = $0.element
            if pending.contains(r.runnerId) { r.placed = true }
            return r
        }
    }

    /// Starts a photo on its way to file storage, if it isn't already. Done
    /// as soon as it's picked, so that Send usually has nothing to wait for.
    /// One started on a connection that's since been replaced (comingBack)
    /// goes again, as its mutation may never answer.
    func startUpload(_ photo: PickedPhoto) {
        guard let backend, photo.upload == nil || photo.uploadConnection != connection else { return }
        let jpeg = photo.jpeg
        photo.uploadConnection = connection
        photo.upload = PhotoUpload(
            upload: { try await backend.uploadPhoto(jpeg) },
            discard: { try? await backend.discardPhoto($0) })
    }

    /// Waits for the photos to be up and returns the storage ids, in order.
    func upload(_ photos: [PickedPhoto]) async throws -> [String] {
        guard backend != nil else { throw TransportError.server("Not connected.") }
        // All of them at once, whatever's left to go.
        photos.forEach(startUpload)
        var ids: [String] = []
        for photo in photos {
            guard let upload = photo.upload else { continue }
            do {
                ids.append(try await upload.storageId)
            } catch {
                // It may have failed back when it was picked, with the signal
                // since come back, so a send gets one fresh try of its own.
                photo.upload = nil
                startUpload(photo)
                do {
                    guard let again = photo.upload else { throw error }
                    ids.append(try await again.storageId)
                } catch {
                    photo.upload = nil
                    throw error
                }
            }
        }
        return ids
    }

    /// They've gone with a message, so they're the backend's to delete now.
    func sent(_ photos: [PickedPhoto]) {
        for photo in photos { photo.upload?.keep() }
    }

    // MARK: Starting threads

    /// New threads asked for from this phone that their runner hasn't made
    /// yet, newest first. The sheet closes as soon as the backend has the
    /// request, and these stand in for them at the top of the inbox: the
    /// runner reports a new thread only once its row is in Convex, which
    /// waits behind any sync it's in the middle of, and on 7 Nov the sheet's
    /// spinner sat there 22 seconds after the M5's runner had restarted.
    private(set) var starting: [StartingThread] = []
    private var startingTasks: [String: Task<Void, Never>] = [:]
    /// A thread that started soon after it was asked for, for the inbox to
    /// open as the sheet used to. One that took longer (its Mac was asleep)
    /// just turns up in the list, rather than pulling you out of what you're on.
    var justStarted: (commandId: String, threadId: String)?
    /// A failed start's sheet, to open again as it was (AppModel.retryStarting).
    var retryDraft: NewThreadDraft?
    /// Only the newest start opens by itself: an earlier one landing while
    /// you wait on the next mustn't take its place.
    private var latestStart: String?

    func started(commandId: String, message: String, draft: NewThreadDraft) {
        starting.insert(StartingThread(id: commandId, message: message, draft: draft, startedAt: .now), at: 0)
        latestStart = commandId
        watchStarting(commandId)
    }

    /// Gone from the list: a failed one dismissed, or tapped to try again.
    func dropStarting(_ id: String) {
        startingTasks.removeValue(forKey: id)?.cancel()
        starting.removeAll { $0.id == id }
    }

    /// A failed one back in the new thread sheet as it was: words, photos,
    /// runner, model and effort. The photos go up again, as the backend
    /// deleted its copies with the failed command.
    func retryStarting(_ row: StartingThread) {
        dropStarting(row.id)
        retryDraft = row.draft
    }

    private func watchStarting(_ id: String) {
        guard let backend else { return }
        startingTasks[id]?.cancel()
        startingTasks[id] = follow(backend.command(id)) { $0.startingChanged(id, $1) }
    }

    private func startingChanged(_ id: String, _ status: CommandStatus?) {
        guard let i = starting.firstIndex(where: { $0.id == id }) else { return }
        if let threadId = status?.threadId {
            let row = starting[i]
            dropStarting(id)
            if id == latestStart, Date.now.timeIntervalSince(row.startedAt) < 60 { justStarted = (id, threadId) }
        } else if status?.state == .failed {
            starting[i].failed = status?.note ?? "The runner couldn't start it."
            for photo in starting[i].draft.photos { photo.upload = nil }
            startingTasks.removeValue(forKey: id)?.cancel()
        } else if status == nil || status?.state == .done {
            // The command's gone from the backend (pruned long after), or
            // done without saying which thread: nothing left to wait for,
            // and the thread, if any, is in the list.
            dropStarting(id)
        }
    }

    private var tasks: [Task<Void, Never>] = []
    private(set) var apnsToken: String?
    /// Bumped each time the Convex connection is rebuilt (comingBack), so
    /// views holding live queries on the old one start them again.
    private(set) var connection = 0
    private var backgroundedAt: Date?
    /// On the sample threads (FakeBackend) rather than a real deployment:
    /// the demo from the pair screen, or `-ThreadbearFake` for screenshots.
    private(set) var isFake = false

    init() {
        let args = ProcessInfo.processInfo.arguments
        opensPocketAtLaunch = args.contains("-ThreadbearPocket")
        // `-ThreadbearSettings`: start on Settings, for screenshots.
        opensSettingsAtLaunch = args.contains("-ThreadbearSettings")
        if args.contains("-ThreadbearFake") {
            // -ThreadbearSlowLoad: the lists answer after a few seconds, to see the loading rows.
            // -ThreadbearPictures: and a thread with pictures, "pics".
            // -ThreadbearDiagrams: and one with a mermaid diagram and an html block.
            // -ThreadbearLong: and a very long thread, "long".
            // -ThreadbearSecret: and a thread waiting on a secret card, "secret".
            // -ThreadbearRunners: the Mac asleep and two more runners, for the runner picker.
            // -ThreadbearOffline: the Mac's been asleep for hours, so messages wait, and a3 has two waiting.
            let offline = args.contains("-ThreadbearOffline")
            let fake = FakeBackend(runnerOnline: !offline, listDelay: args.contains("-ThreadbearSlowLoad") ? .seconds(6) : .zero, pictures: args.contains("-ThreadbearPictures"), long: args.contains("-ThreadbearLong"), secret: args.contains("-ThreadbearSecret"), diagrams: args.contains("-ThreadbearDiagrams"), runners: args.contains("-ThreadbearRunners"), queued: offline)
            // -ThreadbearSlowStart: a new thread takes a minute to start, so its Starting row stays.
            if args.contains("-ThreadbearSlowStart") { fake.startDelay = .seconds(60) }
            // -ThreadbearShortInbox: one thread in the inbox, one running, one of each put away.
            if args.contains("-ThreadbearShortInbox") { fake.keepOnly(["a4", "a5", "a6", "a7"]) }
            // -ThreadbearEmptyInbox: nothing in the inbox from the start, one running.
            if args.contains("-ThreadbearEmptyInbox") { fake.keepOnly(["a5", "a6", "a7"]) }
            // -ThreadbearFinishSoon: the running thread's turn ends after a while, to see its row move.
            // -ThreadbearSlowAnswers: answers to cards take a few seconds to reach the "runner".
            if args.contains("-ThreadbearSlowAnswers") { fake.answerDelay = .seconds(3) }
            // -ThreadbearRefuseAnswers: and it refuses them.
            if args.contains("-ThreadbearRefuseAnswers") { fake.answerDelay = .seconds(3); fake.answersFail = true }
            if args.contains("-ThreadbearFinishSoon") { fake.finishRunningThread(after: .seconds(14)) }
            connect(fake, pairing: nil)
        } else if let saved = PairingStore.load() {
            connect(ConvexBackend(deploymentURL: saved.deploymentURL, token: saved.token), pairing: saved)
        }
        #if DEBUG
        // `-ThreadbearPair <link>`: pair on launch, since the simulator asks
        // "Open in Threadbear?" for links from outside and nothing can tap it.
        if let i = args.firstIndex(of: "-ThreadbearPair"), i + 1 < args.count, let link = URL(string: args[i + 1]) {
            Task { await pair(with: link) }
        }
        // `-ThreadbearOpen <threadId>`: start on that thread, for screenshots.
        if let i = args.firstIndex(of: "-ThreadbearOpen"), i + 1 < args.count { openThreadId = args[i + 1] }
        if let i = args.firstIndex(of: "-ThreadbearCompose"), i + 1 < args.count { composeText = args[i + 1] }
        if let i = args.firstIndex(of: "-ThreadbearSearch"), i + 1 < args.count { searchText = args[i + 1] }
        // `-ThreadbearStart <text>`: start a thread with it, as the sheet's Start does.
        if let i = args.firstIndex(of: "-ThreadbearStart"), i + 1 < args.count, let backend {
            let text = args[i + 1]
            Task {
                guard let id = try? await backend.create(text: text, runnerId: nil, cwd: nil, images: [], settings: NewThreadSettings(model: nil, effort: nil)) else { return }
                started(commandId: id, message: text, draft: NewThreadDraft(text: text, photos: []))
            }
        }
        if let i = args.firstIndex(of: "-ThreadbearPhoto"), i + 1 < args.count {
            let sample = FileManager.default.contents(atPath: args[i + 1])
            let slow = args.contains("-ThreadbearSlowPhoto")
            loadSamplePhoto = {
                if slow { try? await Task.sleep(for: .seconds(20)) }
                return sample
            }
        }
        #endif
        Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(15))
                self?.now = .now
            }
        }
    }

    var isPaired: Bool { backend != nil && authProblem == nil }

    var sections: InboxSections { sections(of: inbox) }

    private func sections(of list: [PhoneThread]) -> InboxSections {
        InboxSections.build(list.filter { !archiving.contains($0.threadId) && !tucks.hidden.contains($0.threadId) }, now: now, wakes: wakes)
    }

    /// A pasted thread id as the `[title](thread:<id>)` link it goes in as,
    /// for a thread this phone has a row for (inbox, hibernating, archived),
    /// or nil to paste the words. Same as the Mac's composer.
    func threadReference(pasted: String) -> String? {
        let known = inbox + hibernating + den
        func title(_ id: String) -> String? { known.first { $0.threadId == id }?.title }
        guard let id = CardMentions.pastedThreadId(pasted, known: { title($0) != nil }) else { return nil }
        return CardMentions.threadReference(id: id, title: title(id) ?? "")
    }

    /// Archives a thread, gone from the inbox at once. `leavingThread` is for
    /// its own page, which is popping back to the inbox: the row waits for
    /// the page to clear, then slides off where he can see it go (Mike, 31
    /// Oct). The command is only sent once the row has gone, as the runner
    /// can answer within the animation and a list update would snap it away.
    func archive(_ threadId: String, leavingThread: Bool = false) {
        guard let backend, !archiving.contains(threadId), !slidingOff.contains(threadId) else { return }
        UIImpactFeedbackGenerator(style: .light).impactOccurred()
        // Hibernating threads can be archived from their page but have no inbox row to animate.
        let hasRow = inbox.contains { $0.threadId == threadId }
        Task {
            if hasRow, leavingThread {
                try? await Task.sleep(for: .milliseconds(420))
                withAnimation(.easeIn(duration: 0.24)) { _ = slidingOff.insert(threadId) }
                try? await Task.sleep(for: .milliseconds(240))
            }
            // The Mac may have archived it during the wait; an id that's not
            // in the list would never get cleared by the next list update.
            if inbox.contains(where: { $0.threadId == threadId }) {
                takeOffInbox { _ = archiving.insert(threadId) }
            }
            slidingOff.remove(threadId)
            do {
                // With a deadline: on a client replaced meanwhile it may never
                // answer, and the row would stay hidden with nothing watching.
                let command = try await Deadline.run(seconds: 20) { try await backend.update(threadId: threadId, change: .archive) }
                if let status = await commandOutcome(command), status.state == .failed {
                    throw TransportError.server(status.note ?? "The runner couldn't archive that thread.")
                }
            } catch {
                withAnimation(.snappy(duration: 0.25)) { _ = archiving.remove(threadId) }
                report(error)
            }
        }
    }

    /// How a command ended: failed or done, or nil once it's gone from the
    /// backend. On whichever Convex client is current, so a reconnect partway
    /// through (coming back, a pull to refresh) doesn't leave it watching one
    /// that may never answer, and a subscription that errors is tried again.
    func commandOutcome(_ commandId: String) async -> CommandStatus? {
        final class Seen { var status: CommandStatus?? ; var ended = false }
        while !Task.isCancelled {
            guard let backend else { return nil }
            let on = connection, seen = Seen()
            let watch = Task {
                do {
                    for try await status in backend.command(commandId) where status == nil || status?.state == .failed || status?.state == .done {
                        seen.status = .some(status)
                        return
                    }
                } catch {}
                seen.ended = true
            }
            while seen.status == nil, !seen.ended, connection == on, !Task.isCancelled {
                try? await Task.sleep(for: .milliseconds(250))
            }
            watch.cancel()
            if let status = seen.status { return status }
            if seen.ended, connection == on { try? await Task.sleep(for: .seconds(2)) }
        }
        return nil
    }

    /// Cards answered from this phone, by approval id, until the card goes:
    /// kept here rather than in the card, so leaving the thread and coming back
    /// doesn't offer the buttons again while the answer's on its way.
    private(set) var cardAnswers: [String: CardAnswer] = [:]
    /// Secret cards whose answer didn't go through, and which it was ("save"
    /// or "decline"), for the card to say so, even opened again later.
    private(set) var refusedSecrets: [String: String] = [:]

    /// Sends a card's answer with its button spinning. False if one's already
    /// on its way. The spinner stays until the card goes; it gives up if the
    /// runner refuses, or took it and the row still hasn't said so after a few
    /// seconds, or the backend never answers the send (a replaced client).
    @discardableResult
    func answerCard(_ approvalId: String, choice: String, secret: Bool = false,
                    send: @escaping @Sendable (any Backend) async throws -> String, sent: @escaping (String) -> Void = { _ in }) -> Bool {
        guard let backend, cardAnswers[approvalId] == nil else { return false }
        cardAnswers[approvalId] = CardAnswer(choice: choice)
        refusedSecrets[approvalId] = nil
        Task {
            do {
                let command = try await Deadline.run(seconds: 20) { try await send(backend) }
                sent(command)
                let status = await commandOutcome(command)
                if status?.state == .done { try? await Task.sleep(for: .seconds(5)) }
                if status?.state == .failed, secret { refusedSecrets[approvalId] = choice }
            } catch {
                // A secret card says it in its own words, but a refused token
                // still goes to pairing.
                if case TransportError.unauthorized = error { report(error) }
                else if secret { refusedSecrets[approvalId] = choice } else { report(error) }
            }
            cardAnswers[approvalId] = nil
        }
        return true
    }

    /// Hibernates a thread, as `archive` archives one, but the row sinks rather
    /// than slides: archive goes sideways, this goes down towards its heading,
    /// whose count rolls on and whose moon bounces as the row leaves. A starred
    /// thread stays under Starred with a moon, and one only waiting on a schedule
    /// is under Hibernating already, so neither has anywhere to sink to.
    func hibernate(_ threadId: String, _ change: ThreadChange, leavingThread: Bool = false) {
        guard let backend, !archiving.contains(threadId), !slidingOff.contains(threadId),
              !sinking.contains(threadId), !tucks.hidden.contains(threadId) else { return }
        UIImpactFeedbackGenerator(style: .light).impactOccurred()
        func hasRow() -> Bool { (sections.inbox + sections.running).contains { $0.threadId == threadId } }
        let sinks = hasRow()
        Task {
            if sinks {
                try? await Task.sleep(for: .milliseconds(280))
                if leavingThread {
                    // SwiftUI holds the page's dismiss until the dialog has
                    // gone, which can be half a second, so the wait for the
                    // page to clear starts when it really starts to leave.
                    let giveUp = Date.now.addingTimeInterval(1.5)
                    while threadOpen, Date.now < giveUp { try? await Task.sleep(for: .milliseconds(30)) }
                    try? await Task.sleep(for: .milliseconds(420))
                }
                withAnimation(.easeIn(duration: 0.24)) { _ = sinking.insert(threadId) }
                try? await Task.sleep(for: .milliseconds(240))
                // The Mac may have moved it during the wait; `tucks` only
                // lets go of an id when a list update says so.
                if hasRow() {
                    takeOffInbox { tucks.tuck(threadId) }
                }
                // Not until it's collapsed: back at full opacity, the row
                // going away would show again on its way out.
                Task {
                    try? await Task.sleep(for: .milliseconds(300))
                    sinking.remove(threadId)
                }
            }
            do {
                let command = try await Deadline.run(seconds: 20) { try await backend.update(threadId: threadId, change: change) }
                if let status = await commandOutcome(command), status.state == .failed {
                    throw TransportError.server(status.note ?? "The runner couldn't hibernate that thread.")
                }
            } catch {
                withAnimation(.snappy(duration: 0.25)) { tucks.undo(threadId) }
                report(error)
            }
        }
    }

    /// A row he's taken away collapsing, which may be the last: only this
    /// counts as clearing the inbox, so the bear never waves at a launch or when
    /// the Mac empties it.
    private func takeOffInbox(_ change: () -> Void) {
        let before = sections
        withAnimation(.snappy(duration: 0.25)) {
            change()
            // In the same breath, as the empty view reads it when it's made.
            inboxCleared.note(before: before, after: sections, now: .now)
        }
    }

    /// Whether to wave, once: the empty view asks as it appears.
    func takeInboxCleared() -> Bool { inboxCleared.take(now: .now) }

    func toggle(_ section: PhoneSection) {
        folds.toggle(section)
        UserDefaults.standard.set(folds.saved, forKey: "foldedSections")
        followLists()
    }

    func setSearching(_ on: Bool) {
        guard on != searching else { return }
        searching = on
        followLists()
    }

    /// How many threads a folded heading hides: the list when it's loaded,
    /// else phone:counts'. Nil when neither knows.
    func count(_ section: PhoneSection) -> Int? {
        switch section {
        case .starred: sections.starred.count
        case .inbox: sections.inbox.count
        case .running: sections.running.count
        // Folded, the snoozed ones aren't loaded, but the scheduled ones come
        // from the inbox list, so they're added to phone:counts' number.
        case .hibernating: (loaded.contains(.hibernating) ? hibernatingRows.count : (counts?.hibernating).map { $0 + sections.scheduled.count }).map { $0 + tucks.uncounted }
        // The den list is capped at 100; the count isn't.
        case .archived: counts?.den ?? (loaded.contains(.den) ? den.count : nil)
        }
    }

    /// Under Hibernating: the threads waiting on a schedule and the snoozed
    /// ones, soonest to wake first, as on the Mac.
    var hibernatingRows: [PhoneThread] {
        InboxSections.hibernating(scheduled: sections.scheduled, snoozed: loaded.contains(.hibernating) ? hibernating : [], wakes: wakes)
    }

    func threads(_ section: PhoneSection) -> [PhoneThread] {
        switch section {
        case .starred: sections.starred
        case .inbox: sections.inbox
        case .running: sections.running
        case .hibernating: hibernatingRows
        case .archived: den
        }
    }

    /// Rows on their way to a new heading, whose tick or dot waits until they're
    /// there: it's the row arriving that says the thread's finished.
    private(set) var landing: Set<String> = []

    private func popMarksAfterLanding() {
        Task {
            try? await Task.sleep(for: Juice.landing)
            withAnimation(Juice.pop) { landing = [] }
        }
    }

    /// Starts a subscription for each list now wanted and stops the rest,
    /// dropping what a stopped one had so it isn't shown stale later.
    private func followLists() {
        guard let backend else { return }
        let wanted = folds.views(searching: searching)
        for (view, task) in listTasks where !wanted.contains(view) {
            task.cancel()
            listTasks[view] = nil
            loaded.remove(view)
            switch view {
            case .inbox: inbox = []
            case .hibernating: hibernating = []
            case .den: den = []
            }
        }
        for view in wanted where listTasks[view] == nil {
            let usesChanges = view == .inbox && (apiVersion ?? 0) >= BackendCompatibility.threadChangesAPIVersion
            listTasks[view] = follow(usesChanges ? backend.inboxChanges() : backend.threads(view)) { model, list in
                model.pinRunners(list)
                switch view {
                case .inbox:
                    // Watching the phone while the Mac works, a row gliding up is
                    // a thread finishing. Only for a change of heading, and not
                    // the first answer, so a title or a working line changing
                    // leaves the list still under his thumb.
                    let (old, new) = (model.sections, model.sections(of: list))
                    let glides = model.loaded.contains(.inbox) && old.changedHeadings(to: new)
                    withAnimation(glides ? Juice.rows : nil) {
                        model.inbox = list
                        // Gone from the list means it's done, so a later unarchive shows.
                        model.archiving.formIntersection(list.map(\.threadId))
                        model.tucks.inboxArrived(list, now: .now)
                        if glides { model.landing.formUnion(old.landed(in: new)) }
                    }
                    if glides { model.popMarksAfterLanding() }
                    model.inboxAnswers += 1
                case .hibernating: model.hibernating = list
                case .den: model.den = list
                }
                model.loaded.insert(view)
            }
        }
    }

    /// "Mac offline since 10:42" when no runner has checked in for three
    /// minutes. Things done meanwhile wait until it's back.
    var offlineText: String? {
        guard !runners.isEmpty, !runners.contains(where: { $0.isOnline(at: now) }) else { return nil }
        let newest = runners.max { $0.lastSeenAt < $1.lastSeenAt }!
        let name = runners.count == 1 ? "Mac" : newest.name
        return "\(name) offline since \(RelativeTime.clock(newest.lastSeenAt, now: now))"
    }

    func project(_ id: String) -> PhoneProject? { projects[id] }

    func runnerName(_ runnerId: String) -> String? {
        runners.count > 1 ? runners.first { $0.runnerId == runnerId }?.name : nil
    }

    // MARK: Pairing

    #if DEBUG
    private static let allowLocalPairing = true // the simulator against `npx convex dev` on this Mac
    #else
    private static let allowLocalPairing = false
    #endif

    /// A pairing link waiting for Mike's yes (ThreadbearApp's alert).
    let pairingGate = PairingGate()
    /// A yes is being checked with the server, for the pair screen's spinner.
    private(set) var isPairing = false

    /// Every pairing link, from the Camera, the pair screen's scanner or the
    /// clipboard, starts here: it's held for a yes and nothing is saved yet,
    /// paired or not (an expired token used to let a link straight in).
    func askToPair(_ link: URL) {
        lastError = nil
        switch pairingGate.ask(link, allowLocal: Self.allowLocalPairing, current: pairing ?? PairingStore.load(),
                               keys: { Self.runnerKeys(for: $0) }) {
        case .asking: break
        case .notPairing: lastError = "That link isn't a Threadbear pairing link."
        case .busy: lastError = "Answer the pairing question first, then open the link again."
        }
    }

    /// Mike said yes to `shown`. Synchronous, so the request is taken before
    /// the alert's dismissal cancels the gate.
    func acceptPairing(_ shown: PairingRequest) {
        pairingGate.accept(shown) { [weak self] request in await self?.pair(with: request.link) }
    }

    /// From a `threadbear://pair` link Mike said yes to (or `-ThreadbearPair`
    /// in a Debug build): checks the token works before keeping it.
    private func pair(with link: URL) async {
        guard let pairing = Pairing.parse(link, allowLocal: Self.allowLocalPairing) else {
            lastError = "That link isn't a Threadbear pairing link."
            return
        }
        isPairing = true
        defer { isPairing = false }
        let backend = ConvexBackend(deploymentURL: pairing.deploymentURL, token: pairing.token)
        do {
            _ = try await backend.me()
            PairingStore.save(pairing)
            // The Macs a secret may be sealed to: only these, from the QR
            // code the Mac drew, never ones the mirror names.
            RunnerKeyPins.pinFromPairing(pairing.runnerKeys, in: Self.runnerKeys(for: pairing))
            connect(backend, pairing: pairing)
        } catch {
            lastError = "The server didn't accept that token: \(error.localizedDescription)"
        }
    }

    /// "Look around with sample threads" on the pair screen. The app is no
    /// use until it's paired with a Mac, so this is how App Review (and
    /// anyone curious) sees it working, on made-up threads that never leave
    /// the phone. Not remembered: a relaunch goes back to pairing.
    func startDemo() {
        lastError = nil
        connect(FakeBackend(), pairing: nil)
    }

    /// Back to the pair screen. A pairing saved before the demo (one whose
    /// token was refused) is left as it was.
    func leaveDemo() {
        stop()
        pocket = []
        pocketSeenUpTo = UserDefaults.standard.string(forKey: "pocketSeenUpTo")
        backend = nil
        starting = []
        isFake = false
        runners = []
        projects = [:]
        accounts = []
        inbox = []
        tucks = Tucks()
        hibernating = []
        den = []
        wakes = [:]
        counts = nil
        loaded = []
    }

    func markPocketSeen() {
        let seen = PocketDeck.seenUpTo(pocket, after: pocketSeenUpTo)
        guard seen != pocketSeenUpTo else { return }
        pocketSeenUpTo = seen
        // The demo's cards aren't yours, so looking at them mustn't count.
        if !isFake { UserDefaults.standard.set(seen, forKey: "pocketSeenUpTo") }
    }

    func removePocketCard(_ card: PocketCard) {
        guard let backend else { return }
        // Gone at once, and back if the backend wouldn't have it.
        let before = pocket
        pocket.removeAll { $0.id == card.id }
        Task {
            do { try await backend.removePocketCard(id: card.id) } catch {
                pocket = before
                lastError = error.localizedDescription
            }
        }
    }

    func unpair() {
        PocketStore.standard.clear()
        pocket = []
        UserDefaults.standard.removeObject(forKey: "pocketSeenUpTo")
        pocketSeenUpTo = nil
        PairingStore.clear()
        // Pairing again keeps the runner keys its link carries afresh.
        KeychainRunnerKeyStore.clearAll()
        pinnedThreads = []
        stop()
        backend = nil
        starting = []
        pairing = nil
        authProblem = nil
        backendProblem = nil
        apiVersion = nil
        runners = []
        projects = [:]
        accounts = []
        inbox = []
        tucks = Tucks()
        hibernating = []
        den = []
        wakes = [:]
        counts = nil
        loaded = []
    }

    func wentToBackground() { backgroundedAt = .now }

    /// iOS suspends the app soon after it leaves the screen, and the
    /// WebSocket under convex-swift doesn't come back from that: the lists
    /// already showing stay as they were, and anything subscribed afterwards
    /// (opening a thread) waits forever, with no "Reconnecting…" because the
    /// client still thinks it's connected. Mike, 31 Oct: the inbox showed but
    /// no thread opened, and not one phone call had reached Convex in two
    /// hours. So back from the background, a fresh client.
    func comingBack() {
        defer { backgroundedAt = nil }
        guard let since = backgroundedAt, Date.now.timeIntervalSince(since) > 5, !isFake else { return }
        freshConnection()
    }

    /// Pulling the inbox down: a fresh Convex client, as coming back from the
    /// background has, and back once the inbox has answered on it (or a few
    /// seconds have gone), so the list holds open while it really reconnects.
    /// It used to wait 400 ms and do nothing. The demo follows its sample
    /// threads again, as there's no client to replace.
    func reconnect() async {
        let answered = inboxAnswers
        guard freshConnection() else { return }
        let giveUp = Date.now.addingTimeInterval(6)
        while inboxAnswers == answered, Date.now < giveUp { try? await Task.sleep(for: .milliseconds(50)) }
    }

    /// Answers the inbox list has had, on any connection, for `reconnect`.
    @ObservationIgnored private var inboxAnswers = 0

    @discardableResult
    private func freshConnection() -> Bool {
        guard authProblem == nil, let backend else { return false }
        let kept = loaded
        if isFake {
            connect(backend, pairing: nil, registerPush: false)
        } else {
            guard let pairing else { return false }
            connect(ConvexBackend(deploymentURL: pairing.deploymentURL, token: pairing.token), pairing: pairing, registerPush: false)
        }
        // What's on screen stays until the fresh answers replace it, rather
        // than flashing the loading rows.
        loaded = kept
        connection += 1
        return true
    }

    private func connect(_ backend: any Backend, pairing: Pairing?, registerPush: Bool = true) {
        stop()
        // Another deployment (or the demo) has its own pins.
        pinnedThreads = []
        self.backend = backend
        self.pairing = pairing
        isFake = backend is FakeBackend
        authProblem = nil
        if !isFake { pocket = PocketStore.standard.load() }
        tasks.append(follow(backend.runners()) { $0.receiveRunners($1) })
        tasks.append(follow(backend.projects()) { model, list in
            // Two runners could use the same id; the first one wins.
            model.projects = Dictionary(list.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })
        })
        loaded = []
        followLists()
        tasks.append(follow(backend.accounts()) { $0.accounts = $1 })
        tasks.append(follow(backend.schedules()) { $0.wakes = InboxSections.wakes($1) })
        tasks.append(Task { [weak self] in
            for await up in backend.connectionStates() { self?.connected = up }
        })
        tasks.append(Task { [weak self] in
            guard let identity = try? await backend.me() else { return }
            self?.backendProblem = BackendCompatibility.problem(identity)
            self?.apiVersion = identity.apiVersion ?? 0
            // The inbox started before this was known: over to following its
            // changes. The list on screen stays until the new one answers.
            if (identity.apiVersion ?? 0) >= BackendCompatibility.threadChangesAPIVersion, !Task.isCancelled, let self {
                self.listTasks[.inbox]?.cancel()
                self.listTasks[.inbox] = nil
                self.followLists()
            }
            // An older backend has no phone:counts, and asking would only
            // fail and retry.
            if (identity.apiVersion ?? 0) >= BackendCompatibility.countsAPIVersion, !Task.isCancelled, let self {
                self.tasks.append(self.follow(backend.counts()) { model, counts in
                    model.tucks.countsArrived(old: model.counts?.hibernating, new: counts.hibernating)
                    model.counts = counts
                })
            }
            if (identity.apiVersion ?? 0) >= BackendCompatibility.pocketAPIVersion, !Task.isCancelled, let self {
                self.tasks.append(self.follow(backend.pocket()) { model, cards in
                    model.pocket = cards
                    if !model.isFake { PocketStore.standard.save(cards) }
                })
            }
        })
        for row in starting where row.failed == nil { watchStarting(row.id) }
        if registerPush, let apnsToken { register(apnsToken) }
    }

    private func stop() {
        tasks.forEach { $0.cancel() }
        tasks = []
        // Followed again on the new connection (connect), unless it's unpairing.
        startingTasks.values.forEach { $0.cancel() }
        startingTasks = [:]
        listTasks.values.forEach { $0.cancel() }
        listTasks = [:]
    }

    /// Keeps a live query going: on a network error it waits and
    /// subscribes again; a refused token stops everything.
    private func follow<T: Sendable>(_ stream: @autoclosure @escaping () -> AsyncThrowingStream<T, Error>,
                                     _ apply: @escaping (AppModel, T) -> Void) -> Task<Void, Never> {
        Task { [weak self] in
            var delay: Duration = .seconds(1)
            while !Task.isCancelled {
                do {
                    for try await value in stream() {
                        guard let self else { return }
                        apply(self, value)
                        delay = .seconds(1)
                    }
                    return
                } catch TransportError.unauthorized(let message) {
                    self?.authProblem = message
                    return
                } catch {
                    self?.lastError = error.localizedDescription
                    try? await Task.sleep(for: delay)
                    delay = min(delay * 2, .seconds(30))
                }
            }
        }
    }

    // MARK: Push

    func didRegister(apnsToken token: Data) {
        let hex = token.map { String(format: "%02x", $0) }.joined()
        apnsToken = hex
        register(hex)
    }

    private func register(_ hex: String) {
        guard let backend, !isFake else { return }
        // A development-signed build (every install-phone.sh build) talks to
        // APNs' sandbox; an App Store build would say production.
        let environment = Bundle.main.object(forInfoDictionaryKey: "ThreadbearAPSEnvironment") as? String == "production"
            ? "production" : "sandbox"
        Task {
            // The relay key goes to a backend that takes it (API 4); an older
            // one would refuse the extra argument.
            if apiVersion == nil, let identity = try? await backend.me() { apiVersion = identity.apiVersion ?? 0 }
            let pushKey = (apiVersion ?? 0) >= BackendCompatibility.pushKeyAPIVersion ? PushKeyStore.loadOrCreate()?.base64EncodedString() : nil
            do { try await backend.registerDevice(apnsToken: hex, environment: environment, pushKey: pushKey) } catch {
                self.lastError = "Couldn't turn on notifications: \(error.localizedDescription)"
                return
            }
            // A backend before API 3 has no setting; it notifies every time.
            try? await backend.setNotifications(apnsToken: hex, notify: self.notifyMode)
        }
    }

    /// A finished quick ask, kept as a thread by the runner (backend API 10). The thread's id once
    /// it's made; nil if the runner hasn't taken it within a while (the Mac's asleep), in which
    /// case it's made when the runner's back.
    func keepQuickAsk(_ record: QuickAskRecord) async throws -> String? {
        guard let backend else { throw TransportError.server("Pair with your Mac to keep answers as threads.") }
        if let apiVersion, apiVersion < BackendCompatibility.quickAskAPIVersion {
            throw TransportError.server("Update Threadbear on your Mac to keep answers as threads.")
        }
        let commandId = try await backend.quickAsk(record)
        return try await withThrowingTaskGroup(of: String?.self) { group in
            group.addTask {
                for try await status in backend.command(commandId) {
                    if let threadId = status?.threadId { return threadId }
                    if status?.state == .failed { throw TransportError.server(status?.note ?? "The runner couldn't keep it.") }
                }
                return nil
            }
            group.addTask {
                try await Task.sleep(for: .seconds(30))
                return nil
            }
            let first = try await group.next() ?? nil
            group.cancelAll()
            return first
        }
    }

    /// Reply buttons pressed from this phone, by "<threadId> <buttonId>",
    /// until the row says so itself: on the way (`status` nil) or the
    /// command's state. A row outside the live tail may never catch up.
    private(set) var presses: [String: CommandStatus?] = [:]

    func pressLook(_ button: MessageButton, in threadId: String) -> ReplyButtons.Look {
        let press = presses["\(threadId) \(button.id)"]
        return ReplyButtons.look(button, status: press ?? nil, asking: press != nil && (press ?? nil) == nil)
    }

    /// A tap on a reply button: presses it once (a second tap while it's
    /// on its way does nothing), or once pressed, opens the thread it
    /// started or messaged if this phone has a row for it.
    func tap(_ button: MessageButton, in threadId: String, pushThread: @MainActor (String) -> Void) {
        switch pressLook(button, in: threadId) {
        case .pressing:
            return
        case let .pressed(id):
            guard let id else { return }
            if (inbox + hibernating + den).contains(where: { $0.threadId == id }) { pushThread(id) } else { report(TransportError.server("That thread isn't on this phone yet.")) }
            return
        case .ready, .failed:
            break
        }
        guard let backend else { return }
        let key = "\(threadId) \(button.id)"
        presses[key] = .some(nil)
        Task {
            do {
                let command = try await backend.press(threadId: threadId, buttonId: button.id)
                for try await status in backend.command(command) {
                    guard let status, status.state == .done || status.state == .failed else { continue }
                    presses[key] = status
                    return
                }
            } catch {
                presses[key] = CommandStatus(state: .failed, note: (error as? LocalizedError)?.errorDescription ?? error.localizedDescription)
            }
        }
    }

    func clearError() { lastError = nil }

    func report(_ error: Error) {
        if case let TransportError.unauthorized(message) = error { authProblem = message } else {
            lastError = error.localizedDescription
        }
    }
}

/// The pairing, in the Keychain (the token) and UserDefaults (the URL).
/// Quick Ask's lesson: a setup flow for another source overwrote its
/// Keychain token, so the token here is keyed by deployment and nothing
/// else ever writes it.
enum PairingStore {
    private static let urlKey = "pairing.deploymentURL"
    private static let service = "com.mikecann.threadbear.token"

    static func load() -> Pairing? {
        guard let raw = UserDefaults.standard.string(forKey: urlKey), let url = URL(string: raw),
              let token = Keychain.read(service: service, account: Pairing.serverName(url)) else { return nil }
        return Pairing(deploymentURL: url, token: token)
    }

    static func save(_ pairing: Pairing) {
        let account = Pairing.serverName(pairing.deploymentURL)
        Keychain.write(pairing.token, service: service, account: account)
        UserDefaults.standard.set(pairing.deploymentURL.absoluteString, forKey: urlKey)
    }

    static func clear() {
        if let pairing = load() {
            Keychain.delete(service: service, account: Pairing.serverName(pairing.deploymentURL))
        }
        UserDefaults.standard.removeObject(forKey: urlKey)
    }
}

enum Keychain {
    static func read(service: String, account: String) -> String? {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service,
            kSecAttrAccount as String: account, kSecReturnData as String: true,
        ]
        var item: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &item) == errSecSuccess, let data = item as? Data else { return nil }
        return String(data: data, encoding: .utf8)
    }

    static func write(_ value: String, service: String, account: String) {
        delete(service: service, account: account)
        let item: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service,
            kSecAttrAccount as String: account, kSecValueData as String: Data(value.utf8),
            // Readable after the first unlock, so a notification tap on a
            // locked-then-unlocked phone finds it.
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
        ]
        SecItemAdd(item as CFDictionary, nil)
    }

    static func delete(service: String, account: String) {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
        SecItemDelete(query as CFDictionary)
    }
}

/// A card's answer on its way (AppModel.cardAnswers): which button was tapped.
struct CardAnswer {
    var choice: String
}

/// A new thread on its way (AppModel.starting): what was asked, until the
/// runner has made it, or why it couldn't.
struct StartingThread: Identifiable {
    /// The create command's id.
    let id: String
    /// What went to the runner, photos as "Picture 1" chips' text.
    let message: String
    /// The sheet as it was, for trying again if it fails.
    let draft: NewThreadDraft
    let startedAt: Date
    var failed: String?
}

/// What the new thread sheet had in it when Start was tapped.
struct NewThreadDraft {
    var text: String
    var photos: [PickedPhoto]
    /// Nil when the backend picks (only one runner).
    var runnerId: String?
    var modelId: String?
    var effort: String?
}
