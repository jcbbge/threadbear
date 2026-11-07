import Foundation

/// The threads a thread's agent started (create_thread) or is waiting on
/// (end_turn's waitFor), for its Highlights. Mike asked on 6 Nov for a
/// light take on Ghostex's coordinators: a thread that hands work to other
/// threads shows them the way it shows its sub-agents, so he can see how
/// they're getting on without leaving it. Their questions still go to his
/// inbox as any thread's do; this is only somewhere to look.
public enum StartedThreadRows {
    public struct Row: Sendable, Equatable, Identifiable {
        public var thread: ThreadSummary
        public var state: State
        /// It started this one (rather than only waiting on it).
        public var started: Bool
        public var id: String { thread.id }
    }

    /// Where the thread is up to, in the order the section lists them:
    /// what needs Mike first, then what's going, then what's put away.
    public enum State: Int, Sendable, Comparable {
        case needsYou, failed, working, hibernating, done, archived

        public static func < (a: State, b: State) -> Bool { a.rawValue < b.rawValue }
    }

    /// Every thread `parent` started, and any it's waiting on that it
    /// didn't start, newest first within each state. One the runner no
    /// longer lists (deleted) is left out.
    public static func rows(for parent: ThreadSummary, in threads: [String: ThreadSummary], now: Date) -> [Row] {
        let waited = Set((parent.waitingOn ?? []).map(\.threadId))
        let rows = threads.values.compactMap { thread -> Row? in
            guard thread.id != parent.id else { return nil }
            let started = thread.startedBy?.kind == "thread" && thread.startedBy?.threadId == parent.id
            guard started || waited.contains(thread.id) else { return nil }
            return Row(thread: thread, state: state(thread, now: now), started: started)
        }
        return rows.sorted {
            $0.state != $1.state ? $0.state < $1.state : $0.thread.lastActivityAt > $1.thread.lastActivityAt
        }
    }

    public static func state(_ thread: ThreadSummary, now: Date) -> State {
        if thread.isArchived { return .archived }
        if thread.isSnoozed(at: now) { return .hibernating }
        if thread.status == .waiting || thread.reviewWaiting || thread.waitingOnMike { return .needsYou }
        if thread.status == .error { return .failed }
        if thread.status.isBusy || thread.agentsStillWorking || !thread.background.isEmpty { return .working }
        return .done
    }

    /// The SF Symbol at the start of its row, like a sub-agent's.
    public static func icon(_ state: State) -> String {
        switch state {
        case .needsYou: return "hand.raised"
        case .failed: return "xmark"
        case .working: return "circle.dashed"
        case .hibernating: return "moon"
        case .done: return "checkmark"
        case .archived: return "archivebox"
        }
    }

    /// The row's second line: where it's up to, in the sidebar popover's
    /// words ("Working 4m", "Hibernating until tomorrow"), with "Needs you"
    /// for one that's finished and asked Mike something (the popover calls
    /// that idle). Says when it's one this thread waits on but didn't start.
    public static func detail(_ row: Row, now: Date) -> String {
        let status = row.state == .needsYou ? "Needs you" : ThreadRefs.status(row.thread, now: now)
        return row.started ? status : "Waiting on it · " + status
    }
}
