import Foundation

/// How much room an account has left, in words, and which account a new
/// thread should start on. Built from `Account.usage` (Token Stats' file
/// plus the readings the runner gets from its own turns); a runner older
/// than step 4 sends no usage, and then every function here says nothing.
public enum AccountUsageText {
    /// Under this much room an account isn't picked for a new thread, and
    /// isn't offered as somewhere to switch to.
    public static let pickFloor: Double = 10
    /// Under this much room the account chip shows the percentage.
    public static let chipWarning: Double = 25

    // MARK: Windows

    /// The 5-hour and weekly windows, the two that decide whether there's
    /// room. Codex Pro Lite and Claude Max (since the end of Oct 2026) have
    /// only the weekly one.
    public static func mainWindows(_ usage: AccountUsage?) -> [UsageWindow] {
        guard let usage else { return [] }
        return ["five_hour", "weekly"].compactMap { kind in usage.windows.first { $0.kind == kind } }
    }

    /// Everything else (a model's own weekly limit, an allowance, Codex's
    /// other buckets), shown smaller and never on the chip.
    public static func extraWindows(_ usage: AccountUsage?) -> [UsageWindow] {
        guard let usage else { return [] }
        let main = Set(mainWindows(usage).map(\.kind))
        var seen = Set<String>()
        return usage.windows.filter { !main.contains($0.kind) && seen.insert($0.kind + "|" + $0.title).inserted }
    }

    /// A model's own weeks ("Weekly Fable"), each once. The Usage panel
    /// gives them their own meters under the main two, as Claude Code's
    /// /usage does (Ayush, 6 Nov: "usage page should include fable
    /// section"). They never decide the room: a login out of Fable can
    /// still run other models.
    public static func modelWeeks(_ usage: AccountUsage?) -> [UsageWindow] {
        extraWindows(usage).filter { $0.kind == "weekly_model" }
    }

    /// The tighter of the main windows, the one that runs out first.
    public static func tightest(_ usage: AccountUsage?) -> UsageWindow? {
        mainWindows(usage).min { $0.remainingPercent < $1.remainingPercent }
    }

    /// The room left: the tighter of the 5-hour and weekly windows. Nil
    /// when neither is known.
    public static func room(_ usage: AccountUsage?) -> Double? { tightest(usage)?.remainingPercent }

    // MARK: Words

    /// A percentage as shown: whole numbers, never "100%" for 99.6.
    public static func percent(_ value: Double) -> String {
        "\(Int(saturating: value.rounded(.down)))%"
    }

    /// "5h", "week": the short names the menu uses.
    static func shortName(_ window: UsageWindow) -> String {
        switch window.kind {
        case "five_hour": return "5h"
        case "weekly": return "week"
        default: return window.title
        }
    }

    /// The menu's usage line: "5h 89% · week 78%, resets Thu 1 pm", the
    /// reset being the tighter window's. "Limit reached, resets 3:40 pm"
    /// for a blocked account. Nil with nothing known.
    public static func menuLine(_ usage: AccountUsage?, now: Date, calendar: Calendar = .current) -> String? {
        guard let usage else { return nil }
        let main = mainWindows(usage)
        if usage.blocked {
            let reset = main.filter { $0.remainingPercent < 1 }.compactMap(\.resetsAt).min() ?? main.compactMap(\.resetsAt).min()
            return "Limit reached" + (reset.map { ", resets " + resetTime($0, now: now, calendar: calendar) } ?? "")
        }
        guard !main.isEmpty else { return nil }
        var line = main.map { shortName($0) + " " + percent($0.remainingPercent) }.joined(separator: " · ")
        if let reset = tightest(usage)?.resetsAt { line += ", resets " + resetTime(reset, now: now, calendar: calendar) }
        return line
    }

