import Foundation

/// The editor's "Repeat" choices. Each preset only builds a cron string; the
/// runner works out what it means (`schedules.preview`), so the app never
/// reads cron itself beyond recognising its own presets when editing.
public struct RepeatChoice: Sendable, Hashable {
    public enum Kind: String, Sendable, Hashable, CaseIterable, Identifiable {
        case hourly, daily, weekdays, weekly, monthly, custom
        public var id: String { rawValue }

        public var title: String {
            switch self {
            case .hourly: return "Every hour"
            case .daily: return "Every day"
            case .weekdays: return "Weekdays"
            case .weekly: return "Every week"
            case .monthly: return "Every month"
            case .custom: return "Custom"
            }
        }

        public var symbol: String {
            switch self {
            case .hourly: return "clock"
            case .daily: return "sun.max"
            case .weekdays: return "briefcase"
            case .weekly: return "calendar"
            case .monthly: return "calendar.badge.clock"
            case .custom: return "slider.horizontal.3"
            }
        }
    }

    public var kind: Kind
    public var hour: Int
    public var minute: Int
    /// Cron's day of the week: 0 is Sunday, 6 Saturday.
    public var weekday: Int
    /// Day of the month, 1 to 31 (a month without it is skipped, as in cron).
    public var day: Int
    /// What's typed in the cron field for Custom.
    public var custom: String

    public init(kind: Kind = .weekdays, hour: Int = 9, minute: Int = 0, weekday: Int = 1, day: Int = 1, custom: String = "") {
        self.kind = kind
        self.hour = hour
        self.minute = minute
        self.weekday = weekday
        self.day = day
        self.custom = custom
    }

    /// The cron string the choice stands for. Every hour runs on the hour.
    public var cron: String {
        switch kind {
        case .hourly: return "0 * * * *"
        case .daily: return "\(minute) \(hour) * * *"
        case .weekdays: return "\(minute) \(hour) * * 1-5"
        case .weekly: return "\(minute) \(hour) * * \(weekday)"
        case .monthly: return "\(minute) \(hour) \(day) * *"
        case .custom: return custom.trimmingCharacters(in: .whitespacesAndNewlines)
        }
    }

    /// The preset a schedule's cron came from, so editing it shows the
    /// same choice; anything else (an agent's "*/15 9-17 * * *") is Custom,
    /// with the cron in the field.
    public init(cron: String) {
        self.init(custom: cron)
        let fields = cron.split(whereSeparator: \.isWhitespace).map(String.init)
        guard fields.count == 5, let minute = Int(fields[0]), (0...59).contains(minute) else {
            kind = .custom
            return
        }
        if fields[1] == "*", fields[2] == "*", fields[3] == "*", fields[4] == "*" {
            if minute == 0 { kind = .hourly } else { kind = .custom }
            return
        }
        guard let hour = Int(fields[1]), (0...23).contains(hour), fields[3] == "*" else {
            kind = .custom
            return
        }
        self.hour = hour
        self.minute = minute
        switch (fields[2], fields[4]) {
        case ("*", "*"): kind = .daily
        case ("*", "1-5"): kind = .weekdays
        case ("*", let dow):
            if let weekday = Int(dow), (0...7).contains(weekday) {
                kind = .weekly
                self.weekday = weekday % 7
            } else {
                kind = .custom
            }
        case (let dom, "*"):
            if let day = Int(dom), (1...31).contains(day) {
                kind = .monthly
                self.day = day
            } else {
                kind = .custom
            }
        default:
            kind = .custom
        }
    }
}

public enum ScheduleTime {
    /// "in 12m", "in 3h", "in 2 days", or "now" once it's due.
    public static func relative(_ date: Date, now: Date) -> String {
        let seconds = date.timeIntervalSince(now)
        if seconds <= 0 { return "now" }
        let minutes = Int(saturating: (seconds / 60).rounded(.up))
        if minutes < 60 { return "in \(minutes)m" }
        let hours = Int(saturating: (seconds / 3600).rounded())
        if hours < 24 { return "in \(hours)h" }
        let days = Int(saturating: (seconds / 86_400).rounded())
        return days == 1 ? "in 1 day" : "in \(days) days"
    }

    /// "next in 3h", or "due now" for one the runner is about to send (or
    /// catching up on after the Mac slept).
    public static func next(_ date: Date, now: Date) -> String {
        let text = relative(date, now: now)
        return text == "now" ? "due now" : "next " + text
    }

    /// Where the editor's "Once" picker starts: the next whole hour at
    /// least a quarter of an hour away.
    public static func defaultOnce(now: Date, calendar: Calendar = .current) -> Date {
        let later = now.addingTimeInterval(15 * 60)
        let hour = calendar.dateInterval(of: .hour, for: later)?.start ?? later
        return hour < later ? hour.addingTimeInterval(3600) : hour
    }
}

