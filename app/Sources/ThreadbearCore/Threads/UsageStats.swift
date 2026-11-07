import Foundation

/// What the runner has kept about each login's spending (`usage.stats`,
/// docs/protocol.md "Usage history"): tokens by the hour, read from the
/// CLIs' own transcripts, and readings of the 5-hour and weekly windows
/// over time. The Usage panel's numbers and charts come from here.
public struct UsageStats: Sendable, Equatable, Decodable {
    public var generatedAt: Date
    /// False until the runner's first read of the transcripts is done.
    public var ready: Bool
    public var tokens: [AccountTokens]
    public var limits: [LimitHistory]

    public init(generatedAt: Date, ready: Bool = true, tokens: [AccountTokens] = [], limits: [LimitHistory] = []) {
        self.generatedAt = generatedAt
        self.ready = ready
        self.tokens = tokens
        self.limits = limits
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        generatedAt = ((try? c.decodeIfPresent(String.self, forKey: .generatedAt)) ?? nil).flatMap(ISO8601.parse) ?? Date()
        ready = (try? c.decodeIfPresent(Bool.self, forKey: .ready)) ?? true
        tokens = c.lossyArray(AccountTokens.self, forKey: .tokens)
        limits = c.lossyArray(LimitHistory.self, forKey: .limits)
    }

    enum CodingKeys: String, CodingKey { case generatedAt, ready, tokens, limits }

    public func hours(_ accountId: String) -> [TokenHour] {
        tokens.first { $0.accountId == accountId }?.hours ?? []
    }

    /// A window's readings. A model's own week ("Weekly Fable") is told
    /// apart from the others by its title.
    public func samples(_ accountId: String, kind: String, title: String? = nil) -> [LimitSample] {
        limits.first { $0.accountId == accountId && $0.kind == kind && (kind != "weekly_model" || $0.title == title) }?.samples ?? []
    }
}

public struct AccountTokens: Sendable, Equatable, Decodable {
    public var accountId: String
    public var hours: [TokenHour]

    public init(accountId: String, hours: [TokenHour]) {
        self.accountId = accountId
        self.hours = hours
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        accountId = try c.decode(String.self, forKey: .accountId)
        // [startMs, input, output, cacheRead, cacheWrite]; a short or odd
        // row is skipped rather than failing the lot.
        let rows = (try? c.decodeIfPresent([[Double]].self, forKey: .hours)) ?? []
        // A count past ten trillion an hour is no real reading, and the
        // sums over a month of them stay inside Int (Int(_:) of 1e100, or
        // an overflowing sum, would stop the app).
        hours = rows.compactMap { row in
            guard row.count >= 5, row[0].isFinite, abs(row[0]) <= 8.64e15,
                  let input = row[1].wholeCount(atMost: 1e13), let output = row[2].wholeCount(atMost: 1e13),
                  let cacheRead = row[3].wholeCount(atMost: 1e13), let cacheWrite = row[4].wholeCount(atMost: 1e13) else { return nil }
            return TokenHour(start: Date(timeIntervalSince1970: row[0] / 1000), input: input, output: output, cacheRead: cacheRead, cacheWrite: cacheWrite)
        }.sorted { $0.start < $1.start }
    }

    enum CodingKeys: String, CodingKey { case accountId, hours }
}

public struct TokenHour: Sendable, Equatable {
    public var start: Date
    public var input: Int
    public var output: Int
    public var cacheRead: Int
    public var cacheWrite: Int

    public init(start: Date, input: Int = 0, output: Int = 0, cacheRead: Int = 0, cacheWrite: Int = 0) {
        self.start = start
        self.input = input
        self.output = output
        self.cacheRead = cacheRead
        self.cacheWrite = cacheWrite
    }

    // Sums held at Int.max: every row can be in range and a quarter of a
    // million of them not (cross-lab review, 7 Nov).
    public var total: Int { input.adding(saturating: output).adding(saturating: cacheRead).adding(saturating: cacheWrite) }

    static func + (a: TokenHour, b: TokenHour) -> TokenHour {
        TokenHour(start: a.start, input: a.input.adding(saturating: b.input), output: a.output.adding(saturating: b.output),
                  cacheRead: a.cacheRead.adding(saturating: b.cacheRead), cacheWrite: a.cacheWrite.adding(saturating: b.cacheWrite))
    }
}

