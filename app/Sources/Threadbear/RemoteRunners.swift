import AppKit
import ThreadbearCore

/// Other runners' threads (docs/protocol.md, "Other runners' threads").
/// Their sidebar rows come from this Mac's runner, which reads them from
/// the backend, and sit in `threads` beside this Mac's own, marked with
/// `runnerId`, so the sidebar, the header and the composer take them as
/// they are. Opening one connects to its own runner, and every request
/// about it goes there (`client(for:)`). The connection closes again a
/// minute after none of that runner's threads is on screen.
extension AppModel {
    // MARK: The list

    /// The list after hello; `remoteThreads.updated` replaces it from then on.
    func loadRemoteThreads() {
        guard let client else { return }
        Task {
            do {
                receive(remote: try await client.remoteThreads())
            } catch {
                AppLog.write("rpc", "remoteThreads.list failed: \(error.localizedDescription)")
            }
        }
    }

    func receive(remote: RemoteThreads) {
        remoteIndex = remote
        if remoteRunners != remote.runners { remoteRunners = remote.runners }
        applyRemoteIndex()
        applyDefaultRunner()
    }

    /// Puts the table's rows in `threads`, except where that runner's own
    /// connection has given a fuller summary, and lets go of rows that have
    /// gone from it (deleted there).
    func applyRemoteIndex() {
        var next = threads
        var listed: Set<String> = []
        for summary in remoteIndex.summaries {
            // Never in place of one of this Mac's own.
            if let existing = next[summary.id], !existing.isRemote { continue }
            listed.insert(summary.id)
            madeRemote.remove(summary.id)
            if liveRemote.contains(summary.id), next[summary.id] != nil { continue }
            next[summary.id] = summary
        }
        let gone = next.values.filter { $0.isRemote && !listed.contains($0.id) && !liveRemote.contains($0.id) && !madeRemote.contains($0.id) }.map(\.id)
        if next != threads { threads = next }
        for id in gone { forget(id) }
    }

    func isRemote(_ threadId: String) -> Bool { threads[threadId]?.isRemote == true }

    /// Another runner's thread reached through this Mac's runner and Convex
    /// (the default), not a connection of its own.
    func viaRelay(_ threadId: String) -> Bool { isRemote(threadId) && !directRemoteLink }

    /// Another runner's thread on a connection of its own (the direct link).
    func viaDirectLink(_ threadId: String) -> Bool { isRemote(threadId) && directRemoteLink }

    func route(_ threadId: String) -> ThreadRoute { ThreadRoute.of(threads[threadId], runners: remoteRunners) }

    /// The logins a thread's pickers offer: its runner's. This Mac's for its
    /// own threads; another runner's once its connection has said hello,
    /// nil until then (the composer shows just that Mac's name). A new
    /// thread's are those of the runner it's for (`newThreadLogins`).
    func logins(for thread: ThreadSummary?) -> RunnerLogins? {
        guard let thread else { return newThreadLogins }
        guard let runnerId = thread.runnerId else { return RunnerLogins(accounts: accounts, pools: pools, defaults: defaults) }
        return remoteLogins[runnerId]
    }

    /// The runner one of another runner's threads lives on, if it's listed.
    func remoteRunner(of thread: ThreadSummary) -> RemoteRunner? {
        guard let id = thread.runnerId else { return nil }
        return remoteRunners.first { $0.id == id }
    }

    /// "bruce", for another runner's thread; nil for this Mac's own.
    func runnerName(of thread: ThreadSummary) -> String? {
        guard thread.isRemote else { return nil }
        return remoteRunner(of: thread)?.name ?? "another Mac"
    }

    /// The SF Symbol for the runner a thread lives on, as the schedule
    /// editor draws runners.
    func runnerIcon(of thread: ThreadSummary) -> String { RunnerIcon.symbol(remoteRunner(of: thread)?.icon) }

    /// "On bruce", and whether it's offline, for a remote row's tooltip.
    func runnerPlace(of thread: ThreadSummary) -> String? {
        guard let name = runnerName(of: thread) else { return nil }
        return remoteRunner(of: thread)?.online == false ? "On \(name), offline" : "On \(name)"
    }

    // MARK: Routing

    /// Where a thread's requests go, without connecting: this Mac's runner
    /// for its own threads (and with no thread), the thread's runner while
    /// it's connected, else nil.
    func client(for threadId: String?) -> RPCClient? {
        guard let threadId, !viaRelay(threadId) else { return client }
        return remoteClients.client(for: route(threadId), local: client)
    }

