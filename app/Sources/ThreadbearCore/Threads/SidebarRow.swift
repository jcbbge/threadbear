import Foundation

/// What a sidebar row shows at the right of its title line: the relative
/// time, or a word for a state worth seeing at a glance.
public enum ThreadRowStatus: Sendable, Hashable {
    /// Nothing to say: the row shows when it was last active.
    case time
    /// A turn is running (spinner and "Working" in the accent colour).
    case working
    /// No turn, but background sub-agents or jobs are still going (a grey
    /// spinner and what's running: "3 sub-agents"). `BackgroundWork.short`
    /// has the words; `label` is the generic one.
    case background
    /// Waiting on an approval or a question: the dot in the gutter says so.
    case needsYou
    /// The last turn failed.
    case failed
    /// The turn was cut off when the runner restarted.
    case stopped

    public var label: String? {
        switch self {
        case .time: return nil
        case .working: return "Working"
        case .background: return "In the background"
        case .needsYou: return "Needs you"
        case .failed: return "Failed"
        case .stopped: return "Stopped"
        }
    }
}

/// How a thread's sidebar row looks, worked out from its summary so the
/// rules are in one tested place rather than spread through the view.
public struct ThreadRowLook: Sendable, Equatable {
    public var status: ThreadRowStatus
    /// Waiting on Mike: a small accent dot before the title, whether the turn
    /// has finished or it's stopped partway to ask. One mark for one meaning:
    /// it used to say so in orange words on the right as well, and Mike asked
    /// for those to go (1 Nov), as the left side already says it. Not while
    /// sub-agents or jobs are still going: a dot by the spinner looked like
    /// two states at once, so it comes when they've finished.
    public var unread: Bool
    /// Semibold title: the thread needs Mike or is unread.
    public var emphasised: Bool
    /// The status is said in words. Under the Running heading a working
    /// row doesn't repeat it (the word took about 60 pt of the title line)
    /// and shows just its spinner.
    public var labelled: Bool
    /// Unread, and its last turn said nothing waits on Mike: a tick in the
    /// gutter instead of the dot, out of Needs you.
    public var done: Bool
    /// Back from hibernating by itself and not opened yet: "Woke up" where
    /// the time would be, so a thread turning up in the inbox says why.
    public var woke: Bool

    public init(status: ThreadRowStatus, unread: Bool, emphasised: Bool, labelled: Bool = true, done: Bool = false, woke: Bool = false) {
        self.done = done
        self.woke = woke
        self.status = status
        self.unread = unread
        self.emphasised = emphasised
        self.labelled = labelled
    }

    public init(_ thread: ThreadSummary, section: InboxSection? = nil) {
        if thread.reviewWaiting {
            status = .needsYou
        } else {
            switch thread.status {
            case .waiting: status = .needsYou
            case .running, .starting: status = .working
            case .error: status = .failed
            case .stopped: status = .stopped
            // Waiting on Mike, the row reads as any other asking thread's:
            // a spinner beside it would say there's nothing to do yet.
            case .idle: status = thread.background.isEmpty || thread.waitingOnMike ? .time : .background
            }
        }
        // A turn that said it needs nothing isn't in needsYou, but it's
        // still new: it gets a tick rather than nothing at all.
        done = status == .time && !thread.needsYou && thread.saidDone && thread.lastSeq > thread.lastSeenSeq
        unread = status == .needsYou || (thread.needsYou && status != .working && status != .background) || done
        emphasised = thread.needsYou || status == .needsYou || done
        labelled = !(status == .working && section == .running)
        woke = status == .time && thread.woke != nil
    }

    /// How long a running turn has been going, where the time would be:
    /// "53s", "4m", "1h 2m". The runner sets a thread's `lastActivityAt`
    /// when a turn starts (and when it ends or a message is sent), not on
    /// every event, so for a running thread it's the turn's start.
    public static func workingLabel(since start: Date, now: Date) -> String {
        let seconds = max(0, Int(saturating: now.timeIntervalSince(start)))
        if seconds < 60 { return "\(seconds)s" }
        let minutes = seconds / 60
        if minutes < 60 { return "\(minutes)m" }
        let hours = minutes / 60
        return minutes % 60 == 0 ? "\(hours)h" : "\(hours)h \(minutes % 60)m"
    }
}