public struct LimitHistory: Sendable, Equatable, Decodable {
    public var accountId: String
    public var kind: String
    /// A model's own week's title ("Weekly Fable"); nil for the main two.
    public var title: String?
    public var samples: [LimitSample]

    public init(accountId: String, kind: String, title: String? = nil, samples: [LimitSample]) {
        self.accountId = accountId
        self.kind = kind
        self.title = title
        self.samples = samples
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        accountId = try c.decode(String.self, forKey: .accountId)
        kind = try c.decode(String.self, forKey: .kind)
        title = (try? c.decodeIfPresent(String.self, forKey: .title)) ?? nil
        let rows = (try? c.decodeIfPresent([[Double]].self, forKey: .samples)) ?? []
        samples = rows.compactMap { row in
            guard row.count >= 2, row[0].isFinite, row[1].isFinite else { return nil }
            return LimitSample(at: Date(timeIntervalSince1970: row[0] / 1000), remainingPercent: min(100, max(0, row[1])))
        }.sorted { $0.at < $1.at }
    }

    enum CodingKeys: String, CodingKey { case accountId, kind, title, samples }
}

public struct LimitSample: Sendable, Equatable {
    public var at: Date
    public var remainingPercent: Double

    public init(at: Date, remainingPercent: Double) {
        self.at = at
        self.remainingPercent = remainingPercent
    }
}

// MARK: Sums

/// The Usage panel's sums over `UsageStats`, in the app's own time zone.
public enum UsageStatsMath {
    /// One bar of a chart: a login's tokens in an hour or a day.
    public struct Bar: Sendable, Hashable {
        public var start: Date
        public var accountId: String
        public var tokens: Int
    }

    /// Tokens the logins spent in [from, to), by whole hours (an hour
    /// counts if it starts in the range).
    public static func total(_ stats: UsageStats, accounts: [String], from: Date, to: Date) -> TokenHour {
        var sum = TokenHour(start: from)
        for id in accounts {
            for hour in stats.hours(id) where hour.start >= from && hour.start < to { sum = sum + hour }
        }
        return sum
    }

    /// Today so far.
    public static func today(_ stats: UsageStats, accounts: [String], now: Date, calendar: Calendar = .current) -> TokenHour {
        total(stats, accounts: accounts, from: calendar.startOfDay(for: now), to: now.addingTimeInterval(1))
    }

    /// The last 60 minutes, as near as hourly buckets allow: this hour so
    /// far, plus the part of the last hour that's still inside the 60.
    public static func lastHour(_ stats: UsageStats, accounts: [String], now: Date, calendar: Calendar = .current) -> Int {
        guard let thisHour = calendar.dateInterval(of: .hour, for: now)?.start else { return 0 }
        let previous = thisHour.addingTimeInterval(-3600)
        let elapsed = now.timeIntervalSince(thisHour) / 3600
        let current = total(stats, accounts: accounts, from: thisHour, to: thisHour.addingTimeInterval(3600)).total
        let before = total(stats, accounts: accounts, from: previous, to: thisHour).total
        return current.adding(saturating: Int(saturating: (Double(before) * (1 - elapsed)).rounded()))
    }

    /// What a usual day had spent by this time of day: the average of the
    /// previous `days` days from midnight to the same clock time. Nil when
    /// the stats don't go back that far.
    public static func usualByNow(_ stats: UsageStats, accounts: [String], now: Date, days: Int = 7, calendar: Calendar = .current) -> Int? {
        let earliest = accounts.compactMap { stats.hours($0).first?.start }.min()
        let today = calendar.startOfDay(for: now)
        guard let earliest, let first = calendar.date(byAdding: .day, value: -days, to: today), earliest < calendar.date(byAdding: .day, value: 1, to: first)! else { return nil }
        let sinceMidnight = now.timeIntervalSince(today)
        var sum = 0
        for back in 1...days {
            guard let day = calendar.date(byAdding: .day, value: -back, to: today) else { continue }
            sum = sum.adding(saturating: total(stats, accounts: accounts, from: day, to: day.addingTimeInterval(sinceMidnight + 1)).total)
        }
        return sum / days
    }

