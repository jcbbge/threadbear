import Foundation

// The rows `convex/phone.ts` returns. Field names follow the runner's
// ThreadSummary (runner/src/protocol.ts) so the two read the same; the
// runner mirrors only what the phone shows (docs/convex-backend.md).

public enum ThreadStatus: String, Codable, Sendable {
    case idle, starting, running, waiting, error, stopped
    /// A status a newer runner sends that this build doesn't know.
    case unknown

    public init(from decoder: Decoder) throws {
        let raw = try decoder.singleValueContainer().decode(String.self)
        self = ThreadStatus(rawValue: raw) ?? .unknown
    }
}

public enum ApprovalOption: String, Codable, Sendable, Hashable {
    case allow, allowAlways, deny
}

public struct Question: Codable, Sendable, Hashable {
    public struct Option: Codable, Sendable, Hashable {
        public var label: String
        public var description: String?
        public init(label: String, description: String? = nil) {
            self.label = label
            self.description = description
        }
    }

    public var question: String
    public var header: String?
    public var multiSelect: Bool
    public var options: [Option]

    public init(question: String, header: String? = nil, multiSelect: Bool = false, options: [Option]) {
        self.question = question
        self.header = header
        self.multiSelect = multiSelect
        self.options = options
    }
}

/// What a thread is stuck on: a tool wanting permission, the agent's
/// questions, or a secret it asked for (backend API 35).
public enum PendingApproval: Codable, Sendable, Hashable {
    case approval(id: String, name: String, title: String, options: [ApprovalOption], inputSummary: String?)
    case question(id: String, questions: [Question])
    /// `ask_secret` (docs/protocol.md, "Secrets"): `key` is the runner's
    /// X25519 public key (raw, base64), which the phone seals the value to.
    case secret(id: String, label: String, reason: String, placeholder: String?, key: String)
    /// A kind this build doesn't know: the thread waits, and the card says
    /// to answer it on the Mac rather than guessing at buttons.
    case other(id: String, kind: String)

    public var id: String {
        switch self {
        case let .approval(id, _, _, _, _), let .question(id, _), let .secret(id, _, _, _, _), let .other(id, _): id
        }
    }

    private enum Keys: String, CodingKey { case approvalId, kind, name, title, options, inputSummary, questions, label, reason, placeholder, key }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        let id = try c.decode(String.self, forKey: .approvalId)
        switch try c.decodeIfPresent(String.self, forKey: .kind) {
        case "question":
            self = .question(id: id, questions: try c.decode([Question].self, forKey: .questions))
        case "secret":
            // Missing a key, it can't be sealed to: the Mac has to answer it.
            guard let key = try c.decodeIfPresent(String.self, forKey: .key) else {
                self = .other(id: id, kind: "secret")
                return
            }
            self = .secret(
                id: id,
                label: try c.decodeIfPresent(String.self, forKey: .label) ?? "A secret",
                reason: try c.decodeIfPresent(String.self, forKey: .reason) ?? "",
                placeholder: try c.decodeIfPresent(String.self, forKey: .placeholder),
                key: key)
        case nil, "approval":
            // Options this build doesn't know are dropped rather than
            // failing the whole inbox.
            let raw = try c.decodeIfPresent([String].self, forKey: .options) ?? ["allow", "deny"]
            self = .approval(
                id: id,
                name: try c.decodeIfPresent(String.self, forKey: .name) ?? "",
                title: try c.decodeIfPresent(String.self, forKey: .title) ?? "Permission",
                options: raw.compactMap(ApprovalOption.init(rawValue:)),
                inputSummary: try c.decodeIfPresent(String.self, forKey: .inputSummary)
            )
        case let kind?:
            self = .other(id: id, kind: kind)
        }
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: Keys.self)
        switch self {
        case let .approval(id, name, title, options, inputSummary):
            try c.encode(id, forKey: .approvalId)
            try c.encode("approval", forKey: .kind)
            try c.encode(name, forKey: .name)
            try c.encode(title, forKey: .title)
            try c.encode(options, forKey: .options)
            try c.encodeIfPresent(inputSummary, forKey: .inputSummary)
        case let .question(id, questions):
            try c.encode(id, forKey: .approvalId)
            try c.encode("question", forKey: .kind)
            try c.encode(questions, forKey: .questions)
        case let .secret(id, label, reason, placeholder, key):
            try c.encode(id, forKey: .approvalId)
            try c.encode("secret", forKey: .kind)
            try c.encode(label, forKey: .label)
            try c.encode(reason, forKey: .reason)
            try c.encodeIfPresent(placeholder, forKey: .placeholder)
            try c.encode(key, forKey: .key)
        case let .other(id, kind):
            try c.encode(id, forKey: .approvalId)
            try c.encode(kind, forKey: .kind)
        }
    }
}