    /// The account menu's subtitle: the note, then the room left.
    public static func subtitle(_ account: Account, now: Date, calendar: Calendar = .current) -> String? {
        let parts = [account.note, menuLine(account.usage, now: now, calendar: calendar)].compactMap { $0 }.filter { !$0.isEmpty }
        return parts.isEmpty ? nil : parts.joined(separator: " · ")
    }

    /// What the account chip adds after the name.
    public enum ChipBadge: Equatable, Sendable {
        /// Under 25% left: "· 12%", in orange.
        case low(String)
        /// At its limit: "Limit reached", in red.
        case blocked
    }

    public static func chipBadge(_ usage: AccountUsage?) -> ChipBadge? {
        guard let usage else { return nil }
        if usage.blocked { return .blocked }
        guard let room = room(usage), room < chipWarning else { return nil }
        return .low(percent(room))
    }

    /// The chip's tooltip, one full sentence: "mike@example.com: 5-hour
    /// 89% left, weekly 78% left, resets Thu 1 pm."
    public static func tooltip(_ account: Account?, fallback: String, now: Date, calendar: Calendar = .current) -> String {
        guard let account else { return fallback }
        var text = AccountName.title(account)
        if let note = account.note, !note.isEmpty { text += " (\(note))" }
        guard let usage = account.usage else { return text }
        let main = mainWindows(usage)
        if usage.blocked {
            return text + ": " + (menuLine(usage, now: now, calendar: calendar) ?? "Limit reached") + "."
        }
        guard !main.isEmpty else { return text }
        var words = main.map { "\($0.title) \(percent($0.remainingPercent)) left" }.joined(separator: ", ")
        if let reset = tightest(usage)?.resetsAt { words += ", resets " + resetTime(reset, now: now, calendar: calendar) }
        return text + ": " + words + "."
    }

    /// The line at the foot of the account menu, about where the numbers
    /// came from: "Usage from Token Stats at 7:15 am", or "Token Stats
    /// hasn't updated since 6:02 am" when every reading from it is stale.
    /// Nil when no account has a reading from Token Stats.
    public static func sourceLine(_ accounts: [Account], now: Date, calendar: Calendar = .current) -> String? {
        let fromTokenStats = accounts.compactMap(\.usage).filter { $0.source == "tokenStats" }
        guard let newest = fromTokenStats.compactMap(\.readAt).max() else { return nil }
        let day = when(newest, now: now, calendar: calendar)
        if fromTokenStats.allSatisfy(\.stale) { return "Token Stats hasn't updated since \(day)" }
        return "Usage from Token Stats at \(day)"
    }

    /// The usage popover's line for one window: "89% left, resets 3:40 pm".
    /// The window's detail ("64,390 credits") is left out when `notice`
    /// already says it, so it shows once.
    public static func windowLine(_ window: UsageWindow, now: Date, calendar: Calendar = .current, notice: String? = nil) -> String {
        var line = percent(window.remainingPercent) + " left"
        if let detail = window.detail, !detail.isEmpty, !(notice ?? "").contains(detail) { line += " (\(detail))" }
        if let reset = window.resetsAt { line += ", resets " + resetTime(reset, now: now, calendar: calendar) }
        return line
    }

    /// Room in a few words for the new-thread page's account cards: "5h 89%
    /// · week 78% left", or "Limit reached" for a blocked account. Nil with
    /// nothing known.
    public static func roomLine(_ usage: AccountUsage?) -> String? {
        guard let usage else { return nil }
        if usage.blocked { return "Limit reached" }
        let main = mainWindows(usage)
        guard !main.isEmpty else { return nil }
        return main.map { shortName($0) + " " + percent($0.remainingPercent) }.joined(separator: " · ") + " left"
    }

    /// When the account gets its room back, said only when that's worth
    /// knowing: it's at its limit, or a main window is under a quarter.
    /// "Weekly resets tomorrow 5 am". Nil otherwise, so a healthy account is
    /// just its two bars.
    public static func resetLine(_ usage: AccountUsage?, now: Date, calendar: Calendar = .current) -> String? {
        guard let usage, let tight = tightest(usage) else { return nil }
        guard usage.blocked || tight.remainingPercent < chipWarning, let reset = tight.resetsAt else { return nil }
        return "\(tight.title) resets " + resetTime(reset, now: now, calendar: calendar)
    }

