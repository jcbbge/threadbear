import Charts
import SwiftUI
import ThreadbearCore

/// "Usage" in the activity bar, a panel in the dock. At the top, what's
/// been spent: today's tokens, the last hour's, and a chart by the hour or
/// the day, each login its own colour (Mike, 29 Oct: "how many tokens I've
/// spent today, what my velocity is, some graphs"). Then one card per pool
/// (pools are what threads run on), each login in it with its 5-hour and
/// weekly room, how fast the week is going and whether it lasts. A panel
/// rather than a popover so it can stay open beside a thread, or be dragged
/// out into a window. The CLIs' versions are in Updates.
///
/// The limits come from `accounts.updated` and `pools.updated`; the tokens
/// and the readings over time from `usage.stats`, asked for when the panel
/// opens and once a minute while it's open.
struct UsagePanel: View {
    @Environment(AppModel.self) private var app

    var body: some View {
        let groups = UsageGroups.build(pools: app.poolsSupported ? app.pools : [], accounts: app.accounts)
        let notices = AccountUsageText.notices(app.accounts)
        let colours = LoginColours(accounts: app.accounts)
        ScrollView {
            VStack(alignment: .leading, spacing: zoomed(14)) {
                if !app.accounts.contains(where: { $0.usage != nil }) {
                    Text("The usage numbers need a newer runner.")
                        .font(.system(size: zoomed(12)))
                        .foregroundStyle(.secondary)
                }
                if let stats = app.usageStats {
                    SpendSection(stats: stats, accounts: app.accounts, colours: colours, now: app.now)
                }
                ForEach(groups) { group in
                    PoolCard(group: group, allAccounts: app.accounts, notices: notices.own, stats: app.usageStats, colours: colours, now: app.now)
                }
                // Where the numbers came from, and what Token Stats says
                // about all of them, once.
                let source = [AccountUsageText.sourceLine(app.accounts, now: app.now), notices.shared].compactMap { $0 }
                if !source.isEmpty {
                    Text(source.joined(separator: ". "))
                        .font(.system(size: zoomed(11)))
                        .foregroundStyle(.tertiary)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            .padding(zoomed(16))
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .task {
            // Only while the panel is on screen: the task ends with it.
            while !Task.isCancelled {
                await app.loadUsageStats()
                if app.usageStatsSupported == false { return }
                try? await Task.sleep(for: .seconds(60))
            }
        }
    }
}

// MARK: Colours

/// Each login's colour in the charts: the reference categorical palette's
/// slots in the logins' own order, so a login keeps its colour whichever
/// pool or chart it's in. Text never wears them; a dot beside a name does.
struct LoginColours {
    private let index: [String: Int]

    init(accounts: [Account]) {
        index = Dictionary(accounts.enumerated().map { ($1.id, $0) }, uniquingKeysWith: { first, _ in first })
    }

    private static let light: [UInt32] = [0x2A78D6, 0xEB6834, 0x1BAF7A, 0xEDA100, 0xE87BA4, 0x008300, 0x6250D6, 0xE34948]
    private static let dark: [UInt32] = [0x3987E5, 0xD95926, 0x199E70, 0xC98500, 0xD55181, 0x008300, 0x9085E9, 0xE66767]

    func colour(_ accountId: String, dark: Bool) -> Color {
        // A ninth login folds to grey rather than repeating a colour.
        guard let slot = index[accountId], slot < Self.light.count else { return .gray }
        let hex = (dark ? Self.dark : Self.light)[slot]
        return Color(red: Double((hex >> 16) & 0xFF) / 255, green: Double((hex >> 8) & 0xFF) / 255, blue: Double(hex & 0xFF) / 255)
    }
}

/// A login's colour as a small dot, beside its name.
private struct LoginDot: View {
    let colour: Color

    var body: some View {
        Circle().fill(colour).frame(width: zoomed(7), height: zoomed(7))
    }
}

// MARK: Spend

/// Today's tokens, the last hour's, the week's, then the chart.
private struct SpendSection: View {
    let stats: UsageStats
    let accounts: [Account]
    let colours: LoginColours
    let now: Date

    var body: some View {
        let ids = accounts.map(\.id)
        let today = UsageStatsMath.today(stats, accounts: ids, now: now)
        let lastHour = UsageStatsMath.lastHour(stats, accounts: ids, now: now)
        let usual = UsageStatsMath.usualByNow(stats, accounts: ids, now: now)
        let week = UsageStatsMath.total(stats, accounts: ids, from: Calendar.current.date(byAdding: .day, value: -6, to: Calendar.current.startOfDay(for: now)) ?? now, to: now.addingTimeInterval(1))
        let hoursToday = max(1, now.timeIntervalSince(Calendar.current.startOfDay(for: now)) / 3600)
        VStack(alignment: .leading, spacing: zoomed(12)) {
            HStack(alignment: .top, spacing: zoomed(10)) {
                // One short line under each number, the sentence in its tip:
                // two lines of "Usually 120M by n..." in the docked panel
                // read as clutter (Mike, 2 Nov).
                StatTile(title: "Today", value: UsageStatsMath.tokens(today.total),
                         detail: usual.map { "usually " + UsageStatsMath.tokens($0) },
                         tip: (usual.map { "Usually " + UsageStatsMath.tokens($0) + " by this time of day. " } ?? "") + UsageStatsMath.breakdown(today))
                StatTile(title: "Last hour", value: UsageStatsMath.tokens(lastHour),
                         detail: UsageStatsMath.tokens(Int(saturating: Double(today.total) / hoursToday)) + "/h today",
                         tip: "Tokens in the last 60 minutes, across every login. Today has averaged " + UsageStatsMath.tokens(Int(saturating: Double(today.total) / hoursToday)) + " an hour.")
                StatTile(title: "7 days", value: UsageStatsMath.tokens(week.total),
                         detail: UsageStatsMath.tokens(week.total / 7) + " a day",
                         tip: UsageStatsMath.breakdown(week))
            }
            TokensChart(stats: stats, accounts: accounts, colours: colours, now: now)
            if !stats.ready {
                Text("Still reading the transcripts, so these are partial.")
                    .font(.system(size: zoomed(11)))
                    .foregroundStyle(.tertiary)
            }
        }
    }
}

/// A number with its name over it and a quiet line under it.
private struct StatTile: View {
    let title: String
    let value: String
    let detail: String?
    let tip: String

    var body: some View {
        VStack(alignment: .leading, spacing: zoomed(2)) {
            Text(title)
                .font(.system(size: zoomed(11), weight: .medium))
                .foregroundStyle(.secondary)
            Text(value)
                .font(.system(size: zoomed(22), weight: .semibold))
                .monospacedDigit()
                .lineLimit(1)
                .minimumScaleFactor(0.6)
            // The line, or nothing when it doesn't fit (a narrow panel):
            // the tip says it either way.
            ViewThatFits(in: .horizontal) {
                Text(detail ?? " ")
                Text(" ")
            }
            .font(.system(size: zoomed(11)))
            .foregroundStyle(.tertiary)
            .lineLimit(1)
        }
        .padding(zoomed(10))
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Card())
        .tip(tip)
        .accessibilityElement(children: .combine)
    }
}

/// The cards' fill: a shade lighter than the panel, with a hairline.
private struct Card: View {
    var body: some View {
        RoundedRectangle(cornerRadius: zoomed(8), style: .continuous)
            .fill(Color.primary.opacity(0.035))
            .overlay(RoundedRectangle(cornerRadius: zoomed(8), style: .continuous).strokeBorder(Color.primary.opacity(0.07)))
    }
}

/// Tokens by the hour today, or by the day for the last week, stacked by
/// login. Hovering a bar shows what's in it.
private struct TokensChart: View {
    let stats: UsageStats
    let accounts: [Account]
    let colours: LoginColours
    let now: Date
    @Environment(\.colorScheme) private var scheme
    @AppStorage("usage.chartRange") private var range = "today"
    @State private var hovered: Date?

    var body: some View {
        let ids = accounts.map(\.id)
        let byDay = range == "week"
        let calendar = Calendar.current
        let bars = byDay
            ? UsageStatsMath.byDay(stats, accounts: ids, days: 7, now: now)
            : UsageStatsMath.todayByHour(stats, accounts: ids, now: now)
        let unit: Calendar.Component = byDay ? .day : .hour
        let start = byDay ? calendar.date(byAdding: .day, value: -6, to: calendar.startOfDay(for: now))! : calendar.startOfDay(for: now)
        let end = byDay ? calendar.date(byAdding: .day, value: 1, to: calendar.startOfDay(for: now))! : calendar.date(byAdding: .day, value: 1, to: start)!
        let spending = ids.filter { id in bars.contains { $0.accountId == id } }
        let selected = hovered.flatMap { calendar.dateInterval(of: unit, for: $0)?.start }
        VStack(alignment: .leading, spacing: zoomed(8)) {
            HStack {
                Text(byDay ? "Tokens by day" : "Tokens by hour")
                    .font(.system(size: zoomed(12.5), weight: .semibold))
                Spacer()
                Picker("Range", selection: $range) {
                    Text("Today").tag("today")
                    Text("7 days").tag("week")
                }
                .pickerStyle(.segmented)
                .labelsHidden()
                .fixedSize()
                .controlSize(.small)
                .tip("Show today by the hour, or the last 7 days by the day")
            }
            Chart {
                ForEach(bars, id: \.self) { bar in
                    BarMark(x: .value("Time", bar.start, unit: unit), y: .value("Tokens", bar.tokens))
                        .foregroundStyle(by: .value("Login", bar.accountId))
                        .opacity(selected == nil || selected == bar.start ? 1 : 0.45)
                }
                if !byDay {
                    RuleMark(x: .value("Now", now))
                        .foregroundStyle(Color.primary.opacity(0.25))
                        .lineStyle(StrokeStyle(lineWidth: 1, dash: [3, 3]))
                }
            }
            .chartForegroundStyleScale(domain: spending, range: spending.map { colours.colour($0, dark: scheme == .dark) })
            .chartLegend(.hidden)
            .chartXScale(domain: start...end)
            .chartXAxis {
                AxisMarks(values: .stride(by: byDay ? .day : .hour, count: byDay ? 1 : 6)) { value in
                    AxisGridLine().foregroundStyle(Color.primary.opacity(0.06))
                    AxisValueLabel {
                        if let date = value.as(Date.self) {
                            Text(byDay ? Self.dayLabel(date, now: now) : AccountUsageText.clock(date))
                        }
                    }
                }
            }
            .chartYAxis {
                AxisMarks(position: .trailing, values: .automatic(desiredCount: 3)) { value in
                    AxisGridLine().foregroundStyle(Color.primary.opacity(0.06))
                    AxisValueLabel {
                        if let n = value.as(Int.self) { Text(UsageStatsMath.tokens(n)) }
                    }
                }
            }
            .chartXSelection(value: $hovered)
            .frame(height: zoomed(130))
            .overlay(alignment: .topLeading) {
                if let selected {
                    HoverNote(start: selected, byDay: byDay, bars: bars.filter { $0.start == selected }, accounts: accounts, colours: colours, now: now)
                }
            }
            .overlay {
                if bars.isEmpty {
                    Text(stats.ready ? "Nothing spent yet" : "Reading the transcripts…")
                        .font(.system(size: zoomed(11)))
                        .foregroundStyle(.tertiary)
                }
            }
            // The legend: only the logins that spent something here, in
            // the logins' own order, so the colours read without a hover.
            if spending.count > 1 {
                // Wrapped a whole name at a time: in the narrow dock an
                // HStack broke "mike+3" over two lines.
                LegendFlow(spacing: zoomed(12), lineSpacing: zoomed(4)) {
                    ForEach(spending, id: \.self) { id in
                        HStack(spacing: zoomed(5)) {
                            LoginDot(colour: colours.colour(id, dark: scheme == .dark))
                            Text(AccountName.login(id, accounts: accounts))
                        }
                        .fixedSize()
                    }
                }
                .font(.system(size: zoomed(11)))
                .foregroundStyle(.secondary)
            }
        }
        .padding(zoomed(12))
        .background(Card())
    }

    /// "Mon", "Today".
    static func dayLabel(_ date: Date, now: Date) -> String {
        if Calendar.current.isDate(date, inSameDayAs: now) { return "Today" }
        let names = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]
        return names[(Calendar.current.component(.weekday, from: date) - 1) % 7]
    }
}

/// Lays its children out left to right, wrapping to a new line when the
/// next one doesn't fit, for the chart's legend.
private struct LegendFlow: Layout {
    var spacing: CGFloat
    var lineSpacing: CGFloat

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let rows = rows(width: proposal.width ?? .infinity, subviews: subviews)
        let width = rows.map { $0.width }.max() ?? 0
        let height = rows.map(\.height).reduce(0, +) + lineSpacing * CGFloat(max(0, rows.count - 1))
        return CGSize(width: width, height: height)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        var y = bounds.minY
        for row in rows(width: bounds.width, subviews: subviews) {
            var x = bounds.minX
            for index in row.indices {
                let size = subviews[index].sizeThatFits(.unspecified)
                subviews[index].place(at: CGPoint(x: x, y: y + (row.height - size.height) / 2), proposal: .unspecified)
                x += size.width + spacing
            }
            y += row.height + lineSpacing
        }
    }

