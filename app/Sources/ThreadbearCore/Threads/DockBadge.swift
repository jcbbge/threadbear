import Foundation

/// The Dock icon's badge: how many threads need you, nothing when none do.
public enum DockBadge {
    public static func label(needsYou: Int) -> String? {
        needsYou > 0 ? String(needsYou) : nil
    }

    public static func label(for threads: some Sequence<ThreadSummary>, now: Date) -> String? {
        label(needsYou: ThreadSections.needsYouCount(threads, now: now))
    }
}