    /// The quiet lines under an account in the Usage panel, after its
    /// meters. A bare percentage (Codex's other buckets) only when it's
    /// tighter than the main windows, since otherwise it never decides
    /// anything; any other window by its detail ("$250 allowance: $132.79
    /// left"); then the account's own part of Token Stats' notice. A
    /// model's own week has a meter of its own (`modelWeeks`), so it's not
    /// said here.
    public static func extraLines(_ usage: AccountUsage?, notice: String?, now: Date, calendar: Calendar = .current) -> [String] {
        guard let usage else { return [] }
        let room = room(usage) ?? 100
        // The panel shows the main windows' resets just above these lines.
        let mainResets = mainWindows(usage).compactMap(\.resetsAt)
        var lines: [String] = []
        var money: [String] = []
        for window in extraWindows(usage) where window.kind != "weekly_model" {
            // A bare percentage (a model's own week, Codex's other
            // buckets) only matters when it runs out before the main ones.
            if (window.detail ?? "").isEmpty && window.kind != "allowance" {
                guard window.remainingPercent < room else { continue }
                var line = "\(window.title) \(percent(window.remainingPercent)) left"
                if let reset = window.resetsAt, !mainResets.contains(where: { abs($0.timeIntervalSince(reset)) < 60 }) {
                    line += ", resets " + resetTime(reset, now: now, calendar: calendar)
                }
                lines.append(line)
            } else if let detail = window.detail, !detail.isEmpty {
                if !(notice ?? "").contains(detail) { money.append("\(window.title): \(detail)") }
            } else {
                money.append("\(window.title): \(percent(window.remainingPercent)) left")
            }
        }
        if let notice, !notice.isEmpty { money.insert(notice, at: 0) }
        if !money.isEmpty { lines.append(money.joined(separator: " · ")) }
        return lines
    }

