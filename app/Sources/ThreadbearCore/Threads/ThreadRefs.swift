import Foundation

/// Thread ids in an agent's reply, so the transcript can turn the ones that
/// name a real thread into chips: hover for what the thread is, click to
/// open it. Agents name threads by the 8-character prefix `tb status` and
/// `tb list` print ("`85735a8f`"), or by the whole id.
public enum ThreadRefs {
    /// Lowercase hex, 8 characters or a whole UUID, not inside a longer
    /// word or path. Only a shape: 8 hex digits could as well be a commit,
    /// so `Index.resolve` decides what's a thread.
    /// (NSRegularExpression: Swift's regex literals have no lookbehind.)
    nonisolated(unsafe) private static let pattern = try! NSRegularExpression(
        pattern: #"(?<![0-9A-Za-z_\-/.])[0-9a-f]{8}(?:-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})?(?![0-9A-Za-z_\-/])"#)

    /// Where each id-shaped word is in `text`, as UTF-16 ranges (what
    /// attributed strings use).
    public static func candidates(in text: String) -> [NSRange] {
        guard text.utf8.count >= 8 else { return [] }
        return pattern.matches(in: text, range: NSRange(location: 0, length: (text as NSString).length)).map(\.range)
    }

    /// Thread ids by their full id and by their 8-character prefix, built
    /// once per thread list so drawing a chip is a dictionary lookup.
    public struct Index: Sendable {
        private var ids: [String: String] = [:]

        public init(_ threadIds: some Sequence<String>) {
            var prefixes: [String: String?] = [:]
            for id in threadIds {
                ids[id] = id
                let prefix = String(id.prefix(8))
                // Two threads sharing a prefix: the prefix names neither.
                prefixes[prefix] = prefixes[prefix] == nil ? .some(id) : .some(nil)
            }
            for (prefix, id) in prefixes {
                if let id, ids[prefix] == nil { ids[prefix] = id }
            }
        }

        public func resolve(_ token: String) -> String? { ids[token] }
    }

    /// The popover's second line: where the thread is and what it's doing,
    /// "misc · claude-2 · Working 4m".
    public static func detail(_ thread: ThreadSummary, account: String?, now: Date) -> String {
        var parts = [FolderName.short(thread.cwd)]
        if let account, !account.isEmpty { parts.append(account) }
        parts.append(status(thread, now: now))
        return parts.filter { !$0.isEmpty }.joined(separator: " · ")
    }

    public static func status(_ thread: ThreadSummary, now: Date) -> String {
        if thread.isArchived { return "Archived" }
        if thread.snoozedUntilRelease { return "Hibernating until the runner updates" }
        if thread.snoozedUntilRestart { return "Hibernating until the runner restarts" }
        if thread.isSnoozed(at: now), let words = WakeWords.status(thread, now: now) { return words }
        if let until = thread.snoozedUntil, until > now { return "Hibernating until " + RelativeTime.until(until, now: now) }
        switch thread.status {
        case .running, .starting: return "Working " + ThreadRowLook.workingLabel(since: thread.lastActivityAt, now: now)
        case .waiting: return "Needs you"
        case .error: return "Failed"
        case .stopped: return "Stopped"
        case .idle:
            if !thread.background.isEmpty { return "In the background" }
            let seconds = now.timeIntervalSince(thread.lastActivityAt)
            let time = RelativeTime.short(thread.lastActivityAt, now: now)
            if seconds < 60 { return "Active just now" }
            return seconds < 86_400 ? "Active \(time) ago" : "Active \(time)"
        }
    }
}