    /// The same, connecting to the thread's runner if need be. Throws
    /// `RemoteUnreachable` when it can't be reached from this Mac.
    func openClient(for threadId: String) async throws -> RPCClient {
        if viaRelay(threadId) {
            guard let client else { throw RPCError.disconnected(nil) }
            if let runnerId = threads[threadId]?.runnerId, remoteLogins[runnerId] == nil { loadRelayLogins(runnerId) }
            return client
        }
        switch route(threadId) {
        case .local:
            guard let client else { throw RPCError.disconnected(nil) }
            return client
        case .remote(let runner):
            return try await remoteClients.client(for: runner)
        case .unknownRunner(let id):
            throw RemoteUnreachable(runnerId: id, runnerName: "its runner", online: false, reason: .unknownRunner)
        }
    }

    /// For something done to a thread from its sidebar row. It needn't be
    /// open, and another runner's connection only lasts while one of its
    /// threads is on screen, so this connects if need be. Only a change of
    /// selection sets off the close, so this has to as well, or a connection
    /// opened just for this would stay until the next one.
    func rowClient(for threadId: String) async throws -> RPCClient {
        let client = try await openClient(for: threadId)
        if isRemote(threadId) { tidyRemoteClients() }
        return client
    }

    /// What the banner says when a send can't go.
    func notConnectedText(_ threadId: String?, _ what: String) -> String {
        if let thread = threadId.flatMap({ threads[$0] }), let name = runnerName(of: thread) {
            return "Not connected to \(name), so \(what). It's still in the box."
        }
        return "Not connected to the runner, so \(what). It's still in the box."
    }

    /// Opens the thread's runner's connection again for a transcript that's
    /// still loaded; its subscription comes back with it (`remoteConnected`).
    /// One that can't says so where the transcript was.
    func reconnectRemote(for threadId: String) {
        Task {
            do {
                _ = try await openClient(for: threadId)
            } catch {
                loadedSession(threadId)?.markUnreachable(error)
            }
        }
    }

    /// In the main panel or a panel of its own.
    func isOnScreen(_ threadId: String) -> Bool {
        selection == threadId || dock.layout.contains(WindowDock.threadPanel(threadId))
    }

    /// Closes connections to runners none of whose threads is on screen, a
    /// minute after the last one went, so going back and forth between
    /// threads doesn't connect each time.
    func tidyRemoteClients() {
        guard !remoteClients.connectedRunners.isEmpty else { return }
        remoteTidy?.cancel()
        remoteTidy = Task { [weak self] in
            try? await Task.sleep(for: .seconds(60))
            guard let self, !Task.isCancelled else { return }
            var showing = Set(self.threads.values.filter { self.isOnScreen($0.id) }.compactMap(\.runnerId))
            // A new thread being written for it needs it too.
            if let draft = self.newThreadRunnerId { showing.insert(draft) }
            for id in self.remoteClients.connectedRunners where !showing.contains(id) {
                AppLog.write("connection", "closing the connection to \(self.remoteName(id)): none of its threads is open")
                self.remoteClients.close(id)
            }
        }
    }

    // MARK: New threads on another runner

    /// "Runs on" in the new-thread composer: nil for this Mac. Another
    /// runner's connection is opened now, so its hello fills the pickers
    /// with its logins before Mike sends. The folder, login and pool
    /// picked so far were this Mac's, so they go back to that runner's
    /// defaults (and this Mac's when he comes back to it).
    func chooseNewThreadRunner(_ runnerId: String?, byMike: Bool = true) {
        if byMike { newThreadRunnerPicked = true }
        guard runnerId != newThreadRunnerId else { return }
        newThreadRunnerId = runnerId
        newThreadRunnerProblem = nil
        newThreadCwd = nil
        newThreadAccount = nil
        newThreadPool = nil
        newThreadProvider = nil
        guard let runnerId else { return tidyRemoteClients() }
        guard directRemoteLink else { return loadRelayLogins(runnerId) }
        Task {
            do {
                guard let runner = remoteRunners.first(where: { $0.id == runnerId }) else {
                    throw RemoteUnreachable(runnerId: runnerId, runnerName: "that Mac", online: false, reason: .unknownRunner)
                }
                _ = try await remoteClients.client(for: runner)
            } catch {
                guard newThreadRunnerId == runnerId else { return }
                newThreadRunnerProblem = Self.remoteFileReason(error)
            }
        }
    }

    /// Makes `runnerId` (nil: this Mac) the default, and the runner the
    /// draft in front of Mike starts on.
    func setDefaultRunner(_ runnerId: String?) {
        defaultRunnerId = runnerId
        newThreadRunnerPicked = false
        applyDefaultRunner()
    }

    /// The default runner, if it can take a new thread now (listed, online,
    /// and paired with this Mac), else this Mac. Nothing happens once Mike
    /// has picked one for this draft himself.
    func applyDefaultRunner() {
        guard !newThreadRunnerPicked else { return }
        chooseNewThreadRunner(defaultRunnerReady ? defaultRunnerId : nil, byMike: false)
    }

