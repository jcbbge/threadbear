import AppKit
import SwiftUI
import ThreadbearCore

/// The Scheduled page: what clicking Scheduled in the activity bar shows
/// in the detail area, beside the sidebar's list. The bear winding its
/// alarm clock, a line on what schedules are, what's next and the numbers.
struct ScheduledHome: View {
    @Environment(AppModel.self) private var app

    var body: some View {
        HomePage(picture: Art.scheduled, pictureLabel: "The bear winding a big alarm clock, beside a calendar", pokes: PokeLines.scheduled,
                 stats: app.schedulesSupported ? ScheduledStats.tiles(app.schedules, now: app.now) : []) {
            VStack(alignment: .leading, spacing: zoomed(12)) {
                HomeTitle(title: "Scheduled",
                          line: "Messages that send themselves later, once or on repeat.",
                          more: Self.more)
                let next = ScheduledStats.next(app.schedules)
                HomeStatusLine(text: next.map { "Next: \(ScheduledStats.title($0)), \(ScheduledStats.when($0, now: app.now))" } ?? "Nothing coming up",
                               busy: next != nil)
            }
        }
    }

    static let more = "Once at a set time, or over and over, like every weekday at 9. Each goes to a thread, or starts a new thread each time. Agents book them too, to check back on something. Make one with New schedule in the list, from Schedule… in a composer, or by asking an agent. A schedule that sends to a thread puts it under Waiting until then. A schedule that starts a new thread can run on another of your Macs (Runs on). Schedules live in your Convex backend, so with no internet they wait."
}

/// The page's numbers, from the schedules the app already has.
enum ScheduledStats {
    /// The active schedule due soonest.
    static func next(_ schedules: [Schedule]) -> Schedule? {
        schedules.filter(\.isActive).compactMap { s in s.nextRunAt.map { (s, $0) } }.min { $0.1 < $1.1 }?.0
    }

    static func title(_ schedule: Schedule) -> String {
        schedule.title.isEmpty ? "Untitled" : schedule.title
    }

    /// "in 12 min", "at 14:00", "Fri 9:00".
    static func when(_ schedule: Schedule, now: Date) -> String {
        guard let at = schedule.nextRunAt else { return schedule.whenText }
        let seconds = at.timeIntervalSince(now)
        if seconds < 60 { return "any moment" }
        if seconds < 3600 { return "in \(Int(seconds / 60)) min" }
        let calendar = Calendar.current
        return calendar.isDate(at, inSameDayAs: now) ? "at " + RelativeTime.until(at, now: now) : RelativeTime.until(at, now: now)
    }

    static func tiles(_ schedules: [Schedule], now: Date) -> [HomeStat] {
        let active = schedules.filter(\.isActive)
        let dayAhead = active.filter { ($0.nextRunAt ?? .distantFuture) <= now.addingTimeInterval(86_400) }.count
        let repeating = active.filter { !$0.isOneOff }.count
        let byAgents = active.filter { $0.createdBy != nil }.count
        let paused = schedules.filter { $0.paused && !$0.isFinished }.count
        let runs = schedules.reduce(0) { $0.adding(saturating: $1.runs) }
        return [
            HomeStat(value: "\(active.count)", label: "On",
                     help: "Schedules that will still run: not paused and not finished"),
            HomeStat(value: "\(dayAhead)", label: "Due in a day",
                     help: "On schedules due to run in the next 24 hours"),
            HomeStat(value: "\(repeating)", label: "Repeating",
                     help: "On schedules that run over and over, rather than once"),
            HomeStat(value: "\(byAgents)", label: byAgents == 1 ? "Set by a thread" : "Set by threads",
                     help: "On schedules an agent booked, usually to check back on its own thread"),
            HomeStat(value: "\(paused)", label: "Paused",
                     help: "Schedules waiting for you to resume them"),
            HomeStat(value: "\(runs)", label: runs == 1 ? "Run so far" : "Runs so far",
                     help: "Times the schedules in the list have sent their message"),
        ]
    }
}
