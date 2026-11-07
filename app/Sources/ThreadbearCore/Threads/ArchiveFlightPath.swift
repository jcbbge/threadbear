import CoreGraphics
import Foundation

/// Where an archived thread's panel is, how big and how tipped, part way
/// through its drop into the Archived heading (`ArchiveFlight` in the app
/// draws it). A quadratic Bézier from the panel's centre to the heading,
/// with its control point a little left of the start and a little short of
/// the target's height, so the panel swings out before curving into place
/// like a sheet dropped into a drawer. Kept apart from the drawing so the
/// path can be tested without animating anything.
///
/// Hibernating is the same flight with a sleepier feel (`Style.tuck`): the
/// panel sinks instead of dropping, doesn't tip, and dims as it goes, like
/// the lights going down.
public struct ArchiveFlightPath: Sendable, Equatable {
    public enum Style: Sendable, Equatable {
        /// Archive: falls, tips and swings across.
        case drop
        /// Hibernate: sinks, level, dimming into the moon.
        case tuck
    }

    public struct Frame: Sendable, Equatable {
        public var position: CGPoint
        public var scale: Double
        /// Radians, anticlockwise.
        public var tilt: Double
        /// In the panel's own (unscaled) points.
        public var cornerRadius: Double
        public var opacity: Double
        /// How far it's gone dark: the black laid over the picture, 0 to 1.
        public var dimming: Double
    }

    public var start: CGPoint
    public var end: CGPoint
    /// How far the control point sits left of the start and short of the
    /// end's height, in points.
    public var swing: Double
    /// True when `end` is the heading itself; false when it's only the
    /// bottom of the list, with the heading out of sight, where the panel
    /// fades out sooner and all the way.
    public var onHeading: Bool
    public var style: Style

    public init(start: CGPoint, end: CGPoint, swing: Double = 40, onHeading: Bool = true, style: Style = .drop) {
        self.start = start
        self.end = end
        self.swing = swing
        self.onHeading = onHeading
        self.style = style
    }

    /// The smallest the panel gets, at the heading.
    public static let smallest = 0.02

    /// Eased time to progress: slow off the mark, quick through the
    /// middle, settling into the heading.
    public static func progress(atTime t: Double, style: Style = .drop) -> Double {
        let t = min(1, max(0, t))
        switch style {
        case .drop: return t < 0.5 ? 4 * t * t * t : 1 - pow(-2 * t + 2, 3) / 2
        // A sine's softer than the drop's cubic: no snap through the middle.
        case .tuck: return 0.5 - 0.5 * cos(.pi * t)
        }
    }

    /// The panel `p` of the way along (0 at the start, 1 at the heading).
    public func frame(at p: Double) -> Frame {
        let p = min(1, max(0, p))
        let control = CGPoint(x: start.x - swing, y: end.y - swing)
        let q = 1 - p
        let position = CGPoint(
            x: q * q * start.x + 2 * q * p * control.x + p * p * end.x,
            y: q * q * start.y + 2 * q * p * control.y + p * p * end.y
        )
        let radius = min(40, 6 + 60 * p)
        if style == .tuck {
            // Shrinks a touch later than the drop: a sink, not a fall. It
            // dims all the way down to about 40%, then goes out on arrival.
            let scale = max(Self.smallest, 1 - (1 - Self.smallest) * pow(p, 0.8))
            let fadeTo = onHeading ? 0.1 : 0
            let opacity = p < 0.9 ? 1 - 0.6 * (p / 0.9) : 0.4 - (0.4 - fadeTo) * ((p - 0.9) / 0.1)
            return Frame(position: position, scale: scale, tilt: 0, cornerRadius: radius, opacity: opacity, dimming: 0.45 * p)
        }
        // Shrinks fastest early on, so it's small well before it arrives.
        let scale = max(Self.smallest, 1 - (1 - Self.smallest) * pow(p, 0.7))
        // A slight tip, most at the middle of the fall.
        let tilt = 4 * sin(p * .pi) * .pi / 180
        let fadeFrom = onHeading ? 0.85 : 0.6
        let fadeTo = onHeading ? 0.2 : 0
        let opacity = p < fadeFrom ? 1 : 1 - (p - fadeFrom) / (1 - fadeFrom) * (1 - fadeTo)
        return Frame(position: position, scale: scale, tilt: tilt, cornerRadius: radius, opacity: opacity, dimming: 0)
    }
}