    /// The default is another runner that a new thread can go to now.
    var defaultRunnerReady: Bool {
        guard let id = defaultRunnerId, let runner = remoteRunners.first(where: { $0.id == id }) else { return false }
        return runner.online && (!directRemoteLink || runner.tokenFile != nil)
    }

    /// The runner a new thread will be made on, when it isn't this Mac.
    var newThreadRunner: RemoteRunner? { newThreadRunnerId.flatMap { id in remoteRunners.first { $0.id == id } } }

    /// Folders a new thread on another runner might start in: its default
    /// and the folders of its threads this Mac lists, newest first. Paths
    /// on that Mac, so nothing here is checked.
    func remoteFolders(_ runnerId: String) -> [String] {
        var seen = Set<String>()
        let defaultFolder = remoteLogins[runnerId]?.defaults.cwd ?? ""
        let recent = threads.values.filter { $0.runnerId == runnerId }.sorted { $0.lastActivityAt > $1.lastActivityAt }.map(\.cwd)
        return ([defaultFolder] + recent).filter { !$0.isEmpty && seen.insert($0).inserted }
    }

    /// Makes the new thread on that runner, over its connection, with what
    /// the composer's chips say (that runner's logins, a folder on that
    /// Mac). It's listed as that runner's from the start, so its calls go
    /// there, and opened as a new thread here is. If the runner can't be
    /// reached the draft stays and the banner says why.
    func sendNewThread(on runnerId: String, text: String, draft: Draft) {
        let name = remoteRunners.first { $0.id == runnerId }?.name ?? "that Mac"
        // Through Convex this Mac's runner uploads pictures for that one to
        // fetch; over the direct link they'd be paths it hasn't got.
        let images = draft.normalized.images
        guard images.isEmpty || !directRemoteLink else {
            errorMessage = "Pictures can't go to \(name) over the direct link yet."
            return
        }
        ActivityRecorder.shared.sent(threadId: nil, images: images.count, answers: 0)
        creatingThread = true
        Task {
            defer { creatingThread = false }
            do {
                guard let runner = remoteRunners.first(where: { $0.id == runnerId }) else {
                    throw RemoteUnreachable(runnerId: runnerId, runnerName: name, online: false, reason: .unknownRunner)
                }
                var request = newThreadRequest(text: text, images: images)
                let made0: ThreadSummary
                if directRemoteLink {
                    made0 = try await remoteClients.client(for: runner).createThread(request)
                } else {
                    // Through this Mac's runner, as a command for that one.
                    guard let client else { throw RPCError.disconnected(nil) }
                    request.runnerId = runnerId
                    made0 = try await client.createThread(request)
                }
                var made = made0
                if drafts["new"] == draft { drafts["new"] = nil }
                // The runner, folder, "Ask before edits" and picks were for
                // this thread; the next starts on the defaults again,
                // the default runner's included (applyDefaultRunner below).
                newThreadRunnerId = nil
                newThreadRunnerPicked = false
                newThreadRunnerProblem = nil
                newThreadCwd = nil
                newThreadPermission = .full
                newThreadAccount = nil
                newThreadPool = nil
                newThreadProvider = nil
                made.runnerId = runnerId
                // Its own connection's summaries keep a direct one fresh; a
                // relayed one waits for the sidebar table's row.
                if directRemoteLink { liveRemote.insert(made.id) } else { madeRemote.insert(made.id) }
                threads[made.id] = made
                select(made.id)
                applyDefaultRunner()
            } catch let unreachable as RemoteUnreachable {
                // The draft never left the box.
                newThreadRunnerProblem = unreachable.detail
                errorMessage = unreachable.headline + " " + unreachable.detail + " It's still in the box."
            } catch {
                // Not this Mac's runner's banner: it's that one that failed.
                AppLog.write("rpc", "threads.create on \(name) failed: \(error.localizedDescription)")
                errorMessage = "Couldn't start it on \(name). \(error.localizedDescription)"
            }
        }
    }

    // MARK: Through Convex

    /// That runner's logins for the pickers, from Convex through this Mac's
    /// runner, when the direct link isn't there to say hello.
    func loadRelayLogins(_ runnerId: String) {
        guard let client else { return }
        Task {
            do {
                let logins = try await client.remoteLogins(runnerId: runnerId)
                guard !directRemoteLink else { return }
                remoteLogins[runnerId] = logins
                if newThreadRunnerId == runnerId { newThreadRunnerProblem = nil }
            } catch {
                AppLog.write("rpc", "remoteThreads.logins for \(remoteName(runnerId)) failed: \(error.localizedDescription)")
                if newThreadRunnerId == runnerId { newThreadRunnerProblem = error.localizedDescription }
            }
        }
    }