/// A thread's schedules, for the Scheduled group in its Highlights: what
/// sends to it, what its agent made, and the one that started it. They sat
/// as one line over the composer ("3 schedules · next in 7 days") until
/// Mike asked for them in Highlights with the rest of what the thread has
/// made (29 Oct).
public enum ScheduleRows {
    public struct Row: Sendable, Hashable, Identifiable {
        public var id: String
        public var title: String
        /// At the end of the title's line: "in 3h", "due now", "paused".
        public var when: String?
        /// The runner's words for the time ("Weekdays at 9:00"), and where
        /// it goes when that isn't this thread.
        public var detail: String
        public var paused: Bool
    }

    /// Active ones soonest first, then paused ones; a one-off that has run
    /// is left out, unless it's the schedule that started the thread.
    /// `target` names where a schedule goes that isn't this thread
    /// ("New thread in misc").
    public static func rows(for thread: ThreadSummary, in schedules: [Schedule], now: Date, target: (Schedule) -> String) -> [Row] {
        let origin = thread.schedule?.id
        let mine = schedules.filter { $0.belongs(to: thread.id) || $0.id == origin }
        let kept = mine.filter { !$0.isFinished || $0.id == origin }
        let sorted = kept.sorted { a, b in
            if a.isActive != b.isActive { return a.isActive }
            switch (a.nextRunAt, b.nextRunAt) {
            case let (x?, y?): return x < y
            case (_?, nil): return true
            case (nil, _?): return false
            case (nil, nil): return a.createdAt < b.createdAt
            }
        }
        return sorted.map { schedule in
            // "Started this thread" leads, so a long cron can't push it
            // off the end of the line.
            var parts: [String] = schedule.id == origin ? ["Started this thread"] : []
            if !schedule.whenText.isEmpty { parts.append(schedule.whenText) }
            if schedule.id != origin, schedule.threadId != thread.id { parts.append(target(schedule)) }
            let when: String? = schedule.paused ? "paused"
                : schedule.isFinished ? nil
                : schedule.nextRunAt.map { ScheduleTime.relative($0, now: now) }.map { $0 == "now" ? "due now" : $0 }
            return Row(id: schedule.id, title: schedule.title.isEmpty ? "Untitled" : schedule.title,
                       when: when, detail: parts.joined(separator: " · "), paused: schedule.paused)
        }
    }
}

/// The line a schedule's message starts with, `[Scheduled: "<title>",
/// <whenText>]` (docs/protocol.md, "Schedules"). The transcript shows it as
/// a label rather than as part of the message.
public struct ScheduledHeader: Sendable, Hashable {
    public var title: String
    public var whenText: String
    /// The message without the header line.
    public var body: String

    public init?(_ text: String) {
        let lines = text.split(separator: "\n", maxSplits: 1, omittingEmptySubsequences: false)
        guard let first = lines.first?.trimmingCharacters(in: .whitespaces),
              first.hasPrefix("[Scheduled: \""), first.hasSuffix("]") else { return nil }
        let inner = first.dropFirst("[Scheduled: \"".count).dropLast()
        // The title may hold quotes and commas; the runner's words for the
        // time never hold `", `, so the last one splits them.
        guard let split = inner.range(of: "\", ", options: .backwards) else { return nil }
        title = String(inner[..<split.lowerBound])
        whenText = String(inner[split.upperBound...])
        body = lines.count > 1 ? String(lines[1]).trimmingCharacters(in: .newlines) : ""
    }
}

/// Words for a thread a schedule started (its summary's `schedule`), for
/// the clock on its sidebar row and the chip in its header.
public enum StartedBySchedule {
    /// What the schedule is now, if it's still there: when it runs, or that
    /// it's paused. Its title as it was when it started the thread, as the
    /// schedule may since have been renamed or deleted.
    public static func tip(_ origin: ThreadSchedule, current: Schedule?) -> String {
        let named = "Started by a schedule: \(origin.title.isEmpty ? "Untitled" : origin.title)"
        guard let current else { return named + ". It has since been deleted." }
        let when = current.paused ? "paused" : current.whenText
        return when.isEmpty ? named + ". Click to edit it." : named + " (\(when)). Click to edit it."
    }
}

/// The Scheduled list's headings, folded like the inbox's (Mike asked 30
/// Oct, with 31 schedules in one list): what's coming up, what's paused,
/// and one-offs that have run.
public enum ScheduleSection: String, Sendable, CaseIterable {
    case active, paused, done

    public var title: String {
        switch self {
        case .active: return "Active"
        case .paused: return "Paused"
        case .done: return "Done"
        }
    }

    /// A one-off that has run is done even if it was paused first: it
    /// won't run again either way.
    public static func of(_ schedule: Schedule) -> ScheduleSection {
        schedule.isFinished ? .done : schedule.paused ? .paused : .active
    }

    /// The schedules under each heading, keeping the runner's order.
    public static func group(_ schedules: [Schedule]) -> [ScheduleSection: [Schedule]] {
        Dictionary(grouping: schedules, by: of)
    }
}