    /// Today's hours from midnight to now, one bar per login per hour,
    /// zeros left out.
    public static func todayByHour(_ stats: UsageStats, accounts: [String], now: Date, calendar: Calendar = .current) -> [Bar] {
        let start = calendar.startOfDay(for: now)
        var bars: [Bar] = []
        for id in accounts {
            for hour in stats.hours(id) where hour.start >= start && hour.start <= now && hour.total > 0 {
                let slot = calendar.dateInterval(of: .hour, for: hour.start)?.start ?? hour.start
                bars.append(Bar(start: slot, accountId: id, tokens: hour.total))
            }
        }
        return merge(bars)
    }

    /// The last `days` days, today included, one bar per login per day.
    public static func byDay(_ stats: UsageStats, accounts: [String], days: Int, now: Date, calendar: Calendar = .current) -> [Bar] {
        let today = calendar.startOfDay(for: now)
        guard let first = calendar.date(byAdding: .day, value: -(days - 1), to: today) else { return [] }
        var bars: [Bar] = []
        for id in accounts {
            for hour in stats.hours(id) where hour.start >= first && hour.total > 0 {
                bars.append(Bar(start: calendar.startOfDay(for: hour.start), accountId: id, tokens: hour.total))
            }
        }
        return merge(bars)
    }

    private static func merge(_ bars: [Bar]) -> [Bar] {
        var order: [String] = []
        var sums: [String: Bar] = [:]
        for bar in bars {
            let key = "\(bar.start.timeIntervalSince1970)|\(bar.accountId)"
            if var have = sums[key] {
                have.tokens = have.tokens.adding(saturating: bar.tokens)
                sums[key] = have
            } else {
                order.append(key)
                sums[key] = bar
            }
        }
        return order.compactMap { sums[$0] }.sorted { ($0.start, $0.accountId) < ($1.start, $1.accountId) }
    }

    // MARK: Words

    /// "4.2M", "380k", "12.4k", "912".
    public static func tokens(_ n: Int) -> String {
        let value = Double(n)
        func short(_ v: Double, _ suffix: String) -> String {
            let text = v < 10 ? String(format: "%.1f", v) : String(Int(saturating: v.rounded()))
            return (text.hasSuffix(".0") ? String(text.dropLast(2)) : text) + suffix
        }
        if value >= 1_000_000_000 { return short(value / 1_000_000_000, "B") }
        if value >= 1_000_000 { return short(value / 1_000_000, "M") }
        if value >= 1_000 { return short(value / 1_000, "k") }
        return "\(n)"
    }

    /// The tooltip's breakdown: "4.2M tokens: 3.9M cache reads, 210k cache
    /// writes, 40k input, 52k output".
    public static func breakdown(_ sum: TokenHour) -> String {
        let parts = [(sum.cacheRead, "cache reads"), (sum.cacheWrite, "cache writes"), (sum.input, "input"), (sum.output, "output")]
            .filter { $0.0 > 0 }.map { "\(tokens($0.0)) \($0.1)" }
        let head = "\(tokens(sum.total)) tokens"
        return parts.isEmpty ? head : head + ": " + parts.joined(separator: ", ")
    }
}

// MARK: Pace

/// How fast a login's window is going down, and whether it lasts until it
/// resets. Worked out from the window alone (what's gone since it started,
/// over the time since), or from the readings over the last day when
/// there are enough of them, as the week's average hides a busy day.
public struct LimitPace: Sendable, Equatable {
    /// Percentage points a day (weekly) or an hour (5-hour) at this rate.
    public var rate: Double
    /// When it runs out at this rate, if that's before the reset.
    public var runsOutAt: Date?
    /// What's left when it resets, if it lasts.
    public var leftAtReset: Double?