    private func rows(width: CGFloat, subviews: Subviews) -> [(indices: [Int], width: CGFloat, height: CGFloat)] {
        var rows: [(indices: [Int], width: CGFloat, height: CGFloat)] = []
        for (index, subview) in subviews.enumerated() {
            let size = subview.sizeThatFits(.unspecified)
            if var last = rows.last, last.width + spacing + size.width <= width {
                last.indices.append(index)
                last.width += spacing + size.width
                last.height = max(last.height, size.height)
                rows[rows.count - 1] = last
            } else {
                rows.append(([index], size.width, size.height))
            }
        }
        return rows
    }
}

/// The hovered bar's hour or day, its total and each login's part.
private struct HoverNote: View {
    let start: Date
    let byDay: Bool
    let bars: [UsageStatsMath.Bar]
    let accounts: [Account]
    let colours: LoginColours
    let now: Date
    @Environment(\.colorScheme) private var scheme

    var body: some View {
        let total = bars.reduce(0) { $0.adding(saturating: $1.tokens) }
        VStack(alignment: .leading, spacing: zoomed(3)) {
            Text((byDay ? TokensChart.dayLabel(start, now: now) : AccountUsageText.clock(start)) + "  " + UsageStatsMath.tokens(total))
                .font(.system(size: zoomed(11), weight: .semibold))
            ForEach(bars.sorted { $0.tokens > $1.tokens }, id: \.accountId) { bar in
                HStack(spacing: zoomed(5)) {
                    LoginDot(colour: colours.colour(bar.accountId, dark: scheme == .dark))
                    Text(AccountName.login(bar.accountId, accounts: accounts))
                    Spacer(minLength: zoomed(8))
                    Text(UsageStatsMath.tokens(bar.tokens)).monospacedDigit()
                }
                .font(.system(size: zoomed(11)))
                .foregroundStyle(.secondary)
            }
        }
        .padding(.horizontal, zoomed(8))
        .padding(.vertical, zoomed(6))
        .fixedSize()
        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: zoomed(6)))
        .allowsHitTesting(false)
    }
}