public struct ProjectRef: Codable, Sendable, Hashable {
    public var id: String
    public var title: String
    public init(id: String, title: String) {
        self.id = id
        self.title = title
    }
}

/// A project's icon as the Mac shows it (docs/protocol.md, "Icons"): its
/// picture, here a URL into the backend's file storage (backend API 5),
/// else an SF Symbol. Neither: the title's first letter.
public struct PhoneProjectIcon: Codable, Sendable, Hashable {
    public var symbol: String?
    public var url: URL?
    /// "mike", "agent" or "librarian": who chose it.
    public var by: String?

    public init(symbol: String? = nil, url: URL? = nil, by: String? = nil) {
        self.symbol = symbol
        self.url = url
        self.by = by
    }

    private enum Keys: String, CodingKey { case symbol, url, by }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        symbol = (try? c.decodeIfPresent(String.self, forKey: .symbol)).flatMap { $0 }.flatMap { $0.isEmpty ? nil : $0 }
        // A URL that doesn't parse is no picture, not a broken row.
        url = (try? c.decodeIfPresent(String.self, forKey: .url)).flatMap { $0 }.flatMap(URL.init(string:)).flatMap { $0.scheme == nil ? nil : $0 }
        by = (try? c.decodeIfPresent(String.self, forKey: .by)).flatMap { $0 }
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: Keys.self)
        try c.encodeIfPresent(symbol, forKey: .symbol)
        try c.encodeIfPresent(url?.absoluteString, forKey: .url)
        try c.encodeIfPresent(by, forKey: .by)
    }
}

/// A row of phone:projects: what a thread's ProjectRef points at, as far as
/// the rows need (the icon, the title). The rest of the runner's Project is
/// in the row too but not read yet.
public struct PhoneProject: Codable, Sendable, Hashable, Identifiable {
    public var id: String
    public var runnerId: String?
    public var title: String
    public var archived: Bool?
    public var icon: PhoneProjectIcon?

    public init(id: String, runnerId: String? = nil, title: String, archived: Bool? = nil, icon: PhoneProjectIcon? = nil) {
        self.id = id
        self.runnerId = runnerId
        self.title = title
        self.archived = archived
        self.icon = icon
    }

    private enum Keys: String, CodingKey { case id, runnerId, title, archived, icon }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        id = try c.decode(String.self, forKey: .id)
        runnerId = (try? c.decodeIfPresent(String.self, forKey: .runnerId)).flatMap { $0 }
        title = (try? c.decodeIfPresent(String.self, forKey: .title)).flatMap { $0 } ?? ""
        archived = (try? c.decodeIfPresent(Bool.self, forKey: .archived)).flatMap { $0 }
        icon = (try? c.decodeIfPresent(PhoneProjectIcon.self, forKey: .icon)).flatMap { $0 }
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: Keys.self)
        try c.encode(id, forKey: .id)
        try c.encodeIfPresent(runnerId, forKey: .runnerId)
        try c.encode(title, forKey: .title)
        try c.encodeIfPresent(archived, forKey: .archived)
        try c.encodeIfPresent(icon, forKey: .icon)
    }
}

/// "C" for "Convex docs", "7" for "7 day plan", "?" for a title with
/// neither (all emoji, or empty). The Mac's ProjectMark.letter.
public enum ProjectMark {
    public static func letter(_ title: String) -> String {
        guard let first = title.first(where: { $0.isLetter || $0.isNumber }) else { return "?" }
        return String(first).uppercased()
    }
}

/// When a hibernating thread came back by itself, and when it went away.
public struct Woke: Codable, Sendable, Hashable {
    @FlexibleDate public var at: Date
    @OptionalFlexibleDate public var since: Date?

    public init(at: Date, since: Date? = nil) {
        self._at = FlexibleDate(wrappedValue: at)
        self._since = OptionalFlexibleDate(wrappedValue: since)
    }
}

