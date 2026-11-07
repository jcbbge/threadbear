import Foundation

/// The Den's few lines about you, from the threads the app already has.
/// A line with nothing to say is left out, so a new install's Den is short.
/// `ThreadSummary.sample` threads (the tour's made-up ones) don't count.
public enum DenLines {
    public static func make(_ threads: some Sequence<ThreadSummary>, now: Date, calendar: Calendar = .current) -> [String] {
        let real = threads.filter { !$0.sample }
        let dates = real.map(\.createdAt).filter { $0 > .distantPast }
        var lines: [String] = []
        if let first = dates.min() {
            let count = real.count
            lines.append("\(number(count)) \(count == 1 ? "thread" : "threads") since \(day(first, calendar: calendar)).")
        }
        if let busiest = busiestDay(dates, calendar: calendar), busiest.count > 1 {
            lines.append("Busiest day: \(day(busiest.day, calendar: calendar)), \(number(busiest.count)) threads. Sorry.")
        }
        let hibernating = real.filter { !$0.isArchived && $0.isSnoozed(at: now) }.count
        if hibernating > 0 { lines.append("\(number(hibernating)) hibernating. Snoring, mostly.") }
        return lines
    }

    /// "Stitched together from fa772646 on 7 Nov." Nil when the build doesn't
    /// say (a debug build, one with no date).
    public static func build(short: String, builtAt: String, calendar: Calendar = .current) -> String? {
        guard !short.isEmpty else { return nil }
        let formatter = ISO8601DateFormatter()
        guard let built = formatter.date(from: builtAt) else { return "Stitched together from \(short)." }
        return "Stitched together from \(short) on \(day(built, calendar: calendar))."
    }

    public static let credit = "Made in Busselton by Mike and a lot of bears."

    private static func busiestDay(_ dates: [Date], calendar: Calendar) -> (day: Date, count: Int)? {
        let byDay = Dictionary(grouping: dates) { calendar.startOfDay(for: $0) }.mapValues(\.count)
        // The most recent of any tie, so the answer doesn't change between looks.
        return byDay.max { ($0.value, $0.key) < ($1.value, $1.key) }.map { (day: $0.key, count: $0.value) }
    }

    private static func day(_ date: Date, calendar: Calendar) -> String {
        let formatter = DateFormatter()
        formatter.calendar = calendar
        formatter.timeZone = calendar.timeZone
        formatter.locale = Locale(identifier: "en_AU")
        formatter.setLocalizedDateFormatFromTemplate("dMMM")
        return formatter.string(from: date)
    }

    private static func number(_ value: Int) -> String {
        value.formatted(.number.locale(Locale(identifier: "en_AU")))
    }
}
