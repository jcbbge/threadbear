import AppKit
import BearDock
import Observation
import ThreadbearCore

// Which thread is open, and the sessions that load threads into memory.
// Split out of AppModel.swift (4 Nov 2026) as a plain move.
extension AppModel {
    // MARK: Selection and sessions

    func select(_ threadId: String?) {
        // A thread open in a panel of its own is shown there: its panel
        // comes to the front and the main panel stays as it is.
        if let threadId, dock.layout.contains(WindowDock.threadPanel(threadId)) {
            dock.show(WindowDock.threadPanel(threadId))
            return
        }
        // Voice talks with the thread on screen: going to another ends it.
        if VoiceMode.shared.isOn, VoiceMode.shared.threadId != threadId { VoiceMode.shared.stop() }
        selection = threadId
        openProjectId = nil
        showsProjectsHome = false
        showsLibrarianHome = false
        showsScheduledHome = false
        stopShowingSubagent()
        guard let threadId else { return }
        let session = session(for: threadId)
        if session.state == .idle || session.state.isFailed {
            session.open(width: transcript.width > 0 ? transcript.width : transcript.currentTableWidth)
        } else if isRemote(threadId), !session.subscribed {
            // Its runner's connection closed while it was away.
            reconnectRemote(for: threadId)
        }
        // Looked at now, so `woke` is on its way out: the note's bear needs telling first.
        if threads[threadId]?.woke != nil { session.wakeUpPending = true }
        if let thread = threads[threadId], thread.needsYou || thread.lastSeq > thread.lastSeenSeq {
            scheduleMarkSeen(threadId)
        }
        servePanelRequest()
    }

    /// Opens a thread from a chip in a reply, showing it in the inbox
    /// (with Archive or Hibernating unfolded for one that's put away).
    func openThread(_ threadId: String) {
        guard let thread = threads[threadId] else { return }
        if thread.isArchived {
            showArchive()
        } else if thread.isSnoozed(at: Date()), !thread.isStarred {
            showHibernating()
        } else {
            sidebarMode = .inbox
        }
        select(threadId)
    }

    /// Next Inbox Thread (⌥⌘↓): the thread below the open one in the Inbox
    /// section, or the Inbox's first when the open one is elsewhere (Starred,
    /// Running, put away, a project, nothing). Past the last one, or with an
    /// empty Inbox, a note says so instead.
    func nextInboxThread() {
        let inbox = sections.inbox.map(\.id)
        guard let next = SidebarOrder.nextInInbox(after: selection, inbox: inbox) else {
            archivedNote = nil
            milestoneNote = nil
            inboxEndNote = InboxEndNote(empty: inbox.isEmpty)
            return
        }
        inboxEndNote = nil
        sidebarMode = .inbox
        // A folded Inbox has no row to show it by.
        collapsedSections.remove(.inbox)
        select(next)
        revealSelectionRequests &+= 1
    }

    func dismissInboxEndNote(_ id: UUID) {
        if inboxEndNote?.id == id { inboxEndNote = nil }
    }

    /// Shows a sub-agent's transcript. Its thread becomes the selection.
    func selectSubagent(threadId: String, subagentId: String) {
        let ref = SubagentRef(threadId: threadId, subagentId: subagentId)
        if selection != threadId { select(threadId) }
        subagentSelection = ref
        let session = subagentSession(for: ref)
        if session.state == .idle || session.state.isFailed {
            session.open(width: transcript.width > 0 ? transcript.width : transcript.currentTableWidth)
        } else {
            session.refreshSubagent()
        }
        pollSubagent(ref)
    }

    func subagentSession(for ref: SubagentRef) -> ThreadSession {
        if let existing = subagentSessions[ref.key] {
            existing.lastUsed = Date()
            return existing
        }
        let session = ThreadSession(threadId: ref.threadId, subagentId: ref.subagentId, app: self)
        subagentSessions[ref.key] = session
        // Old ones go; reading them again is cheap.
        if subagentSessions.count > 6, let oldest = subagentSessions.filter({ $0.key != ref.key }).min(by: { $0.value.lastUsed < $1.value.lastUsed }) {
            subagentSessions[oldest.key] = nil
        }
        return session
    }

    var selectedSubagent: Subagent? {
        guard let ref = subagentSelection else { return nil }
        return threads[ref.threadId]?.subagents.first { $0.id == ref.subagentId }
    }

    func stopShowingSubagent() {
        subagentSelection = nil
        subagentPoll?.cancel()
        subagentPoll = nil
    }

    /// thread.updated says when a sub-agent has done something, but a
    /// thinking step doesn't change its summary, so while it runs its
    /// transcript is also read every 3 s. Once it has finished, one last
    /// read picks up its reply and the polling stops.
    private func pollSubagent(_ ref: SubagentRef) {
        subagentPoll?.cancel()
        subagentPoll = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(3))
                guard let self, !Task.isCancelled, self.subagentSelection == ref else { return }
                let running = self.selectedSubagent?.isRunning ?? false
                self.subagentSessions[ref.key]?.refreshSubagent()
                if !running { return }
            }
        }
    }

    func session(for threadId: String) -> ThreadSession {
        if let existing = sessions[threadId] {
            existing.lastUsed = Date()
            return existing
        }
        let session = ThreadSession(threadId: threadId, app: self)
        sessions[threadId] = session
        evictSessions()
        return session
    }

    var loadedSessionCount: Int { sessions.count }

    /// A thread's session if it's open already, without opening one.
    func loadedSession(_ threadId: String) -> ThreadSession? { sessions[threadId] }

    /// Every open session, for RemoteRunners.swift.
    var openSessions: [ThreadSession] { Array(sessions.values) }

    /// Lets a session go, so the thread loads afresh next time it's opened.
    func dropSession(_ threadId: String) {
        sessions.removeValue(forKey: threadId)?.unsubscribe()
    }

    private func evictSessions() {
        guard sessions.count > Self.maxSessions else { return }
        let victims = sessions.values
            .filter { $0.threadId != selection && panelTranscripts[$0.threadId] == nil }
            .sorted { $0.lastUsed < $1.lastUsed }
            .prefix(sessions.count - Self.maxSessions)
        for victim in victims {
            victim.unsubscribe()
            sessions[victim.threadId] = nil
        }
    }

    func focusComposer(_ draftKey: String) {
        focusRequests[draftKey, default: 0] += 1
    }

    /// The thread's transcript is in front of Mike: in the main panel, or
    /// its own panel's tab is the one showing.
    func isShowing(_ threadId: String) -> Bool {
        (selection == threadId && subagentSelection == nil) || dock.isShowing(WindowDock.threadPanel(threadId))
    }

    func scheduleMarkSeen(_ threadId: String) {
        markSeenTasks[threadId]?.cancel()
        markSeenTasks[threadId] = Task {
            try? await Task.sleep(for: .milliseconds(400))
            guard !Task.isCancelled, let client = client(for: threadId), let thread = threads[threadId], isLooking, isShowing(threadId) else { return }
            if let updated = try? await client.markSeen(threadId: threadId, seq: thread.lastSeq) {
                threads[threadId] = updated
            }
        }
    }

    func appBecameActive() {
        if subagentSelection == nil, let selection, let thread = threads[selection], thread.needsYou { scheduleMarkSeen(selection) }
        servePanelRequest()
        // He's back: a milestone may have been waiting for him. The window
        // isn't key yet at this point.
        if milestones != nil {
            Task {
                try? await Task.sleep(for: .milliseconds(200))
                considerMilestone()
            }
        }
    }
}