public struct PhoneThread: Codable, Sendable, Hashable, Identifiable {
    public var id: String { threadId }
    public var threadId: String
    public var runnerId: String
    public var title: String
    public var cwd: String
    public var accountId: String
    public var provider: String
    public var model: String?
    public var status: ThreadStatus
    public var needsYou: Bool
    public var unread: Bool
    public var preview: String
    @FlexibleDate public var lastActivityAt: Date
    @OptionalFlexibleDate public var snoozedUntil: Date?
    public var snoozedUntilRestart: Bool?
    /// What it waits for while hibernating, when that's more than a time
    /// ("\"Convex I/O\" finishes", "the runner updates"; backend API 49). Nil
    /// for a plain time and from an older runner.
    public var wakeNote: String?
    /// Back from hibernating by itself and not opened yet: the row says
    /// "Woke up", as the Mac's does.
    public var woke: Woke?
    /// Who started it, when Mike didn't: the row's second line says so.
    public var startedBy: StartedBy?
    /// What Mike last said to it, one line (backend API 31): the row's
    /// "You: ...". Nil until he's sent one, and from an older runner.
    public var asked: String?
    @OptionalFlexibleDate public var archivedAt: Date?
    /// Mike starred it: the Starred section at the top (backend API 27).
    @OptionalFlexibleDate public var starredAt: Date?
    public var costUsd: Double?
    public var projects: [ProjectRef]?
    /// The working line ("Running npm test"), while a turn or background
    /// work is going.
    public var working: String?
    public var pendingApproval: PendingApproval?
    /// The seq of the thread's first text message, so the phone knows
    /// whether there's anything older than what it has to load. A Convex
    /// number, so a Double on the wire.
    public var earliestSeq: Double?
    /// The open card of asks from the agent's end_turn (backend API 14):
    /// what Mike has to do, shown under the reply with its options.
    public var asks: [PhoneAsk]?
    /// Which turn the card came with (a Convex number).
    public var asksSeq: Double?
    /// A finished turn's suggested follow-ups (end_turn's `next`), for the
    /// done card.
    public var next: [String]?
    /// What the last completed turn said it needs from Mike, "you" or
    /// "nothing" (backend API 15). Absent: it said neither.
    public var needs: String?
    /// Design reviews waiting on Mike (backend API 15), a Convex number.
    public var pendingReviews: Double?
    /// Every login it could use is out of room until then (backend API 15).
    public var waitingForRoom: PhoneWaitingForRoom?
    /// Its last turn couldn't reach the API (the internet went); it carries
    /// on by itself once the runner can (backend API 34).
    public var waitingForNetwork: PhoneWaitingForNetwork?
    /// The thread's patch link buttons (backend API 28): pages the phone
    /// opens itself, as the Mac's url chips do there.
    public var links: [PhoneLink]?

    public init(
        threadId: String, runnerId: String = "mac", title: String, cwd: String = "~/ThreadbearThreads",
        accountId: String = "claude-main", provider: String = "claude", model: String? = nil,
        status: ThreadStatus = .idle, needsYou: Bool = false, unread: Bool = false, preview: String = "",
        lastActivityAt: Date, snoozedUntil: Date? = nil, snoozedUntilRestart: Bool? = nil, woke: Woke? = nil, archivedAt: Date? = nil, starredAt: Date? = nil,
        costUsd: Double? = nil, projects: [ProjectRef]? = nil, working: String? = nil,
        pendingApproval: PendingApproval? = nil, earliestSeq: Double? = nil,
        asks: [PhoneAsk]? = nil, asksSeq: Double? = nil, next: [String]? = nil,
        needs: String? = nil, pendingReviews: Double? = nil, waitingForRoom: PhoneWaitingForRoom? = nil,
        links: [PhoneLink]? = nil, asked: String? = nil
    ) {
        self.asked = asked
        self.threadId = threadId
        self.runnerId = runnerId
        self.title = title
        self.cwd = cwd
        self.accountId = accountId
        self.provider = provider
        self.model = model
        self.status = status
        self.needsYou = needsYou
        self.unread = unread
        self.preview = preview
        self._lastActivityAt = FlexibleDate(wrappedValue: lastActivityAt)
        self._snoozedUntil = OptionalFlexibleDate(wrappedValue: snoozedUntil)
        self.snoozedUntilRestart = snoozedUntilRestart
        self.woke = woke
        self._archivedAt = OptionalFlexibleDate(wrappedValue: archivedAt)
        self._starredAt = OptionalFlexibleDate(wrappedValue: starredAt)
        self.costUsd = costUsd
        self.projects = projects
        self.working = working
        self.pendingApproval = pendingApproval
        self.earliestSeq = earliestSeq
        self.asks = asks
        self.asksSeq = asksSeq
        self.next = next
        self.needs = needs
        self.pendingReviews = pendingReviews
        self.waitingForRoom = waitingForRoom
        self.links = links
    }

    public var isBusy: Bool { status == .running || status == .starting }

    /// A design review is waiting on Mike and the thread has finished
    /// working, as the Mac's ThreadSummary.reviewWaiting.
    public var reviewWaiting: Bool { (pendingReviews ?? 0) > 0 && !isBusy && working == nil }

    /// The last turn ended asking Mike for something and he hasn't done it
    /// all yet, as the Mac's ThreadSummary.waitingOnMike: read or not, and
    /// whatever job it left running. The Mac also waits for sub-agents to
    /// finish; here the runner does that by leaving `needs` out until then
    /// (toThreadDoc), as `working` can't tell a sub-agent from a job.
    public var waitingOnMike: Bool {
        guard needs == "you", !isBusy else { return false }
        let asks = asks ?? []
        return asks.isEmpty || asks.contains { $0.ticked != true }
    }

