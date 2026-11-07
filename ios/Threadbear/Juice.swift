import SwiftUI

/// The inbox's small animations, in one place so they share timings with the
/// Mac's (app Juice.swift) and all go quiet together under Reduce Motion.
enum Juice {
    static var reduceMotion: Bool { UIAccessibility.isReduceMotionEnabled }

    /// Rows gliding from one heading to another, and the rest making room. Under
    /// Reduce Motion, nothing: the list just changes.
    static var rows: Animation? {
        reduceMotion ? nil : .snappy(duration: 0.32, extraBounce: 0.04)
    }

    /// How long a row takes to land before its mark pops in.
    static var landing: Duration { reduceMotion ? .zero : .milliseconds(280) }

    /// A done tick or unread dot turning up, as a row lands.
    static var pop: Animation {
        reduceMotion ? .easeOut(duration: 0.12) : .spring(response: 0.3, dampingFraction: 0.55)
    }

    static var popIn: AnyTransition {
        reduceMotion ? .opacity : .scale(scale: 0.2).combined(with: .opacity)
    }

    /// A card that's been answered going, and what replaces it settling.
    static let card = Animation.easeInOut(duration: 0.22)

    /// A card leaves by folding up to its top edge and fading; it just turns up.
    static var cardGoes: AnyTransition {
        .asymmetric(insertion: .opacity, removal: reduceMotion ? .opacity : .modifier(active: FoldUp(open: 0), identity: FoldUp(open: 1)))
    }
}

private struct FoldUp: ViewModifier {
    var open: CGFloat

    func body(content: Content) -> some View {
        content
            .clipShape(Rectangle().scale(x: 1, y: open, anchor: .top))
            .scaleEffect(y: 0.97 + 0.03 * open, anchor: .top)
            .opacity(open)
    }
}
