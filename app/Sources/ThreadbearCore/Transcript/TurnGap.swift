import Foundation

/// The wait before a turn the agent started by itself, as a sub-agent or a
/// background job finished: drawn as a divider, "6 min later · Mine the
/// repo finished", between that turn's rows and the last turn's. Without
/// it, "still waiting on the research" and "the research is back" sat one
/// under the other as if said in one breath (Mike, 3 Nov, picked the
/// divider from four mockups in docs/wait-gap-design).
public struct TurnGap: Sendable, Hashable {
    /// The last turn's end and this one's start.
    public var from: Date
    public var to: Date
    /// What finished and woke it (`turn.started`'s `wokeBy`); empty for a
    /// wake with no finished work (a sub-agent asking for an approval) or
    /// from a runner too old to say.
    public var wokeBy: [BackgroundTask]

    public init(from: Date, to: Date, wokeBy: [BackgroundTask] = []) {
        self.from = from
        self.to = to
        self.wokeBy = wokeBy
    }

    public var milliseconds: Double { max(0, to.timeIntervalSince(from) * 1000) }

    /// "6 min later · Mine the repo finished".
    public var label: String {
        let time = Self.later(milliseconds)
        guard let cause = Self.cause(wokeBy) else { return time }
        return time + " · " + cause
    }

    /// How long, in the words someone would say it.
    public static func later(_ milliseconds: Double) -> String {
        let seconds = max(0, Int(saturating: (milliseconds / 1000).rounded()))
        if seconds < 60 { return seconds < 2 ? "Moments later" : "\(seconds)s later" }
        let minutes = Int((Double(seconds) / 60).rounded())
        if minutes < 60 { return "\(minutes) min later" }
        let hours = minutes / 60, rest = minutes % 60
        if hours < 24 { return rest == 0 ? "\(hours) h later" : "\(hours) h \(rest) min later" }
        let days = hours / 24
        return days == 1 ? "A day later" : "\(days) days later"
    }

    /// What woke it. Sub-agents are named over the shells they ran: a
    /// sub-agent's own commands can finish alongside it, and those are its
    /// working, not what the thread was waiting for.
    public static func cause(_ tasks: [BackgroundTask]) -> String? {
        guard !tasks.isEmpty else { return nil }
        let agents = tasks.filter { $0.kind == .agent }
        let shown = agents.isEmpty ? tasks : agents
        let names = shown.map { $0.description.trimmingCharacters(in: .whitespacesAndNewlines) }.filter { !$0.isEmpty }
        let noun = agents.isEmpty ? "background job" : "sub-agent"
        switch (names.count, shown.count) {
        case (0, 1): return "A \(noun) finished"
        case (0, let n): return "\(n) \(noun)s finished"
        case (1, 1): return "\(names[0]) finished"
        case (1, let n): return "\(names[0]) and \(n - 1) more finished"
        case (2, 2): return "\(names[0]) and \(names[1]) finished"
        case (_, let n): return "\(names[0]) and \(n - 1) more finished"
        }
    }
}