    /// Whether there are older text messages on the Mac than `oldestSeq`,
    /// the oldest the phone has. False when the runner doesn't say.
    public func hasEarlier(than oldestSeq: Int?) -> Bool {
        guard let earliestSeq, let oldestSeq else { return false }
        return Double(oldestSeq) > earliestSeq
    }

    /// The last folder name, for a thread in no project: "misc".
    public var folderName: String {
        let trimmed = cwd.hasSuffix("/") ? String(cwd.dropLast()) : cwd
        return trimmed.split(separator: "/").last.map(String.init) ?? cwd
    }

    /// Line 2 of a row: the projects, comma-joined, or the folder, as on
    /// the Mac sidebar.
    public var placeText: String {
        if let projects, !projects.isEmpty { return projects.map(\.title).joined(separator: ", ") }
        return folderName
    }

    /// Who started a thread Mike didn't, and why, for VoiceOver on the
    /// symbol before its place (the Mac has it as the symbol's tooltip).
    /// Line 2 used to spell this out; since 4 Nov every row names its place
    /// and only the symbol marks a tool or agent's thread. Nil for his own.
    public var bylineText: String? {
        guard let startedBy else { return nil }
        let who = "Started by " + startedBy.label
        guard let why = startedBy.why, !why.isEmpty else { return who }
        return who + " (" + why + ")"
    }
}

/// Who started a thread, when Mike didn't (the Mac's ThreadStartedBy).
/// A patch's link button (an action with a url), as the runner sends it:
/// the phone opens the page itself.
public struct PhoneLink: Codable, Sendable, Hashable {
    public var title: String
    public var url: String
    /// An SF Symbol, from the patch; nil for the default.
    public var icon: String?

    public init(title: String, url: String, icon: String? = nil) {
        self.title = title
        self.url = url
        self.icon = icon
    }

    /// The page, only if it's http or https: never a file or another app.
    public var page: URL? {
        guard let page = URL(string: url), let scheme = page.scheme?.lowercased(),
              scheme == "http" || scheme == "https", page.host?.isEmpty == false else { return nil }
        return page
    }
}

public struct StartedBy: Codable, Sendable, Hashable {
    public var kind: String
    public var label: String
    public var icon: String?
    public var why: String?

    public init(kind: String, label: String, icon: String? = nil, why: String? = nil) {
        self.kind = kind
        self.label = label
        self.icon = icon
        self.why = why
    }

    /// The SF Symbol for its row, as the Mac's.
    public var symbol: String {
        switch kind {
        case "schedule": "clock"
        case "thread": "pawprint"
        case "librarian": "books.vertical"
        case "runner": "bell"
        default: icon.flatMap { $0.isEmpty ? nil : $0 } ?? "wrench.and.screwdriver"
        }
    }
}

/// When a thread waiting for a login with room can go on.
public struct PhoneWaitingForNetwork: Codable, Sendable, Hashable {
    /// When the line first went (ISO).
    public var since: String

    public init(since: String) {
        self.since = since
    }
}

public struct PhoneWaitingForRoom: Codable, Sendable, Hashable {
    public var until: String
    public var accountId: String?

    public init(until: String, accountId: String? = nil) {
        self.until = until
        self.accountId = accountId
    }
}

/// A row of phone:schedules: a message the runner sends by itself, once or
/// on a cron. The phone reads only what the inbox's Waiting section needs.
public struct PhoneSchedule: Codable, Sendable, Hashable, Identifiable {
    public var id: String
    public var runnerId: String?
    public var title: String
    /// "Every weekday at 9:00", "Tomorrow at 10:00": the runner's words.
    public var whenText: String
    /// The thread it messages. Absent: it starts a new thread each time.
    public var threadId: String?
    public var paused: Bool
    @OptionalFlexibleDate public var nextRunAt: Date?
    @OptionalFlexibleDate public var finishedAt: Date?

    public init(id: String, runnerId: String? = nil, title: String = "", whenText: String = "", threadId: String? = nil,
                paused: Bool = false, nextRunAt: Date? = nil, finishedAt: Date? = nil) {
        self.id = id
        self.runnerId = runnerId
        self.title = title
        self.whenText = whenText
        self.threadId = threadId
        self.paused = paused
        self._nextRunAt = OptionalFlexibleDate(wrappedValue: nextRunAt)
        self._finishedAt = OptionalFlexibleDate(wrappedValue: finishedAt)
    }

