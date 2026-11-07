import Foundation

/// A sub-agent or background job whose finishing woke a turn (a message
/// row's `wokeBy`, backend API 33).
public struct WokeTask: Codable, Sendable, Hashable {
    /// "agent", "shell", "monitor" or "other".
    public var kind: String
    /// Its brief or command; may be empty.
    public var description: String

    public init(kind: String, description: String) {
        self.kind = kind
        self.description = description
    }
}

/// The wait before a turn the agent started by itself, drawn as a divider:
/// "6 min later · Mine the repo finished". The Mac's TurnGap, worked out
/// from rows here: from the last row of the turn before to the woken
/// turn's first row (Mike picked the divider on 3 Nov).
public struct TurnGap: Hashable, Sendable {
    /// The woken turn's first row, for the item's id.
    public var seq: Int
    public var from: Date
    public var to: Date
    public var wokeBy: [WokeTask]

    public init(seq: Int, from: Date, to: Date, wokeBy: [WokeTask] = []) {
        self.seq = seq
        self.from = from
        self.to = to
        self.wokeBy = wokeBy
    }

    public var label: String {
        let time = Self.later(max(0, to.timeIntervalSince(from)))
        guard let cause = Self.cause(wokeBy) else { return time }
        return time + " · " + cause
    }

    static func later(_ interval: TimeInterval) -> String {
        let seconds = Int(saturating: interval.rounded())
        if seconds < 60 { return seconds < 2 ? "Moments later" : "\(seconds)s later" }
        let minutes = Int((Double(seconds) / 60).rounded())
        if minutes < 60 { return "\(minutes) min later" }
        let hours = minutes / 60, rest = minutes % 60
        if hours < 24 { return rest == 0 ? "\(hours) h later" : "\(hours) h \(rest) min later" }
        let days = hours / 24
        return days == 1 ? "A day later" : "\(days) days later"
    }

    /// Sub-agents are named over the shells they ran, as on the Mac.
    static func cause(_ tasks: [WokeTask]) -> String? {
        guard !tasks.isEmpty else { return nil }
        let agents = tasks.filter { $0.kind == "agent" }
        let shown = agents.isEmpty ? tasks : agents
        let names = shown.map { $0.description.trimmingCharacters(in: .whitespacesAndNewlines) }.filter { !$0.isEmpty }
        let noun = agents.isEmpty ? "background job" : "sub-agent"
        switch (names.count, shown.count) {
        case (0, 1): return "A \(noun) finished"
        case (0, let n): return "\(n) \(noun)s finished"
        case (1, 1): return "\(names[0]) finished"
        case (2, 2): return "\(names[0]) and \(names[1]) finished"
        case (_, let n): return "\(names[0]) and \(n - 1) more finished"
        }
    }
}