    /// The direct link went on or off: other runners' open threads read
    /// afresh the other way, and connections of their own close.
    func switchedRemoteLink() {
        AppLog.write("connection", directRemoteLink ? "other machines' threads: direct" : "other machines' threads: through Convex")
        let remote = openSessions.filter { isRemote($0.threadId) }
        // They were this Mac's runner's to watch: tell it they're not. Direct
        // ones go with their connections.
        if directRemoteLink, let client {
            for session in remote where session.subscribed {
                let threadId = session.threadId
                Task { try? await client.unsubscribe(threadId: threadId) }
            }
        }
        remoteClients.closeAll()
        liveRemote.removeAll()
        remoteLogins.removeAll()
        applyRemoteIndex()
        let width = transcript.width > 0 ? transcript.width : transcript.currentTableWidth
        for session in remote {
            if isOnScreen(session.threadId) { session.reload(width: width) } else { dropSession(session.threadId) }
        }
        if let runnerId = newThreadRunnerId {
            newThreadRunnerId = nil
            chooseNewThreadRunner(runnerId, byMike: newThreadRunnerPicked)
        }
    }

    // MARK: Connections

    func wireRemoteClients() {
        remoteClients.onNotification = { [weak self] runnerId, notification in self?.receiveRemote(notification, from: runnerId) }
        remoteClients.onConnected = { [weak self] runnerId, client in self?.remoteConnected(runnerId, client) }
        remoteClients.onClosed = { [weak self] runnerId in self?.remoteClosed(runnerId) }
        remoteClients.onLog = { AppLog.write("remote", $0) }
    }

    private func remoteName(_ runnerId: String) -> String { remoteRunners.first { $0.id == runnerId }?.name ?? runnerId }

    /// What that runner says about its own threads reaches them as this
    /// runner's does about its; the rest (its accounts, schedules,
    /// settings) is that Mac's business.
    private func receiveRemote(_ notification: RPCNotification, from runnerId: String) {
        switch notification {
        case .threadUpdated(var thread):
            // Never in place of one of this Mac's own.
            if let existing = threads[thread.id], existing.runnerId != runnerId { return }
            thread.runnerId = runnerId
            liveRemote.insert(thread.id)
            receive(thread)
        case .threadEvent(let threadId, let event):
            guard threads[threadId]?.runnerId == runnerId else { return }
            loadedSession(threadId)?.receive(event)
        case .threadDeleted(let threadId):
            guard threads[threadId]?.runnerId == runnerId else { return }
            liveRemote.remove(threadId)
            forget(threadId)
        // Its own logins, for the pickers on its threads.
        case .accountsUpdated(let list):
            remoteLogins[runnerId]?.accounts = list
        case .poolsUpdated(let list):
            remoteLogins[runnerId]?.pools = list
        default:
            break
        }
    }

    private func remoteConnected(_ runnerId: String, _ client: RPCClient) {
        AppLog.write("connection", "connected to \(remoteName(runnerId))")
        if newThreadRunnerId == runnerId { newThreadRunnerProblem = nil }
        Task {
            // Its logins (accounts with their models, pools, defaults) fill
            // the composer's pickers on its threads; its accounts.updated
            // and pools.updated keep them current.
            if let hello = try? await client.hello(version: Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "dev"), remoteClients.connected(runnerId) === client {
                remoteLogins[runnerId] = RunnerLogins(hello: hello)
            }
            // Its own summaries are fuller than the table's rows (seqs, the
            // open card, the permission), and its thread.updated keeps
            // them fresh while it's connected.
            if let list = try? await client.listThreads(include: [.inbox, .snoozed]), remoteClients.connected(runnerId) === client {
                var next = threads
                for var thread in list {
                    if let existing = next[thread.id], existing.runnerId != runnerId { continue }
                    thread.runnerId = runnerId
                    liveRemote.insert(thread.id)
                    next[thread.id] = thread
                }
                if next != threads { threads = next }
            }
            // A transcript still loaded from before picks up where it was.
            for session in openSessions where session.state == .loaded && threads[session.threadId]?.runnerId == runnerId {
                await session.subscribe()
            }
        }
    }

    private func remoteClosed(_ runnerId: String) {
        AppLog.write("connection", "the connection to \(remoteName(runnerId)) ended")
        for thread in threads.values where thread.runnerId == runnerId { liveRemote.remove(thread.id) }
        for session in openSessions where threads[session.threadId]?.runnerId == runnerId {
            guard isOnScreen(session.threadId) else {
                // Read afresh when it's next opened.
                dropSession(session.threadId)
                continue
            }
            session.connectionLost()
            // A Mac waking up or a blip on the tailnet: one more go, then
            // it says it can't reach it.
            Task { [weak self, weak session] in
                try? await Task.sleep(for: .seconds(2))
                guard let self, let session, self.loadedSession(session.threadId) === session, !session.subscribed else { return }
                self.reconnectRemote(for: session.threadId)
            }
        }
        applyRemoteIndex()
    }
}
