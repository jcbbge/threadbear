import Foundation

/// A two-finger swipe across the window going back or forward: fingers to
/// the right go back, to the left forward, as in Safari. It works like a
/// sidebar row's swipe (`RowSwipe`): an arrow follows the fingers, and let
/// go past the line (or flicked) it goes. Fed the trackpad's scroll events
/// by `SwipeNavigation` in the app; this decides whether a gesture is a
/// page swipe or a scroll and how far along it is, so it can be tested
/// without a trackpad.
public struct NavigationSwipe: Sendable, Equatable {
    public enum Direction: Sendable, Equatable, Hashable {
        case back, forward
    }

    public enum Phase: Sendable, Equatable {
        case idle
        /// Fingers down, not yet clear which way.
        case deciding
        /// Across, a way there's somewhere to go: the events are ours.
        case tracking(Direction)
        /// A scroll, or across with nowhere to go: left alone.
        case ignoring
    }

    /// What an event means for whoever's feeding them in.
    public enum Verdict: Sendable, Equatable {
        /// Not clear yet.
        case wait
        /// A scroll: it, and the rest of the gesture, aren't ours.
        case scroll
        /// A page swipe, this event included.
        case swipe
    }

    public private(set) var phase: Phase = .idle
    /// How far the fingers have gone the swipe's way since they touched.
    public private(set) var travel: Double = 0
    /// Whether the events are kept from the view under the pointer while
    /// deciding. Not over a sidebar row, which needs the whole gesture.
    public private(set) var holds = true
    private var allowed: Set<Direction> = []
    private var sumX = 0.0
    private var sumY = 0.0
    /// Points a second the swipe's way, at the last movement.
    private var lastSpeed = 0.0

    /// How far the fingers go before letting go goes there.
    public static let threshold = 110.0
    /// Moving this fast the swipe's way at the end is a flick: it goes even
    /// short of the line, once it's `flickTravel` along. In points a second,
    /// as how far one event moves depends on how often the trackpad sends them.
    static let flickSpeed = 840.0
    static let flickTravel = 40.0
    /// How far across before a gesture that's being held is a swipe. Small,
    /// as nothing happens yet but the arrow starting to show.
    static let across = 5.0
    /// How far up or down before a sideways start is a scroll after all.
    static let upAndDown = 4.0

    public init() {}

    public var direction: Direction? {
        if case .tracking(let direction) = phase { return direction }
        return nil
    }

    /// 0 at the start, 1 at the line, for drawing the arrow.
    public var progress: Double { direction == nil ? 0 : min(1, max(0, travel / Self.threshold)) }

    /// Far enough along that letting go goes there.
    public var armed: Bool { direction != nil && travel >= Self.threshold && travel >= abs(sumY) }

    /// Fingers touched the trackpad, with the ways there's somewhere to go.
    public mutating func begin(allowed: Set<Direction>, holds: Bool = true) {
        phase = .deciding
        travel = 0
        sumX = 0
        sumY = 0
        lastSpeed = 0
        self.allowed = allowed
        self.holds = holds
    }

    /// The fingers moved (`dx` right positive, whichever way the system
    /// scrolls), `elapsed` seconds after the last event.
    public mutating func move(dx: Double, dy: Double, elapsed: Double = 1.0 / 60) -> Verdict {
        // Coalesced events can arrive all but together.
        let elapsed = max(elapsed, 1.0 / 240)
        switch phase {
        case .idle, .ignoring:
            return .scroll
        case .deciding:
            sumX += dx
            sumY += dy
            let verdict = decide()
            if verdict == .scroll { phase = .ignoring }
            if verdict == .swipe { lastSpeed = abs(dx) / elapsed }
            return verdict
        case .tracking(let way):
            let along = way == .back ? dx : -dx
            travel = max(0, travel + along)
            sumY += dy
            lastSpeed = along / elapsed
            return .swipe
        }
    }

    private mutating func decide() -> Verdict {
        guard !allowed.isEmpty else { return .scroll }
        let x = abs(sumX), y = abs(sumY)
        if holds {
            // Anything more across than up and down, as a real swipe drifts,
            // and a wobble of a point or two doesn't decide it. Holding a
            // scroll for its first few points costs nothing you'd see: they
            // all reach the view together.
            if y >= Self.upAndDown, y >= x { return .scroll }
            guard x >= Self.across, x > y else { return .wait }
        } else {
            // Over a row: the row's own rule (`RowSwipe.move`) on the same
            // events, so they always agree whether it's across. Deciding
            // differently, neither would take a swipe right.
            guard max(x, y) >= RowSwipe.decideAfter else { return .wait }
            guard x >= y * RowSwipe.across else { return .scroll }
        }
        let way: Direction = sumX > 0 ? .back : .forward
        guard allowed.contains(way) else { return .scroll }
        phase = .tracking(way)
        travel = abs(sumX)
        return .swipe
    }

    /// The fingers lifted: where to go, if anywhere. `stillMoving`: they
    /// were moving right up to the lift. A quick move, a pause to look at
    /// the arrow and a lift isn't a flick (seen on Tinker Desk, 7 Nov).
    public mutating func end(stillMoving: Bool = true) -> Direction? {
        defer { reset() }
        guard let direction else { return nil }
        // A gesture that went on to be mostly up and down was a scroll that
        // started sideways, however far across it got.
        guard travel >= abs(sumY) else { return nil }
        if travel >= Self.threshold { return direction }
        return stillMoving && lastSpeed >= Self.flickSpeed && travel >= Self.flickTravel ? direction : nil
    }

    public mutating func reset() {
        phase = .idle
        travel = 0
    }
}
