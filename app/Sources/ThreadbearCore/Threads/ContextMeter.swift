import Foundation

/// How full a thread's context window is, for the composer's ring and its
/// popover (Ayush, bearfooding: token counts and session stats should be
/// easy to see). Only when the runner knows both the tokens and the
/// model's window; a CLI that doesn't say its window gets no ring.
public struct ContextMeter: Equatable, Sendable {
    public let used: Int
    public let window: Int

    /// From this fraction the ring turns orange: the CLI compacts the
    /// conversation by itself not far past here, so it's worth knowing.
    public static let nearlyFull = 0.8

    public init?(used: Int?, window: Int?) {
        guard let used, let window, window > 0, used >= 0 else { return nil }
        self.used = used
        self.window = window
    }

    public init?(_ thread: ThreadSummary) {
        self.init(used: thread.contextTokens, window: thread.contextWindow)
    }

    public var fraction: Double { min(1, Double(used) / Double(window)) }
    public var percent: Int { Int((fraction * 100).rounded()) }
    public var isNearlyFull: Bool { fraction >= Self.nearlyFull }

    /// "640k of 1M tokens".
    public var amount: String { "\(Self.tokens(used)) of \(Self.tokens(window)) tokens" }

    /// The ring's tooltip: "Context 64% full".
    public var tip: String { "Context \(percent)% full" }

    /// What happens when it fills, by the thread's provider.
    public static func compactNote(provider: String) -> String {
        let name = provider == "codex" ? "Codex" : provider == "claude" ? "Claude" : "The agent"
        return "\(name) compacts it by itself when it's nearly full."
    }

    /// 850, 12k, 640k, 1M, 1.2M: short enough for one line.
    public static func tokens(_ n: Int) -> String {
        if n < 1000 { return "\(n)" }
        if n < 1_000_000 {
            let k = Double(n) / 1000
            return k < 10 ? trimmed(k) + "k" : "\(Int(k.rounded()))k"
        }
        return trimmed(Double(n) / 1_000_000) + "M"
    }

    /// One decimal place, without a trailing ".0".
    private static func trimmed(_ x: Double) -> String {
        let s = String(format: "%.1f", (x * 10).rounded(.down) / 10)
        return s.hasSuffix(".0") ? String(s.dropLast(2)) : s
    }
}
