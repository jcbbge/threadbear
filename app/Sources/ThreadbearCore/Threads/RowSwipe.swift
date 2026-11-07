import Foundation

/// A two-finger swipe left on a sidebar row, as Mail does: the row follows
/// the fingers, and let go far enough along (or flicked) it archives.
/// Fed the trackpad's scroll events by the row (`RowSwipeController` in the
/// app); this decides whether a gesture is a swipe at all and how far the
/// row has gone, so it can be tested without a trackpad.
public struct RowSwipe: Sendable, Equatable {
    public enum Phase: Sendable, Equatable {
        /// No gesture under way.
        case idle
        /// Fingers down, not yet clear whether it's across or up and down.
        case deciding
        /// Across: the row is following the fingers, and the events are
        /// the row's, not the list's.
        case tracking
        /// Up and down: a scroll, left to the list until the fingers lift.
        case ignoring
    }

    public private(set) var phase: Phase = .idle
    /// How far the fingers have gone across since they touched, left
    /// negative, before any resistance.
    public private(set) var travel: Double = 0
    /// The row's width, which the distance to archive is a share of.
    public var width: Double
    private var sumX = 0.0
    private var sumY = 0.0
    private var lastDX: Double = 0
    /// A swipe right is Back's (SwipeNavigation in the app) while there's somewhere
    /// to go back to, rather than the row giving a little and stopping.
    private var rightTaken = false

    /// Movement before a gesture is called across or up and down.
    public static let decideAfter = 6.0
    /// Across has to be this much more than up and down to count, so a
    /// slightly diagonal scroll still scrolls.
    public static let across = 1.5
    /// One event moving this far left at the end is a flick: it archives
    /// even short of the line, once the row's at least `flickTravel` along.
    static let flickSpeed = 14.0
    static let flickTravel = 30.0

    public init(width: Double = 300) {
        self.width = width
    }

    /// How far along a let-go archives: a third of the row, and never less
    /// than 70 points, so a narrow sidebar doesn't archive on a nudge.
    public var threshold: Double { max(70, width * 0.35) }

    /// Where to draw the row: the travel to the left, up to the row's
    /// width; to the right only a little, with resistance, as there's
    /// nothing that way.
    public var offset: Double {
        travel < 0 ? max(travel, -width) : min(travel * 0.2, 24)
    }

    /// Far enough along that letting go archives.
    public var armed: Bool { phase == .tracking && travel <= -threshold }

    public var isSwiping: Bool { phase == .tracking }

    /// A mouse dragging a row `dx`, `dy` from where it went down (left
    /// negative): true once that's the thread being dragged out, to drop
    /// into another thread's message (ThreadDrag in the app), rather than
    /// this swipe. Any way but mostly left, by the same rule that decides a
    /// swipe, so the two never both start.
    public static func dragsOut(dx: Double, dy: Double) -> Bool {
        guard max(abs(dx), abs(dy)) >= decideAfter else { return false }
        return !(dx < 0 && abs(dx) >= abs(dy) * across)
    }

    /// Fingers touched the trackpad. `rightTaken`: a swipe right goes
    /// Back, so it isn't the row's.
    public mutating func begin(rightTaken: Bool = false) {
        phase = .deciding
        self.rightTaken = rightTaken
        travel = 0
        sumX = 0
        sumY = 0
        lastDX = 0
    }

    /// The fingers moved (`dx` left negative, `dy` either way). Says
    /// whether the event is the row's: once it's tracking, so the list
    /// doesn't scroll while the row slides.
    public mutating func move(dx: Double, dy: Double) -> Bool {
        switch phase {
        case .idle, .ignoring:
            return false
        case .deciding:
            sumX += dx
            sumY += dy
            guard max(abs(sumX), abs(sumY)) >= Self.decideAfter else { return false }
            if abs(sumX) >= abs(sumY) * Self.across, !(rightTaken && sumX > 0) {
                phase = .tracking
                travel = sumX
                lastDX = dx
                return true
            }
            phase = .ignoring
            return false
        case .tracking:
            travel += dx
            lastDX = dx
            return true
        }
    }

    /// The fingers lifted. True when the row should archive.
    public mutating func end() -> Bool {
        defer { phase = .idle }
        guard phase == .tracking else { return false }
        if travel <= -threshold { return true }
        return lastDX <= -Self.flickSpeed && travel <= -Self.flickTravel
    }

    /// The gesture was cancelled (the system took it, say): never archives.
    public mutating func cancel() {
        phase = .idle
        travel = 0
    }

    /// Back to rest after the row has sprung back or gone.
    public mutating func reset() {
        phase = .idle
        travel = 0
    }
}