    public static func of(_ window: UsageWindow, samples: [LimitSample], now: Date) -> LimitPace? {
        guard let reset = window.resetsAt, reset > now else { return nil }
        let span: TimeInterval
        switch window.kind {
        case "five_hour": span = 5 * 3600
        // A model's own week ("Weekly Fable") goes like the main one.
        case "weekly", "weekly_model": span = 7 * 86400
        default: return nil
        }
        let week = span > 86400
        let start = reset.addingTimeInterval(-span)
        let left = window.remainingPercent
        var perHour: Double?
        if week {
            // The readings of the last day, within this window: the oldest
            // one to now. Only with at least half a day of them.
            let since = max(start, now.addingTimeInterval(-86400))
            if let oldest = samples.first(where: { $0.at >= since && $0.at < now }), now.timeIntervalSince(oldest.at) >= 12 * 3600 {
                perHour = max(0, oldest.remainingPercent - left) / (now.timeIntervalSince(oldest.at) / 3600)
            }
        }
        if perHour == nil {
            let elapsed = now.timeIntervalSince(start) / 3600
            // Too early in the window to say anything.
            guard elapsed >= (week ? 2 : 0.25) else { return nil }
            perHour = max(0, 100 - left) / elapsed
        }
        guard let perHour else { return nil }
        let unit: Double = week ? 24 : 1
        var pace = LimitPace(rate: perHour * unit, runsOutAt: nil, leftAtReset: nil)
        let toReset = reset.timeIntervalSince(now) / 3600
        if perHour > 0, left / perHour < toReset {
            pace.runsOutAt = now.addingTimeInterval(left / perHour * 3600)
        } else {
            pace.leftAtReset = max(0, left - perHour * toReset)
        }
        return pace
    }

    /// "Runs out Sat 2 pm at this pace" or "Lasts till it resets".
    public func outlook(now: Date, calendar: Calendar = .current) -> String {
        if let runsOutAt { return "Runs out " + AccountUsageText.resetTime(runsOutAt, now: now, calendar: calendar) }
        return "Lasts till it resets"
    }

    /// What to do about a window, in one line under its meter. Mike, 5 Nov:
    /// the graphs are good but he wants something to act on when he looks,
    /// so each line says what happens at this pace and what that means
    /// (runs out two days early, or a third of it goes to waste) rather
    /// than only when it resets.
    public struct Verdict: Sendable, Equatable {
        public enum Tone: Sendable, Equatable {
            /// Used up now.
            case out
            /// Runs out before it resets: spend it more slowly, or elsewhere.
            case short
            /// A good part of it will go unused: lean on this one.
            case spare
            /// Nothing to do.
            case fine
        }
        public var text: String
        public var tone: Tone
    }

    /// How much of a weekly window left unused at the reset is worth
    /// pointing at. Under this it's just about right.
    public static let spareWorthSaying: Double = 15

    public static func verdict(_ window: UsageWindow, pace: LimitPace?, stale: Bool, now: Date, calendar: Calendar = .current) -> Verdict? {
        let reset = window.resetsAt.map { AccountUsageText.resetTime($0, now: now, calendar: calendar) }
        if window.remainingPercent < 1, let reset {
            return Verdict(text: "Used up, back " + reset, tone: .out)
        }
        // Old numbers can't say how fast it's going now.
        if let pace, !stale {
            if let runsOutAt = pace.runsOutAt {
                var text = "Runs out " + AccountUsageText.resetTime(runsOutAt, now: now, calendar: calendar)
                if let resetsAt = window.resetsAt { text += ", " + gap(resetsAt.timeIntervalSince(runsOutAt)) + " before it resets" }
                return Verdict(text: text, tone: .short)
            }
            // Only the week: a 5-hour window nearly always has room left
            // over, so saying so would be on every row and mean nothing.
            if window.kind == "weekly", let left = pace.leftAtReset, let reset {
                if left >= spareWorthSaying {
                    return Verdict(text: "About \(AccountUsageText.percent(left)) will go unused, resets " + reset, tone: .spare)
                }
                return Verdict(text: "On track, lasts till " + reset, tone: .fine)
            }
        }
        return reset.map { Verdict(text: "Resets " + $0, tone: .fine) }
    }

    /// "2 days", "1 day", "5 hours", "1 hour", "40 min": roughly how long,
    /// as nobody plans around "1 day 7 hours".
    static func gap(_ seconds: TimeInterval) -> String {
        let hours = seconds / 3600
        if hours >= 36 { return "\(Int(saturating: (hours / 24).rounded())) days" }
        if hours >= 24 { return "1 day" }
        if hours >= 1.5 { return "\(Int(saturating: hours.rounded())) hours" }
        if hours >= 1 { return "1 hour" }
        return "\(max(1, Int(saturating: (seconds / 60).rounded()))) min"
    }

    /// "9% a day", "12% an hour".
    public func rateText(kind: String) -> String {
        let value = rate < 1 ? String(format: "%.1f", rate) : String(Int(saturating: rate.rounded()))
        return value + (kind == "five_hour" ? "% an hour" : "% a day")
    }
}