    private enum Keys: String, CodingKey { case id, runnerId, title, whenText, threadId, paused, nextRunAt, finishedAt }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        id = try c.decode(String.self, forKey: .id)
        runnerId = (try? c.decodeIfPresent(String.self, forKey: .runnerId)).flatMap { $0 }
        title = (try? c.decodeIfPresent(String.self, forKey: .title)).flatMap { $0 } ?? ""
        whenText = (try? c.decodeIfPresent(String.self, forKey: .whenText)).flatMap { $0 } ?? ""
        threadId = (try? c.decodeIfPresent(String.self, forKey: .threadId)).flatMap { $0 }
        paused = (try? c.decodeIfPresent(Bool.self, forKey: .paused)).flatMap { $0 } ?? false
        _nextRunAt = try c.decode(OptionalFlexibleDate.self, forKey: .nextRunAt)
        _finishedAt = try c.decode(OptionalFlexibleDate.self, forKey: .finishedAt)
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: Keys.self)
        try c.encode(id, forKey: .id)
        try c.encodeIfPresent(runnerId, forKey: .runnerId)
        try c.encode(title, forKey: .title)
        try c.encode(whenText, forKey: .whenText)
        try c.encodeIfPresent(threadId, forKey: .threadId)
        try c.encode(paused, forKey: .paused)
        try c.encode(_nextRunAt, forKey: .nextRunAt)
        try c.encode(_finishedAt, forKey: .finishedAt)
    }

    /// Still going to run by itself, as the Mac's Schedule.isActive.
    public var isActive: Bool { !paused && finishedAt == nil }
}

public struct PhoneMessage: Codable, Sendable, Hashable, Identifiable {
    /// `tool` is one line for a tool call (backend API 2, phone:messages).
    public enum Role: String, Codable, Sendable { case user, assistant, tool }

    public var id: Int { seq }
    public var seq: Int
    public var role: Role
    public var text: String
    /// Where a user message came from: "phone", "schedule", "runner", or
    /// absent for the Mac.
    public var origin: String?
    /// For a tool line: the protocol's ToolKind ("command", "read", "edit"...).
    public var toolKind: String?
    /// The turn's summary bullets from end_turn, its reply (backend API 14).
    public var summary: Bool
    /// Which turn it's from (backend API 26), as a turn the CLI started by
    /// itself has no message to mark where it starts. Absent on older rows.
    public var turn: String?
    /// On the first row of a turn the agent started by itself: the
    /// sub-agents and jobs whose finishing woke it (backend API 33).
    public var wokeBy: [WokeTask]?
    /// The reply buttons its text links as `[title](button:<id>)`, as they
    /// are now (backend API 59, ReplyButtons.swift).
    public var buttons: [MessageButton]?
    @FlexibleDate public var at: Date

    public init(seq: Int, role: Role, text: String, origin: String? = nil, toolKind: String? = nil, summary: Bool = false, turn: String? = nil, wokeBy: [WokeTask]? = nil, buttons: [MessageButton]? = nil, at: Date) {
        self.seq = seq
        self.role = role
        self.text = text
        self.origin = origin
        self.toolKind = toolKind
        self.summary = summary
        self.turn = turn
        self.wokeBy = wokeBy
        self.buttons = buttons
        self._at = FlexibleDate(wrappedValue: at)
    }

    private enum Keys: String, CodingKey { case seq, role, text, origin, toolKind, summary, turn, wokeBy, buttons, at }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        // Convex numbers are float64, so seq comes back as 12.0.
        guard let seq = try c.decode(Double.self, forKey: .seq).wholeCount() else {
            throw DecodingError.dataCorruptedError(forKey: .seq, in: c, debugDescription: "Not a seq")
        }
        self.seq = seq
        role = try c.decode(Role.self, forKey: .role)
        text = try c.decode(String.self, forKey: .text)
        origin = try c.decodeIfPresent(String.self, forKey: .origin)
        toolKind = try c.decodeIfPresent(String.self, forKey: .toolKind)
        summary = (try? c.decodeIfPresent(Bool.self, forKey: .summary)).flatMap { $0 } ?? false
        turn = try? c.decodeIfPresent(String.self, forKey: .turn)
        wokeBy = (try? c.decodeIfPresent([WokeTask].self, forKey: .wokeBy)).flatMap { $0 }
        buttons = (try? c.decodeIfPresent([MessageButton].self, forKey: .buttons)).flatMap { $0 }
        _at = try c.decode(FlexibleDate.self, forKey: .at)
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: Keys.self)
        try c.encode(Double(seq), forKey: .seq)
        try c.encode(role, forKey: .role)
        try c.encode(text, forKey: .text)
        try c.encodeIfPresent(origin, forKey: .origin)
        try c.encodeIfPresent(toolKind, forKey: .toolKind)
        if summary { try c.encode(true, forKey: .summary) }
        try c.encodeIfPresent(turn, forKey: .turn)
        try c.encodeIfPresent(wokeBy, forKey: .wokeBy)
        try c.encodeIfPresent(buttons, forKey: .buttons)
        try c.encode(_at, forKey: .at)
    }
}

