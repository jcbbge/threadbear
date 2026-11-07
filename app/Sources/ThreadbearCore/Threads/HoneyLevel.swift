import Foundation

/// How full the honey pot on the rail is: the room left on the login the next
/// new thread would use (`AccountUsageText.room`, the tighter of its 5-hour
/// and weekly windows). Unknown or at its limit is an empty pot; the tooltip
/// and the panel say the rest.
public enum HoneyLevel {
    /// 0 to 1.
    public static func level(_ usage: AccountUsage?) -> Double {
        guard let usage, !usage.blocked, let room = AccountUsageText.room(usage) else { return 0 }
        return min(max(room / 100, 0), 1)
    }

    /// The same login's window has reset, rather than the pot just changing
    /// hands to a login with more room, or room coming back a bit at a time
    /// as an old 5-hour window slides off. Worth the rise and the drip.
    public static func refilled(from old: Double, to new: Double, sameLogin: Bool) -> Bool {
        sameLogin && new >= 0.95 && new - old >= 0.1
    }
}