/// The words for a thread that's woken from hibernating.
public enum WokeWords {
    /// The row's tooltip: "Woke up after hibernating for 2 days".
    public static func tip(_ woke: ThreadWoke) -> String {
        guard let since = woke.since, woke.at.timeIntervalSince(since) >= 60 else { return "Woke up from hibernating" }
        return "Woke up after hibernating for \(away(woke.at.timeIntervalSince(since)))"
    }

    /// Rounded, as the runner's note has it (awayFor in wake-when.ts):
    /// "5 minutes", "an hour", "3 hours", "a day", "12 days".
    public static func away(_ seconds: TimeInterval) -> String {
        let minutes = max(1, Int(saturating: (seconds / 60).rounded()))
        if minutes < 60 { return minutes == 1 ? "a minute" : "\(minutes) minutes" }
        let hours = Int(saturating: (seconds / 3600).rounded())
        if hours < 24 { return hours == 1 ? "an hour" : "\(hours) hours" }
        let days = Int(saturating: (seconds / 86_400).rounded())
        return days == 1 ? "a day" : "\(days) days"
    }
}

/// Snoozing or archiving a thread whose turn is underway makes the runner
/// stop that turn. From the row's hover buttons, where a stray click is
/// easy, that asks first; the menus and ⌘E are deliberate and don't.
public enum BusyThreadAction {
    public enum Action: Sendable {
        case archive, snooze
    }

    /// A turn underway, or background work the runner would stop.
    public static func needsConfirm(_ thread: ThreadSummary) -> Bool { thread.status.isBusy || !thread.background.isEmpty }

    /// The confirmation's question and its explanation.
    public static func prompt(_ action: Action, thread: ThreadSummary) -> (title: String, detail: String) {
        let verb = action == .archive ? "Archive" : "Hibernate"
        let doing = action == .archive ? "Archiving" : "Hibernating"
        if !thread.status.isBusy {
            // Only background work: sub-agents or jobs the runner stops
            // when it lets the CLI go.
            let what = BackgroundWork.short(thread.background).lowercased()
            return ("\(verb) and stop the background work?", "This thread still has \(what) in the background. \(doing) it now stops them.")
        }
        let state = thread.status == .waiting ? "is waiting for you" : "is still working"
        return ("\(verb) and stop the turn?", "This thread \(state). \(doing) it now stops its turn.")
    }
}

/// Names for accounts, for the sidebar, the composer and its menus. Built
/// from the account's email and provider rather than its title, so a Claude
/// login and a Codex login with the same address (claude-1 and codex-main
/// are both sam.lee@gmail.com) don't clash.
public enum AccountName {
    /// The bare address when the runner sends one, else the title without
    /// Codex's "Codex · " prefix (older runners), else the id.
    public static func title(_ account: Account) -> String {
        if let email = account.email, !email.isEmpty { return email }
        let prefix = "Codex · "
        if account.title.hasPrefix(prefix) { return String(account.title.dropFirst(prefix.count)) }
        return account.title.isEmpty ? account.id : account.title
    }

    /// A Claude account: the part of its email before the @, unless another
    /// Claude account shares it (then the whole address). A Codex account:
    /// "Codex" when it's the only Codex login, "Codex sam.lee" when
    /// there are several. Ids with no account are shown as they are.
    public static func short(_ id: String, accounts: [Account]) -> String {
        guard let account = accounts.first(where: { $0.id == id }) else { return id }
        let full = title(account)
        let siblings = accounts.filter { $0.id != id && $0.provider == account.provider }
        if account.provider == "codex" {
            guard !siblings.isEmpty else { return "Codex" }
            return "Codex " + localPart(full)
        }
        guard full.contains("@") else { return full }
        let local = localPart(full)
        let clashes = siblings.filter { localPart(title($0)) == local }
        return clashes.isEmpty ? local : full
    }

