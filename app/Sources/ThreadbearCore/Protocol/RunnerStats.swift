import Foundation

/// One runner's machine figures (`runners.stats`, docs/protocol.md): what
/// its last report said, every few seconds while a runner's details are
/// open in the Runners panel (or the website's Runners view).
public struct RunnerMachineStats: Sendable, Hashable, Decodable {
    public var runnerId: String
    /// When it reported them.
    public var at: Date
    public var cpuPercent: Double
    public var cores: Int
    /// Bytes, as Activity Monitor's Memory Used counts them on a Mac.
    public var memUsed: Double
    public var memTotal: Double
    /// Bytes free and in all on the disk the runner's data is on.
    public var diskFree: Double
    public var diskTotal: Double
    public var load1: Double?
    /// How long the machine (not the runner) has been up.
    public var uptimeSec: Double
    /// Its CPU's name ("Apple M5").
    public var machine: String?
    /// "macOS 27.2", "Ubuntu 24.04.1 LTS".
    public var os: String?

    public init(runnerId: String, at: Date = Date(), cpuPercent: Double = 0, cores: Int = 0, memUsed: Double = 0, memTotal: Double = 0,
                diskFree: Double = 0, diskTotal: Double = 0, load1: Double? = nil, uptimeSec: Double = 0, machine: String? = nil, os: String? = nil) {
        self.runnerId = runnerId
        self.at = at
        self.cpuPercent = cpuPercent
        self.cores = cores
        self.memUsed = memUsed
        self.memTotal = memTotal
        self.diskFree = diskFree
        self.diskTotal = diskTotal
        self.load1 = load1
        self.uptimeSec = uptimeSec
        self.machine = machine
        self.os = os
    }

    /// The most each figure can really be: a row past these is refused,
    /// so `RunnerStatsResult` leaves that runner out. Another runner writes
    /// its own row, and its `cores: 1e20` once stopped this app in
    /// `Int(_:)`, where nothing can catch it (Daybreak, 7 Nov 2026). The
    /// backend refuses the same (setRunnerStats); this is for rows it
    /// stored before that.
    public enum Limits {
        public static let cores = 1_000_000.0
        /// An exabyte, of memory or disk.
        public static let bytes = 1e18
        public static let load = 1_000_000.0
        /// A thousand years.
        public static let uptimeSec = 3.2e10
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        runnerId = try c.decode(String.self, forKey: .runnerId)
        func number(_ key: CodingKeys, atMost most: Double) throws -> Double {
            guard let value = (try? c.decodeIfPresent(Double.self, forKey: key)) ?? nil else { return 0 }
            guard value.isFinite, value >= 0, value <= most else {
                throw DecodingError.dataCorruptedError(forKey: key, in: c, debugDescription: "Out of range: \(value)")
            }
            return value
        }
        func text(_ key: CodingKeys) -> String? { ((try? c.decodeIfPresent(String.self, forKey: key)) ?? nil).flatMap { $0.isEmpty ? nil : $0 } }
        at = text(.at).flatMap(ISO8601.parse) ?? .distantPast
        cpuPercent = try number(.cpuPercent, atMost: 100)
        guard let cores = try number(.cores, atMost: Limits.cores).wholeCount() else {
            throw DecodingError.dataCorruptedError(forKey: .cores, in: c, debugDescription: "Not a whole number of cores")
        }
        self.cores = cores
        memUsed = try number(.memUsed, atMost: Limits.bytes)
        memTotal = try number(.memTotal, atMost: Limits.bytes)
        diskFree = try number(.diskFree, atMost: Limits.bytes)
        diskTotal = try number(.diskTotal, atMost: Limits.bytes)
        load1 = try ((try? c.decodeIfPresent(Double.self, forKey: .load1)) ?? nil).map { _ in try number(.load1, atMost: Limits.load) }
        uptimeSec = try number(.uptimeSec, atMost: Limits.uptimeSec)
        machine = text(.machine)
        os = text(.os)
    }

    enum CodingKeys: String, CodingKey { case runnerId, at, cpuPercent, cores, memUsed, memTotal, diskFree, diskTotal, load1, uptimeSec, machine, os }
}

public struct RunnerStatsResult: Sendable, Decodable {
    public var stats: [RunnerMachineStats]

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        stats = c.lossyArray(RunnerMachineStats.self, forKey: .stats)
    }

    enum CodingKeys: String, CodingKey { case stats }
}

public extension RPCClient {
    /// Every runner's latest figures. Asking keeps them coming for a while.
    /// Empty from a runner before `runners.stats`, and where it can't have
    /// them (sync off, an older backend, a runner key).
    func runnerStats() async throws -> [RunnerMachineStats] {
        do {
            return try await call("runners.stats", .object([:]), as: RunnerStatsResult.self).stats
        } catch RPCError.server(let code, _) where code == RPCError.methodNotFound {
            return []
        }
    }
}