// MARK: Pools

/// One pool: its name and what it's spent today, then each login in it.
/// A pool of more than one provider names each provider over its logins,
/// as a Claude and a Codex login have different windows.
private struct PoolCard: View {
    let group: UsageGroups.Group
    let allAccounts: [Account]
    let notices: [String: String]
    let stats: UsageStats?
    let colours: LoginColours
    let now: Date

    var body: some View {
        let today = stats.map { UsageStatsMath.today($0, accounts: group.accounts.map(\.id), now: now) }
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: zoomed(7)) {
                Image(systemName: group.pool.map { Pools.symbol($0, accounts: allAccounts) } ?? "tray")
                    .foregroundStyle(.secondary)
                Text(group.title)
                    .font(.system(size: zoomed(13), weight: .semibold))
                    .accessibilityAddTraits(.isHeader)
                Spacer()
                if let today, today.total > 0 {
                    Text(UsageStatsMath.tokens(today.total) + " today")
                        .font(.system(size: zoomed(11)))
                        .monospacedDigit()
                        .foregroundStyle(.secondary)
                        .tip(UsageStatsMath.breakdown(today))
                }
            }
            .padding(.horizontal, zoomed(12))
            .padding(.vertical, zoomed(9))
            ForEach(group.providers) { section in
                if group.providers.count > 1 {
                    Text(ModelPicker.providerTitle(section.provider))
                        .font(.system(size: zoomed(11), weight: .medium))
                        .foregroundStyle(.tertiary)
                        .padding(.horizontal, zoomed(12))
                        .padding(.top, zoomed(6))
                        .accessibilityAddTraits(.isHeader)
                }
                ForEach(section.accounts) { account in
                    Divider().opacity(0.6)
                    LoginRow(account: account, allAccounts: allAccounts, notice: notices[account.id], stats: stats, colours: colours, now: now)
                        .padding(.horizontal, zoomed(12))
                        .padding(.vertical, zoomed(10))
                }
            }
        }
        .background(Card())
    }
}

