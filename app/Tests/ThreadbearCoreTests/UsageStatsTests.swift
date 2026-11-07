import XCTest
@testable import ThreadbearCore

/// The Usage panel's spend numbers (`usage.stats`, docs/protocol.md "Usage
/// history"): decoding, today's and the last hour's sums, the usual day,
/// the charts' bars, and how fast a window is going.
final class UsageStatsTests: XCTestCase {
    private var calendar: Calendar {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "Australia/Perth")!
        return calendar
    }

    private func at(day: Int = 29, _ hour: Int, _ minute: Int = 0) -> Date {
        calendar.date(from: DateComponents(year: 2026, month: 10, day: day, hour: hour, minute: minute))!
    }

    private func hour(day: Int = 29, _ h: Int, _ tokens: Int) -> TokenHour {
        TokenHour(start: at(day: day, h), input: 0, output: tokens / 10, cacheRead: tokens - tokens / 10, cacheWrite: 0)
    }

    func testDecodesTheRunnersShapeAndSkipsBadRows() throws {
        let json = """
        {"generatedAt":"2026-10-29T02:00:00.000Z","ready":false,
         "tokens":[{"accountId":"c1","hours":[[1761703200000,10,20,300,4],[1],[1761699600000,1,2,3,4]]},{"hours":[]}],
         "limits":[{"accountId":"c1","kind":"weekly","samples":[[1761703200000,40.5],[1761699600000,120]]}],
         "somethingNew":1}
        """
        let stats = try JSONDecoder().decode(UsageStats.self, from: Data(json.utf8))
        XCTAssertFalse(stats.ready)
        XCTAssertEqual(stats.tokens.count, 1)
        let hours = stats.hours("c1")
        XCTAssertEqual(hours.count, 2)
        XCTAssertEqual(hours.first?.total, 10, "oldest first")
        XCTAssertEqual(hours.last?.total, 334)
        let samples = stats.samples("c1", kind: "weekly")
        XCTAssertEqual(samples.map(\.remainingPercent), [100, 40.5], "sorted, and clamped to 100")
        XCTAssertEqual(stats.samples("c1", kind: "five_hour"), [])
    }

    func testTodayCountsFromLocalMidnight() {
        let stats = UsageStats(generatedAt: at(10), tokens: [
            AccountTokens(accountId: "a", hours: [hour(day: 28, 23, 500), hour(0, 1_000), hour(9, 2_000)]),
            AccountTokens(accountId: "b", hours: [hour(9, 300)]),
        ])
        let now = at(9, 30)
        XCTAssertEqual(UsageStatsMath.today(stats, accounts: ["a", "b"], now: now, calendar: calendar).total, 3_300)
        XCTAssertEqual(UsageStatsMath.today(stats, accounts: ["b"], now: now, calendar: calendar).total, 300)
    }

    func testLastHourTakesTheTailOfThePreviousHour() {
        let stats = UsageStats(generatedAt: at(10), tokens: [AccountTokens(accountId: "a", hours: [hour(8, 1_000), hour(9, 400)])])
        // At 9:15, three quarters of 8 o'clock's hour is still inside the 60.
        XCTAssertEqual(UsageStatsMath.lastHour(stats, accounts: ["a"], now: at(9, 15), calendar: calendar), 400 + 750)
    }

    func testUsualByNowAveragesTheSameTimeOnPreviousDays() {
        var hours: [TokenHour] = []
        for day in 22...28 {
            hours.append(hour(day: day, 8, 700)) // before 9:30, counts
            hours.append(hour(day: day, 15, 9_000)) // after, doesn't
        }
        let stats = UsageStats(generatedAt: at(10), tokens: [AccountTokens(accountId: "a", hours: hours)])
        XCTAssertEqual(UsageStatsMath.usualByNow(stats, accounts: ["a"], now: at(9, 30), calendar: calendar), 700)
        // Only two days of history: no usual day yet.
        let short = UsageStats(generatedAt: at(10), tokens: [AccountTokens(accountId: "a", hours: [hour(day: 28, 8, 700)])])
        XCTAssertNil(UsageStatsMath.usualByNow(short, accounts: ["a"], now: at(9, 30), calendar: calendar))
    }

    func testBarsByHourAndByDay() {
        let stats = UsageStats(generatedAt: at(10), tokens: [
            AccountTokens(accountId: "a", hours: [hour(day: 27, 10, 100), hour(day: 28, 9, 50), hour(day: 28, 10, 50), hour(8, 10), hour(9, 0)]),
            AccountTokens(accountId: "b", hours: [hour(8, 5)]),
        ])
        let now = at(9, 30)
        let today = UsageStatsMath.todayByHour(stats, accounts: ["a", "b"], now: now, calendar: calendar)
        XCTAssertEqual(today.map(\.accountId), ["a", "b"], "zeros left out")
        XCTAssertEqual(today.map(\.tokens), [10, 5])
        let days = UsageStatsMath.byDay(stats, accounts: ["a", "b"], days: 2, now: now, calendar: calendar)
        XCTAssertEqual(days.map(\.tokens), [100, 10, 5], "the 27th is outside two days; the 28th's hours add up")
        XCTAssertEqual(days.first?.start, at(day: 28, 0))
    }

    func testTokenWords() {
        XCTAssertEqual(UsageStatsMath.tokens(912), "912")
        XCTAssertEqual(UsageStatsMath.tokens(12_400), "12k")
        XCTAssertEqual(UsageStatsMath.tokens(4_400), "4.4k")
        XCTAssertEqual(UsageStatsMath.tokens(380_000), "380k")
        XCTAssertEqual(UsageStatsMath.tokens(4_000_000), "4M")
        XCTAssertEqual(UsageStatsMath.tokens(4_210_000), "4.2M")
        XCTAssertEqual(UsageStatsMath.tokens(1_500_000_000), "1.5B")
        XCTAssertEqual(UsageStatsMath.breakdown(TokenHour(start: at(0), input: 40_000, output: 52_000, cacheRead: 3_900_000)),
                       "4M tokens: 3.9M cache reads, 40k input, 52k output")
    }

    // MARK: Pace

    private func weekly(_ left: Double, resets: Date) -> UsageWindow {
        UsageWindow(kind: "weekly", title: "Weekly", remainingPercent: left, resetsAt: resets)
    }

    func testAWeekGoingTooFastRunsOutBeforeItResets() {
        // Three and a half days in, 30% left: 20% a day, 1.5 days to go
        // and 3.5 until the reset.
        let now = at(12)
        let window = weekly(30, resets: now.addingTimeInterval(3.5 * 86400))
        let pace = LimitPace.of(window, samples: [], now: now)!
        XCTAssertEqual(pace.rate, 20, accuracy: 0.01)
        XCTAssertEqual(pace.runsOutAt!.timeIntervalSince(now), 1.5 * 86400, accuracy: 1)
        XCTAssertNil(pace.leftAtReset)
        XCTAssertEqual(pace.rateText(kind: "weekly"), "20% a day")
    }

    func testAWeekThatLastsSaysWhatsLeftAtTheReset() {
        let now = at(12)
        let window = weekly(80, resets: now.addingTimeInterval(5 * 86400))
        let pace = LimitPace.of(window, samples: [], now: now)!
        XCTAssertEqual(pace.rate, 10, accuracy: 0.01)
        XCTAssertNil(pace.runsOutAt)
        XCTAssertEqual(pace.leftAtReset!, 30, accuracy: 0.01)
        XCTAssertEqual(pace.outlook(now: now, calendar: calendar), "Lasts till it resets")
    }

    func testTheLastDaysReadingsWinOverTheWeeksAverage() {
        // A quiet start to the week, then a busy last day: 60% to 40% in
        // the last 20 hours is 24% a day, not the week's 15%.
        let now = at(12)
        let window = weekly(40, resets: now.addingTimeInterval(3 * 86400))
        let samples = [LimitSample(at: now.addingTimeInterval(-30 * 3600), remainingPercent: 62),
                       LimitSample(at: now.addingTimeInterval(-20 * 3600), remainingPercent: 60),
                       LimitSample(at: now.addingTimeInterval(-3600), remainingPercent: 41)]
        let pace = LimitPace.of(window, samples: samples, now: now)!
        XCTAssertEqual(pace.rate, 24, accuracy: 0.01)
        // Under half a day of readings: the week's average instead.
        let recent = [LimitSample(at: now.addingTimeInterval(-6 * 3600), remainingPercent: 45)]
        XCTAssertEqual(LimitPace.of(window, samples: recent, now: now)!.rate, 15, accuracy: 0.01)
    }

    func testFablesOwnWeekGoesLikeAWeekButNeverSaysGoingSpare() {
        // Three and a half days in, 30% of Fable's week left: 20% a day,
        // out in 1.5 days, as the main week would be.
        let now = at(12)
        let fable = UsageWindow(kind: "weekly_model", title: "Weekly Fable", remainingPercent: 30, resetsAt: now.addingTimeInterval(3.5 * 86400))
        let pace = LimitPace.of(fable, samples: [], now: now)!
        XCTAssertEqual(pace.rate, 20, accuracy: 0.01)
        XCTAssertEqual(pace.rateText(kind: "weekly_model"), "20% a day")
        XCTAssertEqual(LimitPace.verdict(fable, pace: pace, stale: false, now: now, calendar: calendar)?.tone, .short)
        // Untouched: most logins never run out of Fable, so "100% will go
        // unused" on each would be noise. Just when it resets.
        let untouched = UsageWindow(kind: "weekly_model", title: "Weekly Fable", remainingPercent: 100, resetsAt: now.addingTimeInterval(5 * 86400))
        let verdict = LimitPace.verdict(untouched, pace: LimitPace.of(untouched, samples: [], now: now), stale: false, now: now, calendar: calendar)!
        XCTAssertEqual(verdict.tone, .fine)
        XCTAssertEqual(verdict.text, "Resets Tue 12 pm")
    }

    func testAModelsWeekReadingsAreFoundByTitle() throws {
        let json = #"""
        {"generatedAt":"2026-11-06T00:00:00Z","ready":true,"tokens":[],"limits":[
          {"accountId":"a","kind":"weekly","samples":[[1793000000000,50]]},
          {"accountId":"a","kind":"weekly_model","title":"Weekly Opus","samples":[[1793000000000,80]]},
          {"accountId":"a","kind":"weekly_model","title":"Weekly Fable","samples":[[1793000000000,70]]}]}
        """#
        let stats = try JSONDecoder().decode(UsageStats.self, from: Data(json.utf8))
        XCTAssertEqual(stats.samples("a", kind: "weekly").map(\.remainingPercent), [50])
        XCTAssertEqual(stats.samples("a", kind: "weekly_model", title: "Weekly Fable").map(\.remainingPercent), [70])
        XCTAssertEqual(stats.samples("a", kind: "weekly_model", title: "Weekly Sonnet"), [])
    }

    func testFiveHourPaceIsPerHourAndNeedsSomeTime() {
        let now = at(12)
        let window = UsageWindow(kind: "five_hour", title: "5-hour", remainingPercent: 40, resetsAt: now.addingTimeInterval(3 * 3600))
        let pace = LimitPace.of(window, samples: [], now: now)!
        XCTAssertEqual(pace.rate, 30, accuracy: 0.01)
        XCTAssertEqual(pace.runsOutAt!.timeIntervalSince(now), 80 * 60, accuracy: 1)
        XCTAssertEqual(pace.rateText(kind: "five_hour"), "30% an hour")
        let fresh = UsageWindow(kind: "five_hour", title: "5-hour", remainingPercent: 99, resetsAt: now.addingTimeInterval(5 * 3600 - 60))
        XCTAssertNil(LimitPace.of(fresh, samples: [], now: now), "a minute in is too early to say")
        XCTAssertNil(LimitPace.of(UsageWindow(kind: "weekly", title: "Weekly", remainingPercent: 50), samples: [], now: now), "no reset, no pace")
    }

    // MARK: Verdicts

    func testRunningOutSaysHowLongBeforeTheReset() {
        // 20% a day with 30% left: out in 1.5 days, 2 days before the reset.
        let now = at(12)
        let window = weekly(30, resets: now.addingTimeInterval(3.5 * 86400))
        let pace = LimitPace.of(window, samples: [], now: now)
        let verdict = LimitPace.verdict(window, pace: pace, stale: false, now: now, calendar: calendar)!
        XCTAssertEqual(verdict.tone, .short)
        XCTAssertEqual(verdict.text, "Runs out Sat 12 am, 2 days before it resets")
    }

    func testAWeekWithLotsLeftOverSaysItWillGoUnused() {
        // 10% a day with 80% left and 5 days to go: 30% left at the reset.
        let now = at(12)
        let window = weekly(80, resets: now.addingTimeInterval(5 * 86400))
        let verdict = LimitPace.verdict(window, pace: LimitPace.of(window, samples: [], now: now), stale: false, now: now, calendar: calendar)!
        XCTAssertEqual(verdict.tone, .spare)
        XCTAssertEqual(verdict.text, "About 30% will go unused, resets Tue 12 pm")
    }

    func testAWeekAboutRightIsOnTrack() {
        // 5 days in with 35% left: 13% a day, about 9% left at the reset.
        let now = at(12)
        let window = weekly(35, resets: now.addingTimeInterval(2 * 86400))
        let verdict = LimitPace.verdict(window, pace: LimitPace.of(window, samples: [], now: now), stale: false, now: now, calendar: calendar)!
        XCTAssertEqual(verdict.tone, .fine)
        XCTAssertEqual(verdict.text, "On track, lasts till Sat 12 pm")
    }

    func testFiveHourWithRoomJustSaysWhenItResets() {
        let now = at(12)
        let window = UsageWindow(kind: "five_hour", title: "5-hour", remainingPercent: 90, resetsAt: now.addingTimeInterval(2 * 3600))
        let verdict = LimitPace.verdict(window, pace: LimitPace.of(window, samples: [], now: now), stale: false, now: now, calendar: calendar)!
        XCTAssertEqual(verdict, .init(text: "Resets 2 pm", tone: .fine))
        let used = UsageWindow(kind: "five_hour", title: "5-hour", remainingPercent: 0, resetsAt: now.addingTimeInterval(2 * 3600))
        XCTAssertEqual(LimitPace.verdict(used, pace: nil, stale: false, now: now, calendar: calendar), .init(text: "Used up, back 2 pm", tone: .out))
    }

    func testOldNumbersDontGuessAtThePace() {
        let now = at(12)
        let window = weekly(30, resets: now.addingTimeInterval(3.5 * 86400))
        let verdict = LimitPace.verdict(window, pace: LimitPace.of(window, samples: [], now: now), stale: true, now: now, calendar: calendar)!
        XCTAssertEqual(verdict, .init(text: "Resets Mon 12 am", tone: .fine))
    }

    func testGapsReadRoughly() {
        XCTAssertEqual(LimitPace.gap(2.1 * 86400), "2 days")
        XCTAssertEqual(LimitPace.gap(30 * 3600), "1 day")
        XCTAssertEqual(LimitPace.gap(5.2 * 3600), "5 hours")
        XCTAssertEqual(LimitPace.gap(70 * 60), "1 hour")
        XCTAssertEqual(LimitPace.gap(40 * 60), "40 min")
    }
}
