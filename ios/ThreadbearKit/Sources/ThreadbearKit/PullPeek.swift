import CoreGraphics

/// The inbox pulled down past its top, for the bear peeking over it
/// (InboxView's PullPeekBear): how big the gap is, and how much head shows.
public struct PullPeek: Sendable, Equatable {
    /// The sat bear's head and ears at 64 pt, all of it.
    public static let head: CGFloat = 40

    /// How far the list's top is below where it sits at rest.
    public private(set) var gap: CGFloat = 0
    /// The top inset at rest. A refresh holding the list open adds to the
    /// inset, which isn't the list sitting any lower.
    private var restingInset: CGFloat?

    public init() {}

    /// Pulled this far, letting go refreshes.
    public static let refreshPoint: CGFloat = 80
    /// How far down the list holds while it does.
    public static let hold: CGFloat = 52

    /// Past the refresh point with the finger still down.
    private var armed = false

    /// The finger's pulled the gap to this. True as it first goes past the
    /// refresh point, the moment for the bear to blink and the tap.
    public mutating func pulling(gap: CGFloat) -> Bool {
        let was = armed
        armed = gap >= Self.refreshPoint
        return armed && !was
    }

    /// The finger's off: whether to refresh.
    public mutating func letGo() -> Bool {
        defer { armed = false }
        return armed
    }

    public static func shown(gap: CGFloat) -> CGFloat {
        min(head, max(0, (gap - 8) * 0.55))
    }

    public mutating func scrolled(offset: CGFloat, topInset: CGFloat, refreshing: Bool) {
        if !refreshing, offset >= -topInset - 0.5 { restingInset = topInset }
        gap = max(0, -(offset + (restingInset ?? topInset)))
    }
}