/// When this phone is notified that a thread needs Mike (backend API 3).
/// `away` (the default) only while he isn't at the Mac: the Mac app is
/// closed, or the keyboard and mouse have been idle a couple of minutes.
public enum NotifyMode: String, CaseIterable, Sendable, Codable {
    case away, always, off

    public var label: String {
        switch self {
        case .away: "When I'm away from the Mac"
        case .always: "Always"
        case .off: "Never"
        }
    }
}

/// phone:messages: a thread's newest messages, oldest first, and whether
/// there are older ones.
public struct MessagePage: Codable, Sendable, Hashable {
    public var messages: [PhoneMessage]
    public var hasMore: Bool
    /// The thread's pictures in file storage, from the page's first row on
    /// (backend API 24 for the ones the phone shows).
    public var images: [MessageImage]
    public init(messages: [PhoneMessage], hasMore: Bool, images: [MessageImage] = []) {
        self.messages = messages
        self.hasMore = hasMore
        self.images = images
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        messages = try c.decode([PhoneMessage].self, forKey: .messages)
        hasMore = try c.decode(Bool.self, forKey: .hasMore)
        images = try c.decodeIfPresent([MessageImage].self, forKey: .images) ?? []
    }
}

/// A picture in file storage. `src` is the address the agent wrote in that
/// message; `pinned` is one it pinned. A row with neither is a shared
/// thread's attachment or tool picture, which the phone doesn't show.
public struct MessageImage: Codable, Sendable, Hashable, Identifiable {
    public var id: String { url }
    public var seq: Int
    public var src: String?
    public var pinned: Bool?
    public var url: String
    public var width: Int?
    public var height: Int?

    public init(seq: Int, src: String? = nil, pinned: Bool? = nil, url: String, width: Int? = nil, height: Int? = nil) {
        self.seq = seq
        self.src = src
        self.pinned = pinned
        self.url = url
        self.width = width
        self.height = height
    }
}

/// Where a thread's pictures go among its messages.
public struct ThreadPictures: Sendable, Hashable {
    public var images: [MessageImage]

    public init(_ images: [MessageImage] = []) { self.images = images }

    /// The picture for `src` in the message at `seq`. The same address in
    /// another message may be a different picture by now, so that message's
    /// own comes first; failing that, the latest with that address at or
    /// before it, then any.
    public func image(src: String, seq: Int?) -> MessageImage? {
        let matching = images.filter { $0.src == src }
        guard let seq else { return matching.last }
        return matching.first { $0.seq == seq } ?? matching.last { $0.seq <= seq } ?? matching.last
    }

    /// A web picture needs nothing uploaded. Anything else unmatched is on
    /// the Mac.
    public static func webURL(_ src: String) -> URL? {
        guard src.lowercased().hasPrefix("https://") else { return nil }
        return URL(string: src)
    }

    /// Pinned pictures by the message they go under: the turn's reply, the
    /// first message from the agent on show at or after the pin, as the pin's
    /// own line is folded away with the work. `trailing` have no reply yet.
    public func pinned(in items: [ThreadItem]) -> (under: [Int: [MessageImage]], trailing: [MessageImage]) {
        let replies = items.compactMap { item -> Int? in
            if case let .message(m) = item, m.role == .assistant { m.seq } else { nil }
        }
        var under: [Int: [MessageImage]] = [:]
        var trailing: [MessageImage] = []
        for image in images where image.pinned == true {
            if let reply = replies.first(where: { $0 >= image.seq }) {
                under[reply, default: []].append(image)
            } else {
                trailing.append(image)
            }
        }
        return (under, trailing)
    }
}

/// A thread as shown: messages, with the tool calls between two of them
/// gathered into one run.
public enum ThreadItem: Identifiable, Hashable, Sendable {
    case message(PhoneMessage)
    case tools([PhoneMessage])
    /// A finished turn's work, folded into one "Worked for 2m 13s" line
    /// (Turns.fold).
    case worked(WorkedTurn)
    /// "6 min later · Mine the repo finished" before a turn the agent
    /// started by itself (Turns.fold).
    case gap(TurnGap)

    public var id: Int {
        switch self {
        case let .message(m): m.seq
        case let .tools(items): items.first?.seq ?? 0
        // Negative, so it never meets the seq of the message it folds.
        case let .worked(w): -(w.items.first?.id ?? 0) - 1
        // Further down still, clear of any worked line's.
        case let .gap(g): -g.seq - 1_000_000_000
        }
    }