    /// Token Stats' notices, with what several accounts say said once:
    /// "Couldn't check usage just now, so these are from 1:19 pm." under
    /// each of four accounts read as four problems. A notice is split on
    /// " · "; a part two or more accounts have goes in `shared`, in the
    /// order it first comes, and `own` keeps each account's other parts
    /// ("$48.85 extra usage spent", Codex's credits).
    public static func notices(_ accounts: [Account]) -> (shared: String?, own: [String: String]) {
        var parts: [(id: String, parts: [String])] = []
        for account in accounts {
            guard let notice = account.usage?.notice?.trimmingCharacters(in: .whitespaces), !notice.isEmpty else { continue }
            parts.append((account.id, notice.components(separatedBy: " · ").map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }))
        }
        var common: [String] = []
        for entry in parts {
            for part in entry.parts where !common.contains(part) && parts.filter({ $0.parts.contains(part) }).count > 1 {
                common.append(part)
            }
        }
        var own: [String: String] = [:]
        for entry in parts {
            let rest = entry.parts.filter { !common.contains($0) }
            if !rest.isEmpty { own[entry.id] = rest.joined(separator: " · ") }
        }
        return (common.isEmpty ? nil : common.joined(separator: " · "), own)
    }

    // MARK: Times

    /// When a window resets: "3:40 pm" today, "tomorrow 9 am", "Thu 1 pm"
    /// within the week, "12 Nov" after that. A time already past reads
    /// "now": the runner counts the window as full again.
    public static func resetTime(_ date: Date, now: Date, calendar: Calendar = .current) -> String {
        if date <= now { return "now" }
        if calendar.isDate(date, inSameDayAs: now) { return clock(date, calendar: calendar) }
        let days = calendar.dateComponents([.day], from: calendar.startOfDay(for: now), to: calendar.startOfDay(for: date)).day ?? 0
        if days < 7 { return dayName(date, now: now, calendar: calendar) + " " + clock(date, calendar: calendar) }
        let day = calendar.component(.day, from: date)
        let month = monthNames[(calendar.component(.month, from: date) - 1) % 12]
        return "\(day) \(month)"
    }

    /// "3:40 pm", "1 pm" on the hour. Built by hand rather than with a
    /// locale's style, so the copy reads the same everywhere (and in tests).
    public static func clock(_ date: Date, calendar: Calendar = .current) -> String {
        let parts = calendar.dateComponents([.hour, .minute], from: date)
        let hour = parts.hour ?? 0
        let minute = parts.minute ?? 0
        let twelve = hour % 12 == 0 ? 12 : hour % 12
        let suffix = hour < 12 ? "am" : "pm"
        return minute == 0 ? "\(twelve) \(suffix)" : String(format: "%d:%02d %@", twelve, minute, suffix)
    }

    /// When something happened: "6:02 am" today, else "Mon 6:02 am".
    public static func when(_ date: Date, now: Date, calendar: Calendar = .current) -> String {
        let at = clock(date, calendar: calendar)
        return calendar.isDate(date, inSameDayAs: now) ? at : dayName(date, now: now, calendar: calendar) + " " + at
    }

    static func dayName(_ date: Date, now: Date, calendar: Calendar) -> String {
        if let tomorrow = calendar.date(byAdding: .day, value: 1, to: now), calendar.isDate(date, inSameDayAs: tomorrow) { return "tomorrow" }
        if let yesterday = calendar.date(byAdding: .day, value: -1, to: now), calendar.isDate(date, inSameDayAs: yesterday) { return "yesterday" }
        return weekdayNames[(calendar.component(.weekday, from: date) - 1) % 7]
    }

    private static let weekdayNames = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]
    private static let monthNames = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]

    // MARK: Picking an account

    /// The account a new thread starts on when Mike hasn't picked one
    /// (docs/step4-plan.md, "Picking an account for a new thread"; the
    /// runner's `pickAccount` in `usage.ts` is the same rule):
    ///
    /// - only accounts of the last-used account's provider, so a Claude
    ///   habit stays on Claude and model and effort don't jump;
    /// - none that's blocked, has under 10% room, or has a note (claude-2,
    ///   "Convex work only", is for work and never picked for him);
    /// - the most room wins, room being the tighter of the 5-hour and weekly
    ///   windows;
    /// - a tie with the last-used account, or a last-used account whose
    ///   usage isn't known, keeps the last-used one; an account with no
    ///   usage known never beats one whose usage is;
    /// - with every candidate skipped, the last-used one;
    /// - no last-used account (or one that's gone) means the first
    ///   account's provider, and nil when nothing there can be picked;
    ///   no accounts at all is nil too.
    ///
    /// `app/Tests/Fixtures/pick-account-cases.json` is the runner's own
    /// case list (`runner/test/fixtures/`), so the two can't drift.
    public static func pickAccount(_ accounts: [Account], lastUsedId: String?) -> String? {
        guard !accounts.isEmpty else { return nil }
        let last = accounts.first { $0.id == lastUsedId }
        let provider = last?.provider ?? accounts[0].provider
        let eligible = accounts.filter { $0.provider == provider && isEligible($0) }
        let fallback = last?.id
        if let last, eligible.contains(where: { $0.id == last.id }), room(last.usage) == nil { return last.id }
        let known = eligible.compactMap { account in room(account.usage).map { (account: account, room: $0) } }
        guard let best = known.max(by: { $0.room < $1.room }) else { return fallback }
        if let last, let lastRoom = known.first(where: { $0.account.id == last.id })?.room, lastRoom >= best.room { return last.id }
        // `max` keeps the last of equals; the first in the runner's order wins a tie.
        return known.first { $0.room == best.room }?.account.id ?? fallback
    }

    /// Not blocked, not under the floor, and no note.
    static func isEligible(_ account: Account) -> Bool {
        if account.usage?.blocked == true { return false }
        if let note = account.note, !note.isEmpty { return false }
        if let room = room(account.usage), room < pickFloor { return false }
        return true
    }

    /// Where a thread that hit its limit could go: the account with the most
    /// room (known, at least 10%), on the same provider first, never one
    /// with a note or at its limit. Nil when there's nowhere better.
    public static func switchTarget(_ accounts: [Account], from currentId: String) -> Account? {
        let current = accounts.first { $0.id == currentId }
        let others = accounts.filter { $0.id != currentId && isEligible($0) && room($0.usage) != nil }
        func best(_ list: [Account]) -> Account? {
            let top = list.map { room($0.usage) ?? 0 }.max()
            return list.first { room($0.usage) == top }
        }
        if let provider = current?.provider, let same = best(others.filter { $0.provider == provider }) { return same }
        return best(others)
    }

    /// "Switch to mike (78% left)".
    public static func switchTitle(_ target: Account, accounts: [Account]) -> String {
        var title = "Switch to " + AccountName.short(target.id, accounts: accounts)
        if let room = room(target.usage) { title += " (\(percent(room)) left)" }
        return title
    }
}

