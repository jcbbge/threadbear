import Foundation

/// Threads hibernated from this phone, on their way to the Hibernating
/// heading (AppModel.hibernate). The row goes as soon as it's picked and the
/// heading's count goes up with it, but the runner may be a while, and the
/// inbox list and phone:counts then catch up separately, in either order.
public struct Tucks: Sendable, Equatable {
    /// Kept out of the inbox until the list says they're asleep.
    public private(set) var hidden: Set<String> = []
    /// How many phone:counts hasn't counted yet, to add to its number.
    public private(set) var uncounted = 0
    /// Goes up on each tuck, for the moon's one bounce.
    public private(set) var bounces = 0

    public init() {}

    public mutating func tuck(_ threadId: String) {
        hidden.insert(threadId)
        uncounted += 1
        bounces += 1
    }

    /// The runner refused it: back in the inbox, and off the count.
    public mutating func undo(_ threadId: String) {
        guard hidden.remove(threadId) != nil else { return }
        uncounted = max(0, uncounted - 1)
    }

    /// Hidden until a list has it asleep or doesn't have it. Unlike an
    /// archived thread, a hibernating one can stay in this list (a starred
    /// one does), so "gone from the list" alone could hide it for good.
    public mutating func inboxArrived(_ list: [PhoneThread], now: Date) {
        let awake = Set(list.filter { !InboxSections.isSnoozed($0, now: now) }.map(\.threadId))
        hidden.formIntersection(awake)
    }

    /// phone:counts has moved: what it's gained is no longer ours to add.
    /// With nothing still hidden it knows about them all, even if it didn't
    /// rise because something else woke at the same moment.
    public mutating func countsArrived(old: Int?, new: Int?) {
        if let old, let new { uncounted = max(0, uncounted - max(0, new - old)) }
        if hidden.isEmpty { uncounted = 0 }
    }
}
