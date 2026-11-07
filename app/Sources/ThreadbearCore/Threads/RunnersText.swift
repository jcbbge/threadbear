import Foundation

/// What the Runners panel and its activity bar icon say about each runner
/// (`runners.list`, docs/protocol.md). Mike asked on 5 Nov for the website's
/// runner view on the Mac: which machines are up, what they're on and what
/// they're running, without going to Settings.
public enum RunnersText {
    public enum State: Equatable, Sendable {
        case online
        /// An old release finishing its threads in a handover.
        case updating
        case offline
    }

    public static func state(_ r: RunnerInfo) -> State {
        guard r.online else { return .offline }
        return r.draining ? .updating : .online
    }

    /// The line under a runner's name: "Online, up 3h", "Updating",
    /// "Offline, last seen 2d ago".
    public static func stateLine(_ r: RunnerInfo, now: Date) -> String {
        switch state(r) {
        case .online:
            return r.startedAt.map { "Online, up \(span(from: $0, to: now))" } ?? "Online"
        case .updating:
            return "Updating"
        case .offline:
            return r.lastSeenAt.map { "Offline, last seen \(span(from: $0, to: now)) ago" } ?? "Offline"
        }
    }

    /// The short commit of the release it runs ("c4d90ca" from
    /// "20261105T064853Z-c4d90ca"), or its version for one running from a
    /// checkout ("0.1.0+source"). Nil from a runner that doesn't say.
    public static func build(_ r: RunnerInfo) -> String? {
        if let release = r.release, !release.isEmpty {
            return release.split(separator: "-").last.map(String.init) ?? release
        }
        return r.version
    }

    /// The row's tooltip: everything it knows, a line each.
    public static func rowTip(_ r: RunnerInfo, now: Date, running: Int) -> String {
        var lines = [r.name + (r.isSelf ? " (this Mac's runner)" : ""), stateLine(r, now: now)]
        if let version = r.version { lines.append("Version \(version)") }
        if let started = r.startedAt { lines.append("Started \(started.formatted(date: .abbreviated, time: .shortened))") }
        if let seen = r.lastSeenAt, !r.isSelf { lines.append("Last heard from \(span(from: seen, to: now)) ago") }
        if running > 0 { lines.append(running == 1 ? "1 thread running" : "\(running) threads running") }
        return lines.joined(separator: "\n")
    }

    /// The icon's tooltip: "Runners", then how many are up and which aren't.
    public static func tooltip(_ runners: [RunnerInfo]) -> String {
        var lines = ["Runners"]
        let down = runners.filter { state($0) == .offline }.map(\.name)
        let updating = runners.filter { state($0) == .updating }.map(\.name)
        if down.isEmpty {
            lines.append(runners.count == 2 ? "Both online" : "All \(runners.count) online")
        } else {
            lines.append("\(runners.count - down.count) of \(runners.count) online")
            lines.append(list(down) + " offline")
        }
        if !updating.isEmpty { lines.append(list(updating) + (updating.count == 1 ? " is updating" : " are updating")) }
        return lines.joined(separator: "\n")
    }

    /// The threads running on a runner: its own sidebar rows (`runnerId`
    /// nil for this Mac's) in the Running section's order.
    public static func running(on r: RunnerInfo, in running: [ThreadSummary]) -> [ThreadSummary] {
        running.filter { r.isSelf ? $0.runnerId == nil || $0.runnerId == r.id : $0.runnerId == r.id }
    }

    // MARK: A runner's figures (runners.stats)

    /// One bar in a runner's details: how full, its words, and whether it's
    /// worth noticing (the runner's own pressure rules, runner-stats.ts).
    public struct Gauge: Equatable, Sendable {
        public var title: String
        public var fraction: Double
        public var text: String
        public var high: Bool
    }

    public static func gauges(_ s: RunnerMachineStats) -> [Gauge] {
        var out = [Gauge(title: "CPU", fraction: min(1, max(0, s.cpuPercent / 100)), text: "\(Int(saturating: s.cpuPercent.rounded()))%", high: s.cpuPercent >= 90)]
        if s.memTotal > 0 {
            let used = s.memUsed / s.memTotal
            out.append(Gauge(title: "Memory", fraction: min(1, used), text: "\(number(s.memUsed)) of \(gb(s.memTotal))", high: used >= 0.9))
        }
        if s.diskTotal > 0 {
            out.append(Gauge(title: "Disk", fraction: min(1, max(0, 1 - s.diskFree / s.diskTotal)), text: "\(gb(s.diskFree)) free", high: s.diskFree < 10 * pow(1024, 3)))
        }
        return out
    }

    /// The lines under the bars: what it is, and how busy and long up.
    /// "Apple M5, macOS 27.2" and "Machine up 4d, load 2.1 on 10 cores" (the
    /// machine, as the state line above says how long the runner has been up).
    public static func machineLines(_ s: RunnerMachineStats) -> [String] {
        var lines: [String] = []
        let what = [s.machine, s.os].compactMap { $0 }
        if !what.isEmpty { lines.append(what.joined(separator: ", ")) }
        var up = "Machine up \(span(seconds: s.uptimeSec))"
        if let load = s.load1 { up += ", load \(String(format: "%.1f", load))" + (s.cores > 0 ? " on \(s.cores) cores" : "") }
        lines.append(up)
        return lines
    }

    /// Said when the last report is old enough to doubt: it's sent every
    /// 10 s while anyone's looking.
    public static func staleLine(_ s: RunnerMachineStats, now: Date) -> String? {
        let age = now.timeIntervalSince(s.at)
        return age > 60 ? "From \(span(from: s.at, to: now)) ago" : nil
    }

    /// "9.1 GB", "24 GB", "512 GB", "1.8 TB", in the binary units Activity
    /// Monitor uses.
    public static func gb(_ bytes: Double) -> String {
        let g = bytes / pow(1024, 3)
        if g >= 1000 { return number(bytes / 1024) + " TB" }
        return number(bytes) + " GB"
    }

    /// The same without the unit, for "7.4 of 8 GB": a tenth under 100, and
    /// no ".0".
    public static func number(_ bytes: Double) -> String {
        let g = bytes / pow(1024, 3)
        if g >= 100 { return "\(Int(saturating: g.rounded()))" }
        let tenth = (g * 10).rounded() / 10
        return tenth == tenth.rounded() ? "\(Int(saturating: tenth))" : String(format: "%.1f", tenth)
    }

    public static func span(seconds: Double) -> String {
        span(from: Date(timeIntervalSince1970: 0), to: Date(timeIntervalSince1970: seconds))
    }

    /// "12s", "4m", "3h", "2d", as the website says them.
    public static func span(from start: Date, to now: Date) -> String {
        let s = max(0, Int(saturating: now.timeIntervalSince(start).rounded()))
        if s < 60 { return "\(s)s" }
        if s < 3600 { return "\(s / 60)m" }
        if s < 86_400 { return "\(s / 3600)h" }
        return "\(s / 86_400)d"
    }

    private static func list(_ names: [String]) -> String {
        guard names.count > 1 else { return names.first ?? "" }
        return names.dropLast().joined(separator: ", ") + " and " + names.last!
    }
}