/// A login: its name and what it's spent today, its 5-hour and weekly
/// windows side by side (one over the other in a narrow panel), then a
/// model's own week ("Weekly Fable") with its own chart, as Claude Code's
/// /usage has (Ayush, 6 Nov), then only the extras that decide something
/// (`AccountUsageText.extraLines`).
private struct LoginRow: View {
    let account: Account
    let allAccounts: [Account]
    let notice: String?
    let stats: UsageStats?
    let colours: LoginColours
    let now: Date
    @Environment(\.colorScheme) private var scheme

    var body: some View {
        let usage = account.usage
        let windows = AccountUsageText.mainWindows(usage) + AccountUsageText.modelWeeks(usage)
        let today = stats.map { UsageStatsMath.today($0, accounts: [account.id], now: now) }
        let colour = colours.colour(account.id, dark: scheme == .dark)
        VStack(alignment: .leading, spacing: zoomed(8)) {
            HStack(alignment: .firstTextBaseline, spacing: zoomed(7)) {
                if stats != nil { LoginDot(colour: colour).alignmentGuide(.firstTextBaseline) { $0[.bottom] - zoomed(1) } }
                Text(AccountName.title(account))
                    .font(.system(size: zoomed(12.5), weight: .medium))
                    .lineLimit(1)
                    .truncationMode(.middle)
                if let note = account.note, !note.isEmpty {
                    Text(note).font(.system(size: zoomed(11))).foregroundStyle(.tertiary).lineLimit(1)
                }
                Spacer(minLength: zoomed(8))
                if let today, today.total > 0 {
                    Text(UsageStatsMath.tokens(today.total) + " today")
                        .font(.system(size: zoomed(11)))
                        .monospacedDigit()
                        .foregroundStyle(.secondary)
                        .tip(UsageStatsMath.breakdown(today))
                }
            }
            .tip([AccountName.title(account), account.plan].compactMap { $0 }.joined(separator: ", "))
            if usage == nil {
                Text("Nothing known yet").font(.system(size: zoomed(11))).foregroundStyle(.tertiary)
            } else if usage?.blocked == true {
                Text("Limit reached").font(.system(size: zoomed(11), weight: .medium)).foregroundStyle(.red)
            }
            if !windows.isEmpty {
                ViewThatFits(in: .horizontal) {
                    HStack(alignment: .top, spacing: zoomed(18)) { meters(windows, colour: colour) }
                    // Three (5-hour, week, Fable's week) in a panel too
                    // narrow for a row of them: two a row, rather than
                    // three tall ones stacked.
                    if windows.count > 2 {
                        Grid(alignment: .topLeading, horizontalSpacing: zoomed(18), verticalSpacing: zoomed(10)) {
                            ForEach(Array(stride(from: 0, to: windows.count, by: 2)), id: \.self) { i in
                                GridRow { meters(Array(windows[i..<min(i + 2, windows.count)]), colour: colour) }
                            }
                        }
                    }
                    VStack(alignment: .leading, spacing: zoomed(10)) { meters(windows, colour: colour) }
                }
            }
            let more = moreLines
            if !more.isEmpty {
                VStack(alignment: .leading, spacing: zoomed(2)) {
                    ForEach(more, id: \.self) { line in
                        Text(line).fixedSize(horizontal: false, vertical: true)
                    }
                }
                .font(.system(size: zoomed(11)))
                .foregroundStyle(.tertiary)
            }
        }
    }