    public static func group(_ messages: [PhoneMessage]) -> [ThreadItem] {
        var out: [ThreadItem] = []
        for m in messages {
            if m.role == .tool {
                if case var .tools(items)? = out.last {
                    items.append(m)
                    out[out.count - 1] = .tools(items)
                } else {
                    out.append(.tools([m]))
                }
            } else {
                out.append(.message(m))
            }
        }
        return out
    }
}

public struct ThreadDetail: Codable, Sendable, Hashable {
    public var thread: PhoneThread
    public var messages: [PhoneMessage]
    public init(thread: PhoneThread, messages: [PhoneMessage]) {
        self.thread = thread
        self.messages = messages
    }
}

public struct PhoneRunner: Codable, Sendable, Hashable, Identifiable {
    public var id: String { runnerId }
    public var runnerId: String
    public var name: String
    public var version: String?
    @FlexibleDate public var lastSeenAt: Date
    public var draining: Bool?
    /// In the order Mike set (backend API 56), so it can be a new thread's
    /// automatic choice. A runner he hasn't placed (with no order, every one
    /// but the main Mac) is only ever picked by hand.
    public var placed: Bool?
    /// The main Mac (backend API 56): heartbeating with the owner key. A new
    /// thread waits for it when none of the placed runners is online.
    public var main: Bool?

    public init(runnerId: String, name: String, version: String? = nil, lastSeenAt: Date, draining: Bool? = nil, placed: Bool? = nil, main: Bool? = nil) {
        self.runnerId = runnerId
        self.name = name
        self.version = version
        self._lastSeenAt = FlexibleDate(wrappedValue: lastSeenAt)
        self.draining = draining
        self.placed = placed
        self.main = main
    }

    /// The runner writes a heartbeat every 60 s; three missed is offline.
    public static let offlineAfter: TimeInterval = 180

    public func isOnline(at now: Date) -> Bool { now.timeIntervalSince(lastSeenAt) < Self.offlineAfter }
}

public struct PhoneIdentity: Codable, Sendable, Hashable {
    public var name: String
    @OptionalFlexibleDate public var expiresAt: Date?
    /// The backend's API version (convex/version.ts). Missing from backends
    /// deployed before there was one.
    public var apiVersion: Int?
    /// The backend can't send notifications (a self-hosted one, which the
    /// push relay doesn't reach: docs/self-hosting.md). Missing means it can.
    public var pushOff: Bool?
    public var sendsNotifications: Bool { pushOff != true }
    public init(name: String, expiresAt: Date?, apiVersion: Int? = nil, pushOff: Bool? = nil) {
        self.name = name
        self._expiresAt = OptionalFlexibleDate(wrappedValue: expiresAt)
        self.apiVersion = apiVersion
        self.pushOff = pushOff
    }
}

/// Whether the backend on the Mac is new enough for this build of the app.
/// The App Store app meets backends of every age (everyone's Threadbear
/// updates on its own schedule), so it says when one is too old rather than
/// failing in odd ways. docs/setup-and-updates.md section 2.4.
public enum BackendCompatibility {
    /// The lowest backend API version this app works with. Raise it only when
    /// the app starts relying on something a newer backend added.
    public static let minimumAPIVersion = 1
    /// The newest backend API this app knows. From 2 a thread's messages come
    /// from phone:messages (every message and tool line, paged in Convex);
    /// an older backend still gets phone:thread and the runner's paging.
    public static let currentAPIVersion = 35
    public static let messagePagesAPIVersion = 2
    /// From 3 each phone chooses when it's notified (phone:setNotifications).
    public static let notificationSettingAPIVersion = 3
    /// From 4 registerDevice takes the phone's relay key.
    public static let pushKeyAPIVersion = 4
    /// From 5 phone:projects rows carry each project's icon (a symbol, and
    /// a picture as a URL). Older backends answer the same query without it.
    public static let projectIconsAPIVersion = 5
    /// From 10 phone:quickAsk records a quick ask as a thread.
    public static let quickAskAPIVersion = 10
    /// From 14 thread rows carry the open card of asks and the done card's
    /// next steps, and phone:send takes answers. Older backends leave them
    /// out, and the phone shows neither card.
    public static let asksAPIVersion = 14
    /// From 15 thread rows carry needs, pendingReviews and waitingForRoom,
    /// so the inbox's sections match the Mac's. Older backends leave them
    /// out, and a thread with a schedule waits unless it needs Mike in a
    /// way the phone can see.
    public static let sectionsAPIVersion = 15
    /// From 16 phone:search finds archived threads past the den's newest
    /// 100. Older backends don't have it, and the search stops at those.
    public static let searchAPIVersion = 16
    /// From 17 phone:counts says how many threads are hibernating and
    /// archived, for the folded headings. Older backends don't have it, so
    /// those headings show no number until opened.
    public static let countsAPIVersion = 17
    /// From 18 a message can carry photos (phone:imageUploadUrl). Older
    /// backends can't take them, so the phone doesn't offer them.
    public static let photosAPIVersion = 18
    /// From 19 the Pocket (phone:pocket). Cards already saved on the phone
    /// still show on anything older, or with no signal.
    public static let pocketAPIVersion = 19
    /// From 20 accounts carry their models and phone:create takes an effort,
    /// for the new thread pickers. Older backends get neither picker.
    public static let modelsAPIVersion = 20
    /// From 27 threads can be starred (phone:update's `star`). Older backends
    /// would refuse it, so the phone doesn't offer it.
    public static let starsAPIVersion = 27
    /// From 35 a thread row's pendingApproval can be a secret card, answered
    /// sealed with phone:secret. An older backend has neither, so the phone
    /// says to answer it on the Mac.
    public static let secretsAPIVersion = 35
    /// From 42 phone:update's archive can carry a verdict, how the thread
    /// went (the done card's Archive menu). Older backends refuse the extra
    /// field, so the done card archives straight away there, as before.
    public static let archiveVerdictAPIVersion = 42
    /// From 43 phone:threadsSince: the inbox's changes rather than the whole
    /// list for every row written.
    public static let threadChangesAPIVersion = 43
    /// From 56 runners have an order (phone:setRunnerOrder) and phone:runners
    /// lists them in it, so the new thread sheet can offer a runner, starting
    /// on the first one online. Older backends get no runner picker.
    public static let runnerOrderAPIVersion = 56
    /// From 57 phone:waiting lists a thread's messages its runner hasn't
    /// taken yet, and phone:cancel takes one back. Older backends have
    /// neither, so the phone only shows a line for the last one it sent.
    public static let waitingSendsAPIVersion = 57