    /// A login as the pools picker and a pinned thread's chip name it: the
    /// first part of its email's domain ("acme" for
    /// sam@acme.io, "gmail" for sam.lee@gmail.com), since one person's
    /// logins mostly share a name before the @. When another login of the
    /// same provider has that domain too, the part before the @, else the
    /// whole address. Codex reads as `short` has it.
    public static func login(_ id: String, accounts: [Account]) -> String {
        guard let account = accounts.first(where: { $0.id == id }) else { return id }
        if account.provider == "codex" { return short(id, accounts: accounts) }
        let full = title(account)
        guard let domain = domainPart(full) else { return full }
        let siblings = accounts.filter { $0.id != id && $0.provider == account.provider }.map(title)
        if !siblings.contains(where: { domainPart($0) == domain }) { return domain }
        let local = localPart(full)
        return siblings.contains { localPart($0) == local } ? full : local
    }

    static func domainPart(_ address: String) -> String? {
        guard let at = address.firstIndex(of: "@") else { return nil }
        let domain = address[address.index(after: at)...]
        let first = domain.split(separator: ".").first.map(String.init) ?? ""
        return first.isEmpty ? nil : first
    }

    /// A name for a card, where a whole address doesn't fit: the part
    /// before the @ when that's the only one, else the domain's first part
    /// ("bearworks", "acme", "convex"), which is how Mike tells
    /// his logins apart. Codex as `short`; the whole address when neither
    /// is unique.
    public static func label(_ id: String, accounts: [Account]) -> String {
        guard let account = accounts.first(where: { $0.id == id }) else { return id }
        if account.provider == "codex" { return short(id, accounts: accounts) }
        let full = title(account)
        guard let at = full.firstIndex(of: "@") else { return full }
        let siblings = accounts.filter { $0.id != id && $0.provider == account.provider }.map(title)
        let local = localPart(full)
        if !siblings.contains(where: { localPart($0) == local }) { return local }
        func domain(_ address: String) -> String {
            guard let at = address.firstIndex(of: "@") else { return address }
            return String(address[address.index(after: at)...].prefix { $0 != "." })
        }
        let own = domain(String(full[at...]))
        return own.isEmpty || siblings.contains(where: { domain($0) == own }) ? full : own
    }

    static func localPart(_ address: String) -> String {
        guard let at = address.firstIndex(of: "@") else { return address }
        return String(address[..<at])
    }
}

/// The line under the title of a thread Mike didn't start: a symbol for who
/// started it, then its place, as his own threads' rows have. Who and why
/// are the symbol's tooltip. From 1 Nov the line spelled out "Sentry · 1
/// event"; on 4 Nov Mike wanted every row back to naming its project, with
/// only a mark to say a tool or agent started it. Nil for his own threads.
public enum ThreadByline {
    public struct Line: Sendable, Equatable {
        public var symbol: String
        public var text: String
        public var tip: String
    }

    public static let toolSymbol = "wrench.and.screwdriver"

    public static func line(_ thread: ThreadSummary, under heading: String? = nil) -> Line? {
        // A schedule's thread from before startedBy still says it's one.
        let started = thread.startedBy ?? thread.schedule.map { _ in ThreadStartedBy(kind: "schedule", label: "Schedule") }
        guard let started else { return nil }
        return Line(symbol: symbol(started), text: ProjectMark.place(thread, under: heading), tip: tip(started))
    }

    static func symbol(_ started: ThreadStartedBy) -> String {
        switch started.kind {
        case "schedule": return "clock"
        case "thread": return "pawprint"
        case "librarian": return "books.vertical"
        case "runner": return "bell"
        default: return started.icon.flatMap { $0.isEmpty ? nil : $0 } ?? toolSymbol
        }
    }

