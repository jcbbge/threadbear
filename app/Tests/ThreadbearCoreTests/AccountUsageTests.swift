import Foundation
import XCTest
@testable import ThreadbearCore

final class AccountUsageTests: XCTestCase {
    private var calendar: Calendar {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "Australia/Perth")!
        return calendar
    }

    /// Tuesday 27 Oct 2026, 10:00 in Perth.
    private var now: Date {
        calendar.date(from: DateComponents(year: 2026, month: 10, day: 27, hour: 10, minute: 0))!
    }

    private func at(day: Int = 27, _ hour: Int, _ minute: Int = 0) -> Date {
        calendar.date(from: DateComponents(year: 2026, month: 10, day: day, hour: hour, minute: minute))!
    }

    // MARK: pickAccount, the same cases as the runner

    private struct Cases: Decodable {
        struct Case: Decodable {
            var name: String
            var lastUsedId: String?
            var accounts: [Short]
            var expected: String?
        }

        struct Short: Decodable {
            var id: String
            var provider: String
            var note: String?
            var blocked: Bool?
            var windows: [[JSONValue]]?
        }

        var cases: [Case]
    }

    private static var casesURL: URL {
        URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().appendingPathComponent("Fixtures/pick-account-cases.json")
    }

    func testPickAccountMatchesTheRunnersCases() throws {
        let cases = try JSONDecoder().decode(Cases.self, from: Data(contentsOf: Self.casesURL)).cases
        XCTAssertGreaterThanOrEqual(cases.count, 20)
        for c in cases {
            let accounts = c.accounts.map { short -> Account in
                let windows = (short.windows ?? []).compactMap { pair -> UsageWindow? in
                    guard pair.count == 2, let kind = pair[0].stringValue, let percent = pair[1].doubleValue else { return nil }
                    return UsageWindow(kind: kind, title: kind, remainingPercent: percent)
                }
                let usage = short.windows == nil && short.blocked == nil ? nil : AccountUsage(windows: windows, blocked: short.blocked ?? false)
                return Account(id: short.id, provider: short.provider, title: short.id, note: short.note, usage: usage)
            }
            XCTAssertEqual(AccountUsageText.pickAccount(accounts, lastUsedId: c.lastUsedId), c.expected, c.name)
        }
    }

    /// The copy here is the runner's file; once both are in one tree, they
    /// must be the same bytes.
    func testCasesAreTheRunnersCopy() throws {
        let runner = Self.casesURL.deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent().appendingPathComponent("runner/test/fixtures/pick-account-cases.json")
        guard FileManager.default.fileExists(atPath: runner.path) else { throw XCTSkip("the runner's copy isn't in this tree yet") }
        XCTAssertEqual(try Data(contentsOf: runner), try Data(contentsOf: Self.casesURL),
                       "app/Tests/Fixtures/pick-account-cases.json differs from runner/test/fixtures: copy the runner's over")
    }

    // MARK: Words

    private func usage(_ fiveHour: Double?, _ weekly: Double?, blocked: Bool = false, reset: Date? = nil, weeklyReset: Date? = nil) -> AccountUsage {
        var windows: [UsageWindow] = []
        if let fiveHour { windows.append(UsageWindow(kind: "five_hour", title: "5-hour", remainingPercent: fiveHour, resetsAt: reset)) }
        if let weekly { windows.append(UsageWindow(kind: "weekly", title: "Weekly", remainingPercent: weekly, resetsAt: weeklyReset)) }
        return AccountUsage(windows: windows, blocked: blocked)
    }

    func testMenuLine() {
        let u = usage(89, 78, reset: at(15, 40), weeklyReset: at(day: 29, 13))
        // The reset is the tighter window's.
        XCTAssertEqual(AccountUsageText.menuLine(u, now: now, calendar: calendar), "5h 89% · week 78%, resets Thu 1 pm")
        let tight5h = usage(12, 78, reset: at(15, 40), weeklyReset: at(day: 29, 13))
        XCTAssertEqual(AccountUsageText.menuLine(tight5h, now: now, calendar: calendar), "5h 12% · week 78%, resets 3:40 pm")
        let blocked = usage(0, 31, blocked: true, reset: at(15, 40))
        XCTAssertEqual(AccountUsageText.menuLine(blocked, now: now, calendar: calendar), "Limit reached, resets 3:40 pm")
        // Pro Lite: weekly only.
        XCTAssertEqual(AccountUsageText.menuLine(usage(nil, 64), now: now, calendar: calendar), "week 64%")
        XCTAssertNil(AccountUsageText.menuLine(nil, now: now, calendar: calendar))
        XCTAssertNil(AccountUsageText.menuLine(AccountUsage(windows: [UsageWindow(kind: "allowance", title: "$250 allowance", remainingPercent: 53.1)]), now: now))
    }

    func testSubtitleHasTheNoteFirst() {
        let account = Account(id: "claude-2", title: "work@example.com", note: "Convex work only", usage: usage(95, 90, reset: at(12, 5), weeklyReset: at(day: 30, 9)))
        XCTAssertEqual(AccountUsageText.subtitle(account, now: now, calendar: calendar), "Convex work only · 5h 95% · week 90%, resets Fri 9 am")
        XCTAssertNil(AccountUsageText.subtitle(Account(id: "x", title: "x"), now: now))
    }

    func testResetTimes() {
        XCTAssertEqual(AccountUsageText.resetTime(at(15, 40), now: now, calendar: calendar), "3:40 pm")
        XCTAssertEqual(AccountUsageText.resetTime(at(day: 28, 9), now: now, calendar: calendar), "tomorrow 9 am")
        XCTAssertEqual(AccountUsageText.resetTime(at(day: 29, 0, 30), now: now, calendar: calendar), "Thu 12:30 am")
        XCTAssertEqual(AccountUsageText.resetTime(at(day: 12, 9).addingTimeInterval(30 * 86_400), now: now, calendar: calendar), "11 Nov")
        XCTAssertEqual(AccountUsageText.resetTime(at(9), now: now, calendar: calendar), "now")
        XCTAssertEqual(AccountUsageText.clock(at(12, 0), calendar: calendar), "12 pm")
    }

    func testChipBadge() {
        XCTAssertNil(AccountUsageText.chipBadge(usage(89, 78)))
        XCTAssertEqual(AccountUsageText.chipBadge(usage(12, 40)), .low("12%"))
        XCTAssertEqual(AccountUsageText.chipBadge(usage(24.9, 40)), .low("24%"))
        XCTAssertNil(AccountUsageText.chipBadge(usage(25, 40)))
        XCTAssertEqual(AccountUsageText.chipBadge(usage(0, 40, blocked: true)), .blocked)
        XCTAssertNil(AccountUsageText.chipBadge(nil), "an older runner sends no usage")
    }

    func testTooltip() {
        let account = Account(id: "claude-main", title: "mike@example.com", email: "mike@example.com", usage: usage(89, 78, reset: at(15, 40), weeklyReset: at(day: 29, 13)))
        XCTAssertEqual(AccountUsageText.tooltip(account, fallback: "claude-main", now: now, calendar: calendar),
                       "mike@example.com: 5-hour 89% left, Weekly 78% left, resets Thu 1 pm.")
        XCTAssertEqual(AccountUsageText.tooltip(nil, fallback: "claude-9", now: now), "claude-9")
    }

    func testSourceLine() {
        func reading(_ date: Date, stale: Bool = false, source: String = "tokenStats") -> Account {
            Account(id: UUID().uuidString, title: "a", usage: AccountUsage(windows: [], readAt: date, source: source, stale: stale))
        }
        XCTAssertEqual(AccountUsageText.sourceLine([reading(at(7, 15)), reading(at(6, 2))], now: now, calendar: calendar), "Usage from Token Stats at 7:15 am")
        XCTAssertEqual(AccountUsageText.sourceLine([reading(at(6, 2), stale: true)], now: now, calendar: calendar), "Token Stats hasn't updated since 6:02 am")
        // One fresh reading is enough for "from Token Stats".
        XCTAssertEqual(AccountUsageText.sourceLine([reading(at(6, 2), stale: true), reading(at(7, 15))], now: now, calendar: calendar), "Usage from Token Stats at 7:15 am")
        XCTAssertNil(AccountUsageText.sourceLine([reading(at(9), source: "live")], now: now))
        XCTAssertNil(AccountUsageText.sourceLine([], now: now))
    }

    func testExtraWindowsLeaveOutTheMainOnes() {
        let u = AccountUsage(windows: [
            UsageWindow(kind: "five_hour", title: "5-hour", remainingPercent: 89),
            UsageWindow(kind: "weekly_model", title: "Weekly Fable", remainingPercent: 71),
            UsageWindow(kind: "weekly", title: "Weekly", remainingPercent: 78),
        ])
        XCTAssertEqual(AccountUsageText.mainWindows(u).map(\.kind), ["five_hour", "weekly"])
        XCTAssertEqual(AccountUsageText.extraWindows(u).map(\.title), ["Weekly Fable"])
        XCTAssertEqual(AccountUsageText.room(u), 78)
    }

    func testSwitchTargetPrefersTheSameProvider() {
        let accounts = [
            Account(id: "claude-main", title: "mike@example.com", email: "mike@example.com", usage: usage(0, 50, blocked: true)),
            Account(id: "claude-2", title: "work@example.com", note: "Convex work only", usage: usage(99, 99)),
            Account(id: "claude-3", title: "mike+3@example.com", email: "mike+3@example.com", usage: usage(78, 80)),
            Account(id: "codex-main", provider: "codex", title: "Codex · mike@example.com", email: "mike@example.com", usage: usage(nil, 95)),
        ]
        let target = AccountUsageText.switchTarget(accounts, from: "claude-main")
        XCTAssertEqual(target?.id, "claude-3", "same provider first, never the noted account")
        XCTAssertEqual(target.map { AccountUsageText.switchTitle($0, accounts: accounts) }, "Switch to mike+3 (78% left)")
        // Nothing left on Codex: a Claude account.
        XCTAssertEqual(AccountUsageText.switchTarget(accounts, from: "codex-main")?.id, "claude-3")
        XCTAssertNil(AccountUsageText.switchTarget([accounts[0]], from: "claude-main"))
    }

    func testANoticeSeveralAccountsShareIsSaidOnce() {
        func with(_ id: String, _ notice: String?) -> Account {
            Account(id: id, title: id, usage: AccountUsage(windows: [], notice: notice))
        }
        let couldnt = "Couldn't check usage just now, so these are from 1:19 pm."
        let accounts = [
            with("claude-main", couldnt), with("claude-1", "\(couldnt) · $48.85 extra usage spent"), with("claude-3", couldnt),
            with("codex-main", "64,390 credits · 2 limit resets available"), with("claude-4", nil),
        ]
        let notices = AccountUsageText.notices(accounts)
        XCTAssertEqual(notices.shared, couldnt)
        XCTAssertEqual(notices.own, ["claude-1": "$48.85 extra usage spent", "codex-main": "64,390 credits · 2 limit resets available"])
        // One account's notice stays its own.
        XCTAssertEqual(AccountUsageText.notices([with("codex-main", "64,390 credits")]).own, ["codex-main": "64,390 credits"])
        XCTAssertNil(AccountUsageText.notices([with("codex-main", "64,390 credits")]).shared)
    }

    func testCreditsShowOnce() {
        let weekly = UsageWindow(kind: "weekly", title: "Weekly", remainingPercent: 93, detail: "64,390 credits")
        XCTAssertEqual(AccountUsageText.windowLine(weekly, now: now, notice: "64,390 credits · 2 limit resets available"), "93% left")
        XCTAssertEqual(AccountUsageText.windowLine(weekly, now: now), "93% left (64,390 credits)")
    }

    func testRoomLine() {
        XCTAssertEqual(AccountUsageText.roomLine(usage(89.6, 78)), "5h 89% · week 78% left")
        XCTAssertEqual(AccountUsageText.roomLine(usage(nil, 64)), "week 64% left")
        XCTAssertEqual(AccountUsageText.roomLine(usage(0, 31, blocked: true)), "Limit reached")
        XCTAssertNil(AccountUsageText.roomLine(nil))
    }

    func testResetLineOnlyWhenRoomIsShort() {
        // Mike's bearworks on 27 Oct: 54% and 7%, the week back tomorrow.
        XCTAssertEqual(AccountUsageText.resetLine(usage(54, 7, reset: at(16, 10), weeklyReset: at(day: 28, 5)), now: now, calendar: calendar),
                       "Weekly resets tomorrow 5 am")
        XCTAssertNil(AccountUsageText.resetLine(usage(90, 60, reset: at(16, 40), weeklyReset: at(day: 29, 13)), now: now, calendar: calendar))
        XCTAssertEqual(AccountUsageText.resetLine(usage(0, 31, blocked: true, reset: at(15, 30), weeklyReset: at(day: 29, 13)), now: now, calendar: calendar),
                       "5-hour resets 3:30 pm")
    }

    func testExtraLinesKeepOnlyWhatDecidesSomething() {
        // Mike's gmail account: Fable's own week has a meter, not a line;
        // the allowance and the spend are one line.
        var gmail = usage(90, 16, weeklyReset: at(day: 30, 1))
        gmail.windows += [
            UsageWindow(kind: "weekly_model", title: "Weekly Fable", remainingPercent: 96, resetsAt: at(day: 30, 1)),
            UsageWindow(kind: "allowance", title: "$250 allowance", remainingPercent: 53.1, resetsAt: at(day: 35, 8), detail: "$132.79 left"),
        ]
        XCTAssertEqual(AccountUsageText.extraLines(gmail, notice: "$48.85 extra usage spent", now: now, calendar: calendar),
                       ["$48.85 extra usage spent · $250 allowance: $132.79 left"])
        // A model's own week has its own meter in the panel, so it's never
        // a line here, however tight.
        var tight = usage(90, 60)
        tight.windows.append(UsageWindow(kind: "weekly_model", title: "Weekly Fable", remainingPercent: 5, resetsAt: at(day: 29, 13)))
        XCTAssertEqual(AccountUsageText.extraLines(tight, notice: nil, now: now, calendar: calendar), [])
        XCTAssertEqual(AccountUsageText.modelWeeks(tight).map(\.title), ["Weekly Fable"])
        XCTAssertEqual(AccountUsageText.modelWeeks(usage(90, 60)), [])
        // A bare bucket tighter than the main windows still is.
        var codexTight = usage(nil, 60)
        codexTight.windows.append(UsageWindow(kind: "other", title: "GPT-6.1-Sol", remainingPercent: 5))
        XCTAssertEqual(AccountUsageText.extraLines(codexTight, notice: nil, now: now, calendar: calendar), ["GPT-6.1-Sol 5% left"])
        // Codex's credits come in the notice; a window repeating them doesn't say them again.
        var codex = usage(nil, 89)
        codex.windows.append(UsageWindow(kind: "other", title: "Credits", remainingPercent: 100, detail: "64,390 credits"))
        XCTAssertEqual(AccountUsageText.extraLines(codex, notice: "64,390 credits · 2 limit resets available", now: now, calendar: calendar),
                       ["64,390 credits · 2 limit resets available"])
    }

    // MARK: Names

    func testAccountNamesAreProviderAware() {
        // claude-1 and codex-main share sam.lee@gmail.com, as one person's might.
        let accounts = [
            Account(id: "claude-main", title: "sam@bearworks.com", email: "sam@bearworks.com"),
            Account(id: "claude-1", title: "sam.lee@gmail.com", email: "sam.lee@gmail.com"),
            Account(id: "codex-main", provider: "codex", title: "Codex · sam.lee@gmail.com", email: "sam.lee@gmail.com"),
        ]
        XCTAssertEqual(AccountName.short("claude-1", accounts: accounts), "sam.lee", "no clash across providers")
        XCTAssertEqual(AccountName.short("codex-main", accounts: accounts), "Codex")
        XCTAssertEqual(AccountName.title(accounts[2]), "sam.lee@gmail.com")
        // An older runner: no email, the title has the prefix.
        XCTAssertEqual(AccountName.title(Account(id: "codex-main", provider: "codex", title: "Codex · a@b.c")), "a@b.c")
        let two = accounts + [Account(id: "codex-1", provider: "codex", title: "Codex · m@work.example", email: "m@work.example")]
        XCTAssertEqual(AccountName.short("codex-main", accounts: two), "Codex sam.lee")
        XCTAssertEqual(AccountName.short("codex-1", accounts: two), "Codex m")
    }

    func testCardLabelsUseTheDomainWhenNamesClash() {
        // Four Claude logins: two "sam@" and two "sam.lee@".
        let accounts = [
            Account(id: "claude-main", title: "", email: "sam@bearworks.com"),
            Account(id: "claude-1", title: "", email: "sam.lee@gmail.com"),
            Account(id: "claude-2", title: "", email: "sam.lee@convex.dev"),
            Account(id: "claude-3", title: "", email: "sam@acme.io"),
            Account(id: "codex-main", provider: "codex", title: "", email: "sam.lee@gmail.com"),
        ]
        XCTAssertEqual(accounts.map { AccountName.label($0.id, accounts: accounts) }, ["bearworks", "gmail", "convex", "acme", "Codex"])
        let unique = [accounts[0], accounts[1]]
        XCTAssertEqual(unique.map { AccountName.label($0.id, accounts: unique) }, ["sam", "sam.lee"])
        let sameDomain = [Account(id: "a", title: "", email: "a@x.com"), Account(id: "b", title: "", email: "a@x.org")]
        XCTAssertEqual(AccountName.label("a", accounts: sameDomain), "a@x.com")
    }
}
