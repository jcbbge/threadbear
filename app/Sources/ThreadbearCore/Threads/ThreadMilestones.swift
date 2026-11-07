import Foundation

/// When the "That's 1,000 threads" note is due, and what it says.
///
/// There's a 100th, then every thousand. What's remembered is the highest one
/// shown, so a milestone goes off at or any time after the count passes it
/// (the installed app only gets a new build when it next restarts, so a build
/// can arrive after the moment), never twice, and a long jump is one note for
/// the highest, not a burst.
///
/// With nothing remembered, this is the first time this code has seen these
/// threads. Under a thousand that's an install with its early days behind it:
/// no note ("That's 100 threads" at 951 would be silly), just the memory.
public enum ThreadMilestones {
    public enum Decision: Equatable, Sendable {
        case nothing
        /// Keep this as the highest shown, with no note.
        case remember(Int)
        /// Show this one, and remember it once it's shown.
        case show(Int)
    }

    public static func decide(count: Int, shown: Int?) -> Decision {
        let reached = reached(count: count)
        guard let shown else {
            return reached >= 1000 ? .show(reached) : .remember(reached)
        }
        return reached > shown ? .show(reached) : .nothing
    }

    /// The highest milestone at or below `count`, 0 before the first.
    private static func reached(count: Int) -> Int {
        if count >= 1000 { return count / 1000 * 1000 }
        return count >= 100 ? 100 : 0
    }

    public static func title(_ tier: Int) -> String {
        "That's \(tier.formatted(.number.locale(Locale(identifier: "en_AU")))) threads"
    }

    public static func line(_ tier: Int) -> String {
        switch tier {
        case 100: "You've got the hang of this"
        case 1000: "The bear needs a lie down"
        case 2000: "The lie down didn't help"
        case 3000: "The bear would like a word"
        case 4000: "The bear's stopped asking"
        case 5000: "The bear's thinking of moving out"
        default: "The bear's lost count, sorry"
        }
    }
}