    @ViewBuilder
    private func meters(_ windows: [UsageWindow], colour: Color) -> some View {
        ForEach(windows, id: \.title) { window in
            // Each meter takes its share of the row: capped at 320 they
            // stopped two thirds of the way across a wide panel (Mike, 5 Nov).
            WindowMeter(window: window, samples: stats?.samples(account.id, kind: window.kind, title: window.title) ?? [], colour: colour, stale: account.usage?.stale == true, now: now)
                .frame(minWidth: zoomed(170), maxWidth: .infinity, alignment: .leading)
        }
    }

    /// Token Stats' notes and the windows besides the main two. When the
    /// numbers are old, say since when.
    private var moreLines: [String] {
        var lines: [String] = []
        if account.usage?.stale == true, let readAt = account.usage?.readAt {
            lines.append("Numbers from " + AccountUsageText.when(readAt, now: now))
        }
        lines += AccountUsageText.extraLines(account.usage, notice: notice, now: now)
        return lines
    }
}

/// One window: its name and what's left, a bar, and what to do about it
/// (`LimitPace.verdict`): runs out early, will go unused, on track, or
/// when it resets. The weekly window
/// has a small chart of the week so far instead of the bar, with where
/// this pace leads dashed on to the reset.
private struct WindowMeter: View {
    let window: UsageWindow
    let samples: [LimitSample]
    let colour: Color
    let stale: Bool
    let now: Date