/// How the CLIs' versions and updates read in the usage popover and the
/// quiet line under the toolbar (`clis.list`, `clis.updated`).
public enum CliText {
    public static func name(_ provider: String) -> String {
        switch provider {
        case "claude": return "Claude Code"
        case "codex": return "Codex"
        default: return provider.prefix(1).uppercased() + provider.dropFirst()
        }
    }

    /// "Claude Code 2.1.311, up to date", "Claude Code 2.1.311, 2.1.312
    /// available", "Codex 0.165.0 is held back because the app-server
    /// protocol changed".
    public static func statusLine(_ cli: CliStatus) -> String {
        let installed = cli.installedVersion.map { name(cli.provider) + " " + $0 } ?? name(cli.provider)
        switch cli.status {
        case "current": return installed + ", up to date"
        case "behind": return installed + (cli.latestVersion.map { ", \($0) available" } ?? ", an update is available")
        case "held":
            let version = cli.hold?.version ?? cli.latestVersion ?? "The new version"
            let reason = cli.hold?.reason ?? ""
            return "\(name(cli.provider)) \(version) is held back" + (reason.isEmpty ? "" : " because \(reason)")
        case "missing": return name(cli.provider) + " isn't installed"
        default: return installed
        }
    }

    /// Who keeps it up to date, when that isn't the usual: a path set by
    /// hand is never updated.
    public static func managedLine(_ cli: CliStatus) -> String? {
        cli.managedBy == "none" ? "Set by hand in runner.json, so Threadbear leaves it alone" : nil
    }

    /// The update button's title, or nil when there's nothing to install.
    public static func updateTitle(_ cli: CliStatus) -> String? {
        if isUpdating(cli) { return nil }
        switch cli.status {
        case "behind": return "Update"
        case "held": return "Update anyway"
        default: return nil
        }
    }

    /// "Go back to 0.163.0", for Codex with a kept version. Not when the
    /// kept version is the one held (Mike went back from it): the hold's
    /// "Update anyway" already reinstalls it.
    public static func goBackTitle(_ cli: CliStatus) -> String? {
        guard let previous = cli.previousVersion, !previous.isEmpty, previous != cli.installedVersion, !isUpdating(cli),
              previous != cli.hold?.version else { return nil }
        return "Go back to \(previous)"
    }

    public static func isUpdating(_ cli: CliStatus) -> Bool {
        cli.update.map { $0.state == "running" || $0.state == "waiting" } ?? false
    }