    /// The line to show, or nil when the backend is fine.
    public static func problem(_ identity: PhoneIdentity) -> String? {
        let version = identity.apiVersion ?? 0
        guard version < minimumAPIVersion else { return nil }
        return "Threadbear on your Mac is older than this app expects, so some things may not work. Update it on the Mac."
    }
}

public enum CommandState: String, Codable, Sendable {
    case pending, taken, done, failed
}

public struct CommandStatus: Codable, Sendable, Hashable {
    public var state: CommandState
    public var note: String?
    public var threadId: String?
    public init(state: CommandState, note: String? = nil, threadId: String? = nil) {
        self.state = state
        self.note = note
        self.threadId = threadId
    }
}

/// phone:counts (backend API 16): how many threads are hibernating and
/// archived, uncapped. Convex numbers, so Doubles on the wire.
public struct PhoneCounts: Codable, Sendable, Hashable {
    public var hibernating: Int
    public var den: Int

    public init(hibernating: Int, den: Int) {
        self.hibernating = hibernating
        self.den = den
    }

    private enum Keys: String, CodingKey { case hibernating, den }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        hibernating = (try? c.decodeIfPresent(Double.self, forKey: .hibernating)).flatMap { $0 }?.wholeCount() ?? 0
        den = (try? c.decodeIfPresent(Double.self, forKey: .den)).flatMap { $0 }?.wholeCount() ?? 0
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: Keys.self)
        try c.encode(hibernating, forKey: .hibernating)
        try c.encode(den, forKey: .den)
    }
}

public enum ThreadsView: String, Sendable, CaseIterable {
    case inbox, hibernating, den
}

/// How a thread went, picked when archiving it from the done card (backend
/// API 42), so later sweeps know it was archived on purpose and how it went.
public enum ArchiveVerdict: String, Sendable, Hashable, CaseIterable {
    case worked, didntWork, notNeeded
}

public enum ThreadChange: Sendable, Hashable {
    case snooze(until: Date)
    case snoozeUntilRestart
    case wake
    case archive
    /// Archive with a verdict: only for a backend of
    /// `BackendCompatibility.archiveVerdictAPIVersion` or later.
    case archiveWithVerdict(ArchiveVerdict)
    case unarchive
    case markSeen
    case rename(String)
    case star(Bool)

    var json: JSONValue {
        switch self {
        case let .snooze(until): ["snooze": ["until": .string(ISODate.string(until))]]
        case .snoozeUntilRestart: ["snooze": ["untilRestart": true]]
        case .wake: ["wake": true]
        case .archive: ["archive": true]
        case let .archiveWithVerdict(verdict): ["archive": true, "verdict": .string(verdict.rawValue)]
        case .unarchive: ["unarchive": true]
        case .markSeen: ["markSeen": true]
        case let .rename(title): ["title": .string(title)]
        case let .star(on): ["star": .bool(on)]
        }
    }
}