    var body: some View {
        let pace = LimitPace.of(window, samples: samples, now: now)
        let short = window.remainingPercent < AccountUsageText.chipWarning
        VStack(alignment: .leading, spacing: zoomed(4)) {
            HStack(alignment: .firstTextBaseline) {
                Text(window.title)
                    .font(.system(size: zoomed(11), weight: .medium))
                    .foregroundStyle(.secondary)
                Spacer(minLength: zoomed(6))
                Text(AccountUsageText.percent(window.remainingPercent) + " left")
                    .font(.system(size: zoomed(12), weight: .medium))
                    .monospacedDigit()
                    .foregroundStyle(short ? AnyShapeStyle(fill) : AnyShapeStyle(.primary))
            }
            // The weekly chart already shows what's left (its line ends at
            // it), so only the 5-hour window gets a bar. A model's own week
            // is charted the same way.
            if window.kind == "weekly" || window.kind == "weekly_model" {
                WeekChart(window: window, samples: samples, pace: stale ? nil : pace, colour: colour, now: now)
                    .frame(height: zoomed(44))
            } else {
                ZStack(alignment: .leading) {
                    Capsule().fill(Color.primary.opacity(0.08))
                    GeometryReader { geo in
                        Capsule().fill(fill).frame(width: max(0, geo.size.width * window.remainingPercent / 100))
                    }
                }
                .frame(height: zoomed(4))
            }
            if let verdict = LimitPace.verdict(window, pace: pace, stale: stale, now: now) {
                Text(verdict.text)
                    .font(.system(size: zoomed(11), weight: verdict.tone == .short || verdict.tone == .out ? .medium : .regular))
                    .foregroundStyle(Self.style(verdict.tone))
                    .lineLimit(2)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .tip(tip(pace))
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("\(window.title): " + tip(pace))
    }

    /// Colour only where there's something to do: red used up, orange
    /// runs out early, green room going spare; on track stays quiet.
    static func style(_ tone: LimitPace.Verdict.Tone) -> AnyShapeStyle {
        switch tone {
        case .out: AnyShapeStyle(Color.red)
        case .short: AnyShapeStyle(Color.orange)
        case .spare: AnyShapeStyle(Color.green)
        case .fine: AnyShapeStyle(.tertiary)
        }
    }

    private func tip(_ pace: LimitPace?) -> String {
        var parts = [AccountUsageText.windowLine(window, now: now)]
        if let pace {
            var line = "Going at about \(pace.rateText(kind: window.kind))"
            if let at = pace.runsOutAt { line += ", so it runs out " + AccountUsageText.resetTime(at, now: now) }
            else if let left = pace.leftAtReset { line += ", so about \(AccountUsageText.percent(left)) is left when it resets" }
            parts.append(line)
        }
        return parts.joined(separator: ". ")
    }

    private var fill: Color {
        if window.remainingPercent < 1 { return .red }
        if window.remainingPercent < AccountUsageText.chipWarning { return .orange }
        return Color.primary.opacity(0.45)
    }
}

/// The weekly window from its start to its reset: what was left over time
/// (full at the start, by definition), then this pace dashed on from now.
private struct WeekChart: View {
    let window: UsageWindow
    let samples: [LimitSample]
    let pace: LimitPace?
    let colour: Color
    let now: Date

    var body: some View {
        if let reset = window.resetsAt {
            let start = reset.addingTimeInterval(-7 * 86400)
            let points = [LimitSample(at: start, remainingPercent: 100)]
                + samples.filter { $0.at > start && $0.at < now }
                + [LimitSample(at: now, remainingPercent: window.remainingPercent)]
            let ahead: [LimitSample] = pace.map { pace in
                [LimitSample(at: now, remainingPercent: window.remainingPercent),
                 pace.runsOutAt.map { LimitSample(at: $0, remainingPercent: 0) } ?? LimitSample(at: reset, remainingPercent: pace.leftAtReset ?? window.remainingPercent)]
            } ?? []
            let short = pace?.runsOutAt != nil
            Chart {
                // A faint line at each day of the week, so how far in it is
                // and when it runs out read without a hover.
                ForEach(1..<7, id: \.self) { day in
                    RuleMark(x: .value("Day", start.addingTimeInterval(Double(day) * 86400)))
                        .foregroundStyle(Color.primary.opacity(0.06))
                        .lineStyle(StrokeStyle(lineWidth: 1))
                }
                ForEach(Array(points.enumerated()), id: \.offset) { _, point in
                    AreaMark(x: .value("Time", point.at), yStart: .value("Floor", 0), yEnd: .value("Left", point.remainingPercent), series: .value("Part", "past"))
                        .foregroundStyle(colour.opacity(0.07))
                        .interpolationMethod(.monotone)
                    LineMark(x: .value("Time", point.at), y: .value("Left", point.remainingPercent), series: .value("Part", "past"))
                        .foregroundStyle(colour)
                        .lineStyle(StrokeStyle(lineWidth: 1.5))
                        .interpolationMethod(.monotone)
                }
                ForEach(Array(ahead.enumerated()), id: \.offset) { _, point in
                    LineMark(x: .value("Time", point.at), y: .value("Left", point.remainingPercent), series: .value("Part", "ahead"))
                        .foregroundStyle(short ? Color.orange.opacity(0.8) : colour.opacity(0.6))
                        .lineStyle(StrokeStyle(lineWidth: 1, dash: [3, 3]))
                }
                PointMark(x: .value("Time", now), y: .value("Left", window.remainingPercent))
                    .foregroundStyle(colour)
                    .symbolSize(zoomed(18))
                if let out = pace?.runsOutAt {
                    PointMark(x: .value("Time", out), y: .value("Left", 0))
                        .foregroundStyle(Color.orange)
                        .symbolSize(zoomed(18))
                }
            }
            .chartXScale(domain: start...reset)
            // A little room top and bottom, so the dots at full and empty
            // aren't cut in half by the edge.
            .chartYScale(domain: 0...100, range: .plotDimension(padding: zoomed(3)))
            .chartXAxis(.hidden)
            .chartYAxis(.hidden)
            .chartPlotStyle { $0.background(Color.primary.opacity(0.025)) }
        } else {
            Color.clear
        }
    }
}