    /// The quiet line under the toolbar while an update runs or after one
    /// failed: "Updating Claude Code to 2.1.312", "Installing Codex 0.165.0".
    public static func bannerText(_ cli: CliStatus) -> String? {
        guard let update = cli.update else { return nil }
        let target = update.targetVersion ?? cli.latestVersion
        switch update.state {
        case "running":
            if cli.provider == "codex" { return "Installing Codex" + (target.map { " " + $0 } ?? "") }
            return "Updating \(name(cli.provider))" + (target.map { " to " + $0 } ?? "")
        case "waiting":
            return "Waiting to update \(name(cli.provider))" + (target.map { " to " + $0 } ?? "")
        case "failed":
            var text = "Couldn't update \(name(cli.provider))" + (target.map { " to " + $0 } ?? "")
            if let message = update.message, !message.isEmpty { text += ": " + message }
            return text
        default:
            return nil
        }
    }

    public static func policyTitle(_ policy: String) -> String {
        switch policy {
        case "auto": return "Automatic"
        case "notify": return "Ask me"
        case "off": return "Off"
        default: return policy
        }
    }

    public static let policies = ["auto", "notify", "off"]

    public static func policySymbol(_ policy: String) -> String {
        switch policy {
        case "auto": return "arrow.triangle.2.circlepath"
        case "notify": return "bell"
        default: return "nosign"
        }
    }

    /// "Checked at 9:40 am", "Checked Mon 9:40 am".
    public static func checkedLine(_ clis: [CliStatus], now: Date, calendar: Calendar = .current) -> String? {
        guard let checked = clis.compactMap(\.checkedAt).max() else { return nil }
        let at = AccountUsageText.clock(checked, calendar: calendar)
        if calendar.isDate(checked, inSameDayAs: now) { return "Checked at \(at)" }
        return "Checked \(AccountUsageText.dayName(checked, now: now, calendar: calendar)) \(at)"
    }
}

/// The composer's account picker: one section per provider (Claude, then
/// Codex, then any other), each account by its email with its note and the
/// room it has left under it. Accounts at their limit stay pickable.
public enum AccountMenu {
    public struct Item: Sendable, Equatable, Identifiable {
        public var id: String
        public var title: String
        public var subtitle: String?
        public var isSelected: Bool
        public var isBlocked: Bool
        /// Under 25% left (orange) or at its limit (red), as on the chip.
        public var badge: AccountUsageText.ChipBadge?
    }

    public struct Section: Sendable, Equatable, Identifiable {
        public var id: String
        public var title: String
        public var items: [Item]
    }

    public static func sections(_ accounts: [Account], selected: String, now: Date, calendar: Calendar = .current) -> [Section] {
        var sections: [Section] = []
        for account in accounts {
            let provider = account.provider.isEmpty ? "claude" : account.provider
            let item = Item(id: account.id, title: AccountName.title(account), subtitle: AccountUsageText.subtitle(account, now: now, calendar: calendar),
                            isSelected: account.id == selected, isBlocked: account.usage?.blocked == true,
                            badge: AccountUsageText.chipBadge(account.usage))
            if let index = sections.firstIndex(where: { $0.id == provider }) {
                sections[index].items.append(item)
            } else {
                sections.append(Section(id: provider, title: ModelPicker.providerTitle(provider), items: [item]))
            }
        }
        let order = ["claude", "codex"]
        return sections.enumerated().sorted { a, b in
            let ia = order.firstIndex(of: a.element.id) ?? order.count
            let ib = order.firstIndex(of: b.element.id) ?? order.count
            return ia != ib ? ia < ib : a.offset < b.offset
        }.map(\.element)
    }

    /// The picker as text, for the automation's `composer-menu`: `#` on a
    /// section, `[x]` on the chosen account, the subtitle after a dash,
    /// then the line about where the numbers came from.
    public static func lines(_ sections: [Section], footer: String?) -> [String] {
        var lines: [String] = []
        for section in sections {
            lines.append("# " + section.title)
            for item in section.items {
                var line = (item.isSelected ? "[x] " : "[ ] ") + item.title
                if let subtitle = item.subtitle { line += " - " + subtitle }
                lines.append(line)
            }
        }
        if let footer { lines.append("--- " + footer) }
        return lines
    }
}