    static func tip(_ started: ThreadStartedBy) -> String {
        let from = started.threadTitle.flatMap { $0.isEmpty ? nil : $0 }
        let who: String
        switch started.kind {
        case "thread": who = from.map { "Started by another thread: \($0)" } ?? "Started by another thread"
        case "librarian": who = from.map { "Started by the librarian, from: \($0)" } ?? "Started by the librarian"
        default: who = "Started by \(started.label)"
        }
        // The why left the row's line for here.
        guard let why = started.why, !why.isEmpty else { return who }
        return who + " (" + why + ")"
    }
}

/// The tile at the start of a thread's row and the line under its title:
/// the projects it's in, or its folder when it's in none. Until projects
/// have icons a tile is the project's first letter or digit.
public enum ProjectMark {
    /// The projects the row names, oldest first. A row under a project's
    /// heading (the Projects view) leaves that one out: the heading says it.
    public static func shown(_ thread: ThreadSummary, under heading: String? = nil) -> [ThreadProject] {
        thread.projects.filter { $0.id != heading }
    }

    /// The line under the title: "Threadbear", "Threadbear, Photo sync"
    /// for a thread in two, or the folder ("misc") for one in none.
    public static func place(_ thread: ThreadSummary, under heading: String? = nil) -> String {
        let projects = shown(thread, under: heading)
        guard !projects.isEmpty else { return FolderName.short(thread.cwd) }
        return projects.map { title($0) }.joined(separator: ", ")
    }

    /// The place line's tooltip on a thread Mike started: what he last said
    /// to it ("You: try the GPU route"), else the place again. The line
    /// itself went back to the place on 4 Nov: Mike tried "You: <his last
    /// message>" and then the thread's latest headline there (3 Nov), and
    /// liked neither.
    public static func lineTip(_ thread: ThreadSummary, under heading: String? = nil) -> String {
        guard let asked = thread.asked, !asked.isEmpty else { return place(thread, under: heading) }
        return "You: " + asked
    }

    /// "C" for "Convex docs", "7" for "7 day plan", "?" for a title with
    /// neither (all emoji, or empty).
    public static func letter(_ title: String) -> String {
        guard let first = title.first(where: { $0.isLetter || $0.isNumber }) else { return "?" }
        return String(first).uppercased()
    }

    /// The tooltip: every project the thread is in, or its whole folder.
    public static func help(_ thread: ThreadSummary) -> String {
        thread.projects.isEmpty ? thread.cwd : thread.projects.map { title($0) }.joined(separator: ", ")
    }

    static func title(_ project: ThreadProject) -> String { project.title.isEmpty ? "Untitled project" : project.title }
}

/// A working folder as the sidebar header and the new-thread line name it:
/// its last component ("misc" for ~/dev/me/misc).
public enum FolderName {
    public static func short(_ path: String) -> String {
        guard let last = path.split(separator: "/").last else { return path.isEmpty ? "" : "/" }
        return String(last)
    }
}

/// Up and down through the sidebar's rows from the keyboard.
public enum SidebarOrder {
    /// The id `step` rows from `current` in `ids`, stopping at either end.
    /// With nothing selected (or the selection not in the list), down goes
    /// to the first row and up to the last.
    public static func neighbour(of current: String?, in ids: [String], step: Int) -> String? {
        guard !ids.isEmpty else { return nil }
        guard let current, let index = ids.firstIndex(of: current) else {
            return step >= 0 ? ids.first : ids.last
        }
        return ids[min(max(index + step, 0), ids.count - 1)]
    }

    /// Next Inbox Thread (⌥⌘↓). From a thread in the Inbox section, the one
    /// below it; from anywhere else (another section, a project, nothing
    /// open), the Inbox's first. Nil when there's nothing further: the
    /// open thread is the Inbox's last, or the Inbox is empty.
    public static func nextInInbox(after current: String?, inbox: [String]) -> String? {
        guard let current, let index = inbox.firstIndex(of: current) else { return inbox.first }
        return index + 1 < inbox.count ? inbox[index + 1] : nil
    }
}
