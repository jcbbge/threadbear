import Foundation

// Types from docs/protocol.md. Decoding is deliberately forgiving: unknown
// fields are ignored and missing optional fields fall back to defaults, so
// the app keeps working when the runner is upgraded first.

public struct Account: Sendable, Hashable, Codable, Identifiable {
    public var id: String
    /// "claude" or "codex"; kept as a string so a provider this app doesn't
    /// know yet still shows.
    public var provider: String
    /// Codex titles start "Codex · ", so apps that only show this can tell
    /// a Codex login from a Claude one with the same address.
    public var title: String
    public var configDir: String
    /// The full id a thread with no model runs on, once the runner knows
    /// (the account's settings, corrected by the first turn seen).
    public var defaultModel: String?
    /// The CLI's model picker, in its order, once the runner has asked it.
    public var models: [ModelChoice]
    /// The account's own effort level; nil is each model's own.
    public var defaultEffort: String?
    /// The bare address, to build labels from with `provider`.
    public var email: String?
    /// "Max", "Team", "Pro Lite".
    public var plan: String?
    /// Mike's note for the account ("Convex work only").
    public var note: String?
    /// Nil when nothing is known, and always from runners older than step 4.
    public var usage: AccountUsage?

    public init(
        id: String, provider: String = "claude", title: String, configDir: String = "", defaultModel: String? = nil, models: [ModelChoice] = [],
        defaultEffort: String? = nil, email: String? = nil, plan: String? = nil, note: String? = nil, usage: AccountUsage? = nil
    ) {
        self.id = id
        self.provider = provider
        self.title = title
        self.configDir = configDir
        self.defaultModel = defaultModel
        self.models = models
        self.defaultEffort = defaultEffort
        self.email = email
        self.plan = plan
        self.note = note
        self.usage = usage
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        provider = (try? c.decodeIfPresent(String.self, forKey: .provider)) ?? "claude"
        title = (try? c.decodeIfPresent(String.self, forKey: .title)) ?? id
        configDir = (try? c.decodeIfPresent(String.self, forKey: .configDir)) ?? ""
        defaultModel = try? c.decodeIfPresent(String.self, forKey: .defaultModel)
        models = c.lossyArray(ModelChoice.self, forKey: .models)
        defaultEffort = try? c.decodeIfPresent(String.self, forKey: .defaultEffort)
        email = try? c.decodeIfPresent(String.self, forKey: .email)
        plan = try? c.decodeIfPresent(String.self, forKey: .plan)
        note = try? c.decodeIfPresent(String.self, forKey: .note)
        // A usage block this app can't read leaves the account without one
        // rather than dropping the account.
        usage = try? c.decodeIfPresent(AccountUsage.self, forKey: .usage)
    }
}

/// How much room an account has left, from Token Stats' file or the
/// account's own turns.
public struct AccountUsage: Sendable, Hashable, Codable {
    public var windows: [UsageWindow]
    /// When the newest reading in it was taken.
    public var readAt: Date?
    /// "tokenStats", "live", or "shared" (another runner's reading of the same login was the newest).
    public var source: String
    /// Token Stats has gone quiet and there's no live reading since.
    public var stale: Bool
    /// The provider says this login is at its limit.
    public var blocked: Bool
    /// Token Stats' own note ("64,390 credits · 2 limit resets available").
    public var notice: String?

    public init(windows: [UsageWindow], readAt: Date? = nil, source: String = "tokenStats", stale: Bool = false, blocked: Bool = false, notice: String? = nil) {
        self.windows = windows
        self.readAt = readAt
        self.source = source
        self.stale = stale
        self.blocked = blocked
        self.notice = notice
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        windows = c.lossyArray(UsageWindow.self, forKey: .windows)
        readAt = ((try? c.decodeIfPresent(String.self, forKey: .readAt)) ?? nil).flatMap(ISO8601.parse)
        source = (try? c.decodeIfPresent(String.self, forKey: .source)) ?? "tokenStats"
        stale = (try? c.decodeIfPresent(Bool.self, forKey: .stale)) ?? false
        blocked = (try? c.decodeIfPresent(Bool.self, forKey: .blocked)) ?? false
        notice = try? c.decodeIfPresent(String.self, forKey: .notice)
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(windows, forKey: .windows)
        try c.encodeIfPresent(readAt.map(ISO8601.format), forKey: .readAt)
        try c.encode(source, forKey: .source)
        if stale { try c.encode(stale, forKey: .stale) }
        if blocked { try c.encode(blocked, forKey: .blocked) }
        try c.encodeIfPresent(notice, forKey: .notice)
    }

    enum CodingKeys: String, CodingKey { case windows, readAt, source, stale, blocked, notice }
}

/// One limit: "5-hour 89% left, resets at 1 pm".
public struct UsageWindow: Sendable, Hashable, Codable {
    /// "five_hour", "weekly", "weekly_model", "daily", "monthly",
    /// "allowance" or "other"; a string so new kinds still show by title.
    public var kind: String
    public var title: String
    /// 0 to 100, may be fractional.
    public var remainingPercent: Double
    public var resetsAt: Date?
    /// "$132.79 left".
    public var detail: String?

    public init(kind: String, title: String, remainingPercent: Double, resetsAt: Date? = nil, detail: String? = nil) {
        self.kind = kind
        self.title = title
        self.remainingPercent = remainingPercent
        self.resetsAt = resetsAt
        self.detail = detail
    }

    /// A window with no percentage can't be shown, so it fails and the
    /// lossy array skips it.
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        remainingPercent = min(100, max(0, try c.decode(Double.self, forKey: .remainingPercent)))
        kind = (try? c.decodeIfPresent(String.self, forKey: .kind)) ?? "other"
        title = (try? c.decodeIfPresent(String.self, forKey: .title)) ?? kind
        resetsAt = ((try? c.decodeIfPresent(String.self, forKey: .resetsAt)) ?? nil).flatMap(ISO8601.parse)
        detail = try? c.decodeIfPresent(String.self, forKey: .detail)
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(kind, forKey: .kind)
        try c.encode(title, forKey: .title)
        try c.encode(remainingPercent, forKey: .remainingPercent)
        try c.encodeIfPresent(resetsAt.map(ISO8601.format), forKey: .resetsAt)
        try c.encodeIfPresent(detail, forKey: .detail)
    }

    enum CodingKeys: String, CodingKey { case kind, title, remainingPercent, resetsAt, detail }
}

/// What the runner knows about one CLI: the version new sessions start,
/// the latest one, and any update going on (`clis.list`, `clis.updated`).
public struct CliStatus: Sendable, Hashable, Decodable, Identifiable {
    public struct InUse: Sendable, Hashable, Decodable {
        public var version: String
        public var threadIds: [String]

        public init(version: String, threadIds: [String] = []) {
            self.version = version
            self.threadIds = threadIds
        }

        public init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            version = try c.decode(String.self, forKey: .version)
            threadIds = (try? c.decodeIfPresent([String].self, forKey: .threadIds)) ?? []
        }

        enum CodingKeys: String, CodingKey { case version, threadIds }
    }

    /// Why an update wasn't installed by itself.
    public struct Hold: Sendable, Hashable, Decodable {
        public var version: String
        public var reason: String
        public var missing: [String]

        public init(version: String, reason: String, missing: [String] = []) {
            self.version = version
            self.reason = reason
            self.missing = missing
        }

        public init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            version = (try? c.decodeIfPresent(String.self, forKey: .version)) ?? ""
            reason = (try? c.decodeIfPresent(String.self, forKey: .reason)) ?? ""
            missing = (try? c.decodeIfPresent([String].self, forKey: .missing)) ?? []
        }

        enum CodingKeys: String, CodingKey { case version, reason, missing }
    }

    public struct Update: Sendable, Hashable, Decodable {
        /// "waiting", "running", "succeeded", "unchanged" or "failed".
        public var state: String
        public var targetVersion: String?
        public var waitingFor: [String]
        public var finishedAt: Date?
        public var message: String?

        public init(state: String, targetVersion: String? = nil, waitingFor: [String] = [], finishedAt: Date? = nil, message: String? = nil) {
            self.state = state
            self.targetVersion = targetVersion
            self.waitingFor = waitingFor
            self.finishedAt = finishedAt
            self.message = message
        }

        public init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            state = (try? c.decodeIfPresent(String.self, forKey: .state)) ?? "unknown"
            targetVersion = try? c.decodeIfPresent(String.self, forKey: .targetVersion)
            waitingFor = (try? c.decodeIfPresent([String].self, forKey: .waitingFor)) ?? []
            finishedAt = ((try? c.decodeIfPresent(String.self, forKey: .finishedAt)) ?? nil).flatMap(ISO8601.parse)
            message = try? c.decodeIfPresent(String.self, forKey: .message)
        }

        enum CodingKeys: String, CodingKey { case state, targetVersion, waitingFor, finishedAt, message }
    }

    public var id: String { provider }
    public var provider: String
    /// The binary new sessions start.
    public var path: String
    /// "threadbear" (Codex's own copies), "cli" (Claude's installer) or
    /// "none" (a path set by hand, never updated).
    public var managedBy: String
    public var installedVersion: String?
    public var latestVersion: String?
    /// "current", "behind", "held", "unknown" or "missing".
    public var status: String
    /// "auto", "notify" or "off".
    public var policy: String
    public var inUse: [InUse]
    /// Codex: the kept version "Go back" returns to.
    public var previousVersion: String?
    public var checkedAt: Date?
    public var hold: Hold?
    public var update: Update?

    public init(
        provider: String, path: String = "", managedBy: String = "cli", installedVersion: String? = nil, latestVersion: String? = nil,
        status: String = "unknown", policy: String = "auto", inUse: [InUse] = [], previousVersion: String? = nil,
        checkedAt: Date? = nil, hold: Hold? = nil, update: Update? = nil
    ) {
        self.provider = provider
        self.path = path
        self.managedBy = managedBy
        self.installedVersion = installedVersion
        self.latestVersion = latestVersion
        self.status = status
        self.policy = policy
        self.inUse = inUse
        self.previousVersion = previousVersion
        self.checkedAt = checkedAt
        self.hold = hold
        self.update = update
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        provider = try c.decode(String.self, forKey: .provider)
        path = (try? c.decodeIfPresent(String.self, forKey: .path)) ?? ""
        managedBy = (try? c.decodeIfPresent(String.self, forKey: .managedBy)) ?? "cli"
        installedVersion = try? c.decodeIfPresent(String.self, forKey: .installedVersion)
        latestVersion = try? c.decodeIfPresent(String.self, forKey: .latestVersion)
        status = (try? c.decodeIfPresent(String.self, forKey: .status)) ?? "unknown"
        policy = (try? c.decodeIfPresent(String.self, forKey: .policy)) ?? "auto"
        inUse = c.lossyArray(InUse.self, forKey: .inUse)
        previousVersion = try? c.decodeIfPresent(String.self, forKey: .previousVersion)
        checkedAt = ((try? c.decodeIfPresent(String.self, forKey: .checkedAt)) ?? nil).flatMap(ISO8601.parse)
        hold = try? c.decodeIfPresent(Hold.self, forKey: .hold)
        update = try? c.decodeIfPresent(Update.self, forKey: .update)
    }

    enum CodingKeys: String, CodingKey {
        case provider, path, managedBy, installedVersion, latestVersion, status, policy, inUse, previousVersion, checkedAt, hold, update
    }
}

/// One row of a CLI's model picker: `id` is what a thread's model is set
/// to, `model` the full id it runs as.
public struct ModelChoice: Sendable, Hashable, Codable, Identifiable {
    public var id: String
    public var model: String
    public var title: String
    public var description: String?
    /// Empty when the model takes no effort level.
    public var effortLevels: [String]
    /// The model's own level, when the CLI says (Codex).
    public var defaultEffort: String?

    public init(id: String, model: String, title: String, description: String? = nil, effortLevels: [String] = [], defaultEffort: String? = nil) {
        self.id = id
        self.model = model
        self.title = title
        self.description = description
        self.effortLevels = effortLevels
        self.defaultEffort = defaultEffort
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        model = try c.decodeIfPresent(String.self, forKey: .model) ?? id
        title = try c.decodeIfPresent(String.self, forKey: .title) ?? id
        description = try c.decodeIfPresent(String.self, forKey: .description)
        effortLevels = try c.decodeIfPresent([String].self, forKey: .effortLevels) ?? []
        defaultEffort = try? c.decodeIfPresent(String.self, forKey: .defaultEffort)
    }
}

public enum ThreadStatus: String, Sendable, Hashable, Codable {
    case idle, starting, running, waiting, error, stopped

    public init(from decoder: Decoder) throws {
        let raw = try decoder.singleValueContainer().decode(String.self)
        self = ThreadStatus(rawValue: raw) ?? .idle
    }

    /// A turn is underway (or about to be).
    public var isBusy: Bool { self == .running || self == .starting || self == .waiting }
}

public enum PermissionMode: String, Sendable, Hashable, Codable {
    /// plan is "Plan first": the agent reads and plans but changes nothing
    /// until Mike approves its plan (docs/protocol.md, "Plan first").
    case full, ask, auto, plan

    public init(from decoder: Decoder) throws {
        let raw = try decoder.singleValueContainer().decode(String.self)
        self = PermissionMode(rawValue: raw) ?? .full
    }
}

public struct ImageRef: Sendable, Hashable, Codable {
    public var path: String
    public var mediaType: String
    public var width: Int?
    public var height: Int?

    public init(path: String, mediaType: String, width: Int? = nil, height: Int? = nil) {
        self.path = path
        self.mediaType = mediaType
        self.width = width
        self.height = height
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        path = try c.decode(String.self, forKey: .path)
        mediaType = try c.decodeIfPresent(String.self, forKey: .mediaType) ?? "image/png"
        // Never Int(_:) of a number off the wire, which traps on 1e100.
        width = try c.decodeIfPresent(Double.self, forKey: .width).flatMap { $0.wholeCount(atMost: 1_000_000) }
        height = try c.decodeIfPresent(Double.self, forKey: .height).flatMap { $0.wholeCount(atMost: 1_000_000) }
    }
}

/// A panel a patch gives a thread: a page, a picture or a list of rows
/// shown beside the transcript (docs/protocol.md, "Patches"). The runner
/// works them out from the thread's folders.
public struct Panel: Sendable, Hashable, Codable, Identifiable {
    public enum Kind: String, Sendable, Hashable, Codable {
        /// `list`: rows the runner gets from the patch on request
        /// (`panels.render`), drawn natively.
        case url, image, list

        /// An unknown kind is shown as a page if it has a url, the one thing
        /// every panel can be.
        public init(from decoder: Decoder) throws {
            let raw = try decoder.singleValueContainer().decode(String.self)
            self = Kind(rawValue: raw) ?? .url
        }
    }

    public var id: String
    public var title: String
    public var kind: Kind
    /// What a `url` panel shows, and what Open in browser opens.
    public var url: String?
    /// An SF Symbol for its button on the right-hand rail; nil leaves it to
    /// the app (PanelIcon).
    public var icon: String?
    /// A picture in place of the symbol, drawn in full colour: an image or
    /// a .app (its icon), as an absolute path. A tool's own icon.
    public var iconFile: String?
    /// The patch it came from: "convex", "xcode".
    public var patch: String
    /// One line about it: the deployment, the project.
    public var note: String?
    /// The project whose folder gave it, when it came from one rather than
    /// the thread's own folder.
    public var projectId: String?
    /// A count on its rail button from the patch's live state ("14 edits
    /// waiting for review"); nil for none.
    public var badge: Int?
    /// A line or few from the patch's summary function, for the panel's
    /// card at the top of Highlights ("16 edits waiting for your review").
    public var summary: String?
    /// The Convex panel's cloud deployment: the app shows Convex's embedded
    /// dashboard for it, with a deploy key from `panels.convexKey`, rather
    /// than `url`, which wants a Convex login.
    public var convex: ConvexDeployment?

    public init(id: String, title: String, kind: Kind = .url, url: String? = nil, icon: String? = nil, patch: String = "", note: String? = nil, projectId: String? = nil, badge: Int? = nil, convex: ConvexDeployment? = nil) {
        self.id = id
        self.title = title
        self.kind = kind
        self.url = url
        self.icon = icon
        self.patch = patch
        self.note = note
        self.projectId = projectId
        self.badge = badge
        self.convex = convex
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        title = try c.decodeIfPresent(String.self, forKey: .title) ?? id
        kind = try c.decodeIfPresent(Kind.self, forKey: .kind) ?? .url
        url = try c.decodeIfPresent(String.self, forKey: .url)
        icon = (try? c.decodeIfPresent(String.self, forKey: .icon)) ?? nil
        iconFile = (try? c.decodeIfPresent(String.self, forKey: .iconFile)) ?? nil
        patch = try c.decodeIfPresent(String.self, forKey: .patch) ?? ""
        note = try c.decodeIfPresent(String.self, forKey: .note)
        projectId = (try? c.decodeIfPresent(String.self, forKey: .projectId)) ?? nil
        badge = (try? c.decodeIfPresent(Int.self, forKey: .badge)) ?? nil
        summary = (try? c.decodeIfPresent(String.self, forKey: .summary)) ?? nil
        convex = (try? c.decodeIfPresent(ConvexDeployment.self, forKey: .convex)) ?? nil
    }

    /// The page as a URL, when it is one.
    public var pageURL: URL? { url.flatMap(URL.init(string:)) }
}

/// A Convex cloud deployment a panel shows (docs/protocol.md, "The Convex
/// panel").
public struct ConvexDeployment: Sendable, Hashable, Codable {
    public var deployment: String
    public var deploymentUrl: String
    /// The Convex team and project, when `convex dev` noted them in .env.local.
    public var team: String?
    public var project: String?

    public init(deployment: String, deploymentUrl: String, team: String? = nil, project: String? = nil) {
        self.deployment = deployment
        self.deploymentUrl = deploymentUrl
        self.team = team
        self.project = project
    }
}

public struct ConvexDeploymentChoice: Sendable, Hashable, Codable {
    public var deployment: String
    public var deploymentUrl: String
    public var label: String

    public init(deployment: String, deploymentUrl: String, label: String) {
        self.deployment = deployment
        self.deploymentUrl = deploymentUrl
        self.label = label
    }
}

public struct ConvexDeployments: Sendable, Decodable {
    public var deployments: [ConvexDeploymentChoice]
    public var note: String?
}

/// `panels.convexLogin`'s answer: a sign-in to Convex on the runner's CLI.
/// `url` is the page to approve it on, `code` what that page shows.
public struct ConvexLogin: Sendable, Equatable, Decodable {
    public var state: String // idle, waiting, done, failed
    public var url: String?
    public var code: String?
    public var message: String?

    public init(state: String, url: String? = nil, code: String? = nil, message: String? = nil) {
        self.state = state
        self.url = url
        self.code = code
        self.message = message
    }
}

public extension ConvexLogin {
    /// The page to open: only ever Convex's own device sign-in
    /// (LinkPolicy.convexSignIn). The runner may be another Mac's, and its
    /// answer is opened on this one, so a `file:` URL or another site from
    /// it must never reach the browser or another app (Daybreak, 7 Nov).
    var page: URL? { LinkPolicy.convexSignIn(url) }

    /// Why the sign-in stops: a page that isn't Convex's, from the first
    /// answer or any later one. Nil when there's no page or it's fine.
    var refusedPage: String? {
        guard url != nil, page == nil else { return nil }
        return "The runner's sign-in page isn't Convex's (\(LinkPolicy.convexSignInHost)), so Threadbear didn't open it. Run npx convex login on that Mac instead."
    }
}

/// `panels.convexKey`'s answer. The key is admin of its deployment, so its
/// description leaves it out, in case one ever lands in a log line.
public struct ConvexPanelKey: Sendable, Hashable, Decodable, CustomStringConvertible {
    public var deployment: String
    public var deploymentUrl: String
    public var adminKey: String

    public init(deployment: String, deploymentUrl: String, adminKey: String) {
        self.deployment = deployment
        self.deploymentUrl = deploymentUrl
        self.adminKey = adminKey
    }

    public var description: String { "ConvexPanelKey(\(deployment))" }
}

/// An action a patch gives a thread: a chip above the composer that runs
/// a command in the thread's folder, sends a canned prompt, or opens a web
/// page in the browser here (no RPC, nothing in the transcript).
public struct Action: Sendable, Hashable, Codable, Identifiable {
    public enum Kind: String, Sendable, Hashable, Codable {
        case command, prompt, url

        public init(from decoder: Decoder) throws {
            let raw = try decoder.singleValueContainer().decode(String.self)
            self = Kind(rawValue: raw) ?? .command
        }
    }

    public var id: String
    public var title: String
    public var kind: Kind
    public var command: String?
    public var prompt: String?
    /// Kind url: the http or https page it opens.
    public var url: String?
    public var patch: String
    public var note: String?
    /// Where the command runs: the project folder the patch came from. Nil
    /// for the thread's own folder.
    public var folder: String?
    public var projectId: String?
    /// A count on the chip from the patch's live state ("3 comments");
    /// nil for none.
    public var badge: Int?
    /// An SF Symbol for the chip, from the action or its patch file; nil
    /// for the default glyph.
    public var icon: String?
    /// Or a picture for it, as Panel's.
    public var iconFile: String?

    public init(id: String, title: String, kind: Kind = .command, command: String? = nil, prompt: String? = nil, url: String? = nil, patch: String = "", note: String? = nil,
                folder: String? = nil, projectId: String? = nil, badge: Int? = nil, icon: String? = nil) {
        self.url = url
        self.badge = badge
        self.icon = icon
        self.id = id
        self.title = title
        self.kind = kind
        self.command = command
        self.prompt = prompt
        self.patch = patch
        self.note = note
        self.folder = folder
        self.projectId = projectId
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        title = try c.decodeIfPresent(String.self, forKey: .title) ?? id
        kind = try c.decodeIfPresent(Kind.self, forKey: .kind) ?? .command
        command = try c.decodeIfPresent(String.self, forKey: .command)
        prompt = try c.decodeIfPresent(String.self, forKey: .prompt)
        url = (try? c.decodeIfPresent(String.self, forKey: .url)) ?? nil
        patch = try c.decodeIfPresent(String.self, forKey: .patch) ?? ""
        note = try c.decodeIfPresent(String.self, forKey: .note)
        folder = (try? c.decodeIfPresent(String.self, forKey: .folder)) ?? nil
        projectId = (try? c.decodeIfPresent(String.self, forKey: .projectId)) ?? nil
        badge = (try? c.decodeIfPresent(Int.self, forKey: .badge)) ?? nil
        icon = (try? c.decodeIfPresent(String.self, forKey: .icon)) ?? nil
        iconFile = (try? c.decodeIfPresent(String.self, forKey: .iconFile)) ?? nil
    }

    /// The page a url action opens: only http or https, checked here as
    /// well as by the runner, so a chip can never open a file or an app.
    public var webPage: URL? {
        guard kind == .url, let url, let page = URL(string: url),
              let scheme = page.scheme?.lowercased(), scheme == "http" || scheme == "https",
              page.host?.isEmpty == false else { return nil }
        return page
    }
}

/// A hook a patch gives a thread: a command the runner runs by itself
/// after a turn, posted into the transcript like an action.
public struct Hook: Sendable, Hashable, Codable, Identifiable {
    public var id: String
    public var title: String
    public var on: String
    public var command: String
    public var edited: String?
    public var tell: String
    public var patch: String
    public var note: String?
    /// As Action's: a hook from a project folder runs there and only sees
    /// edits inside it.
    public var folder: String?
    public var projectId: String?

    public init(id: String, title: String, on: String = "turn.end", command: String = "", edited: String? = nil, tell: String = "failures", patch: String = "", note: String? = nil,
                folder: String? = nil, projectId: String? = nil) {
        self.id = id
        self.title = title
        self.on = on
        self.command = command
        self.edited = edited
        self.tell = tell
        self.patch = patch
        self.note = note
        self.folder = folder
        self.projectId = projectId
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        title = try c.decodeIfPresent(String.self, forKey: .title) ?? id
        on = try c.decodeIfPresent(String.self, forKey: .on) ?? "turn.end"
        command = try c.decodeIfPresent(String.self, forKey: .command) ?? ""
        edited = try c.decodeIfPresent(String.self, forKey: .edited)
        tell = try c.decodeIfPresent(String.self, forKey: .tell) ?? "failures"
        patch = try c.decodeIfPresent(String.self, forKey: .patch) ?? ""
        note = try c.decodeIfPresent(String.self, forKey: .note)
        folder = (try? c.decodeIfPresent(String.self, forKey: .folder)) ?? nil
        projectId = (try? c.decodeIfPresent(String.self, forKey: .projectId)) ?? nil
    }
}

/// A patch that applies to a thread's folder: built in, from
/// `~/.threadbear/patches`, or the project's own.
public struct PatchInfo: Sendable, Hashable, Codable, Identifiable {
    public var id: String
    public var source: String
    public var file: String?
    public var error: String?
    /// The folder it applies from: the one holding `.threadbear/`, or a
    /// built-in's project folder.
    public var folder: String?
    /// Set when it came from one of the thread's projects' folders rather
    /// than its own.
    public var projectId: String?
    /// A tool patch (`appliesTo`): the paths that made it apply, like the
    /// video's .tandem file.
    public var matched: [String]?
    /// A `when` or `badge` function that threw or took too long.
    public var liveError: String?
    /// The patch file's icon: a symbol, or a picture (as Panel's).
    public var icon: String?
    public var iconFile: String?
    /// A project's patch file that isn't trusted yet, so it wasn't loaded:
    /// "new" (nothing from its folder is trusted) or "changed" (an earlier
    /// version was). `hash` is the version `patches.trust` would trust.
    public var untrusted: String?
    public var hash: String?
    /// With `untrusted`: the local files it imports, which the hash covers
    /// too, so Patches can say what else trusting it would run.
    public var helpers: [String]?
    /// With `untrusted`, a folder's Claude Code settings in a thread that
    /// asks before tools run: what they'd let run without asking, in words.
    public var grants: [String]?

    public init(id: String, source: String = "project", file: String? = nil, error: String? = nil, folder: String? = nil, projectId: String? = nil,
                matched: [String]? = nil, liveError: String? = nil, untrusted: String? = nil, hash: String? = nil, helpers: [String]? = nil, grants: [String]? = nil) {
        self.untrusted = untrusted
        self.hash = hash
        self.helpers = helpers
        self.grants = grants
        self.matched = matched
        self.liveError = liveError
        self.id = id
        self.source = source
        self.file = file
        self.error = error
        self.folder = folder
        self.projectId = projectId
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        source = try c.decodeIfPresent(String.self, forKey: .source) ?? "project"
        file = try c.decodeIfPresent(String.self, forKey: .file)
        error = try c.decodeIfPresent(String.self, forKey: .error)
        folder = (try? c.decodeIfPresent(String.self, forKey: .folder)) ?? nil
        projectId = (try? c.decodeIfPresent(String.self, forKey: .projectId)) ?? nil
        matched = (try? c.decodeIfPresent([String].self, forKey: .matched)) ?? nil
        liveError = (try? c.decodeIfPresent(String.self, forKey: .liveError)) ?? nil
        icon = (try? c.decodeIfPresent(String.self, forKey: .icon)) ?? nil
        iconFile = (try? c.decodeIfPresent(String.self, forKey: .iconFile)) ?? nil
        untrusted = (try? c.decodeIfPresent(String.self, forKey: .untrusted)) ?? nil
        hash = (try? c.decodeIfPresent(String.self, forKey: .hash)) ?? nil
        helpers = (try? c.decodeIfPresent([String].self, forKey: .helpers)) ?? nil
        grants = (try? c.decodeIfPresent([String].self, forKey: .grants)) ?? nil
    }
}

/// What `actions.run` gives back: the turn a prompt action started, or how
/// a command action went (its output is in the transcript at `seq`).
public struct ActionRunResult: Sendable, Hashable, Decodable {
    public var turnId: String?
    public var ok: Bool?
    public var exitCode: Int?
    public var durationMs: Double?
    public var seq: Int?
}

/// What `panels.render` gives back: an image panel's picture or a list
/// panel's rows, or a note saying why there aren't any.
public struct PanelRender: Sendable, Hashable, Decodable {
    public var image: ImageRef?
    /// A list panel's rows; nil from an image panel (or an older runner).
    public var items: [PanelItem]?
    public var note: String?

    public init(image: ImageRef? = nil, items: [PanelItem]? = nil, note: String? = nil) {
        self.image = image
        self.items = items
        self.note = note
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        image = (try? c.decodeIfPresent(ImageRef.self, forKey: .image)) ?? nil
        items = c.contains(.items) ? c.lossyArray(PanelItem.self, forKey: .items) : nil
        note = (try? c.decodeIfPresent(String.self, forKey: .note)) ?? nil
    }

    enum CodingKeys: String, CodingKey { case image, items, note }
}

/// A sub-agent the thread's agent started (Claude's Agent tool), foreground
/// or background. The runner follows it from the CLI's task events, so its
/// status and activity change while it runs; `threads.subagent` reads what
/// it did.
public struct Subagent: Sendable, Hashable, Codable, Identifiable {
    public enum Status: String, Sendable, Hashable, Codable {
        case running, completed, failed, stopped

        /// A status this app doesn't know is shown as stopped.
        public init(from decoder: Decoder) throws {
            let raw = try decoder.singleValueContainer().decode(String.self)
            self = Status(rawValue: raw) ?? .stopped
        }
    }

    public var id: String
    /// The tool.call in the thread that started it.
    public var itemId: String?
    /// The sub-agent that started this one, when a sub-agent did.
    public var parentId: String?
    public var description: String
    /// "general-purpose", "Explore", "fork".
    public var agentType: String?
    public var status: Status
    public var background: Bool
    /// While running: what it's doing, in the CLI's words.
    public var activity: String?
    /// Once finished: what it reported, one line.
    public var summary: String?
    public var toolUses: Int?
    public var startedAt: Date
    public var endedAt: Date?

    public init(
        id: String, itemId: String? = nil, parentId: String? = nil, description: String, agentType: String? = nil,
        status: Status = .running, background: Bool = false, activity: String? = nil, summary: String? = nil,
        toolUses: Int? = nil, startedAt: Date = Date(), endedAt: Date? = nil
    ) {
        self.id = id
        self.itemId = itemId
        self.parentId = parentId
        self.description = description
        self.agentType = agentType
        self.status = status
        self.background = background
        self.activity = activity
        self.summary = summary
        self.toolUses = toolUses
        self.startedAt = startedAt
        self.endedAt = endedAt
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        itemId = try c.decodeIfPresent(String.self, forKey: .itemId)
        parentId = try c.decodeIfPresent(String.self, forKey: .parentId)
        description = try c.decodeIfPresent(String.self, forKey: .description) ?? ""
        agentType = try c.decodeIfPresent(String.self, forKey: .agentType)
        status = try c.decodeIfPresent(Status.self, forKey: .status) ?? .stopped
        background = try c.decodeIfPresent(Bool.self, forKey: .background) ?? false
        activity = try c.decodeIfPresent(String.self, forKey: .activity)
        summary = try c.decodeIfPresent(String.self, forKey: .summary)
        toolUses = try c.decodeIfPresent(Double.self, forKey: .toolUses).flatMap { $0.wholeCount() }
        startedAt = try c.decodeIfPresent(String.self, forKey: .startedAt).flatMap(ISO8601.parse) ?? Date(timeIntervalSince1970: 0)
        endedAt = try c.decodeIfPresent(String.self, forKey: .endedAt).flatMap(ISO8601.parse)
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(id, forKey: .id)
        try c.encodeIfPresent(itemId, forKey: .itemId)
        try c.encodeIfPresent(parentId, forKey: .parentId)
        try c.encode(description, forKey: .description)
        try c.encodeIfPresent(agentType, forKey: .agentType)
        try c.encode(status, forKey: .status)
        try c.encode(background, forKey: .background)
        try c.encodeIfPresent(activity, forKey: .activity)
        try c.encodeIfPresent(summary, forKey: .summary)
        try c.encodeIfPresent(toolUses, forKey: .toolUses)
        try c.encode(ISO8601.format(startedAt), forKey: .startedAt)
        try c.encodeIfPresent(endedAt.map(ISO8601.format), forKey: .endedAt)
    }

    enum CodingKeys: String, CodingKey {
        case id, itemId, parentId, description, agentType, status, background, activity, summary, toolUses, startedAt, endedAt
    }

    public var isRunning: Bool { status == .running }
}

/// What `threads.subagent` returns: the sub-agent as the thread's list has
/// it (nil once the list has dropped it) and what it has done, as events.
public struct SubagentTranscript: Sendable, Decodable {
    public var subagent: Subagent?
    public var events: [Event]

    public init(subagent: Subagent?, events: [Event]) {
        self.subagent = subagent
        self.events = events
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        subagent = try? c.decodeIfPresent(Subagent.self, forKey: .subagent)
        events = c.lossyArray(Event.self, forKey: .events)
    }

    enum CodingKeys: String, CodingKey {
        case subagent, events
    }
}

/// Work the live CLI is still running in the background: a sub-agent or a
/// shell job started with run_in_background, a Monitor. `finished` once it
/// has ended and the agent is about to start a turn to read its result.
public struct BackgroundTask: Sendable, Hashable, Codable {
    public enum Kind: String, Sendable, Hashable, Codable {
        case agent, shell, monitor, other

        public init(from decoder: Decoder) throws {
            let raw = try decoder.singleValueContainer().decode(String.self)
            self = Kind(rawValue: raw) ?? .other
        }
    }

    public var kind: Kind
    /// The CLI's own words: the sub-agent's brief, the command. May be empty.
    public var description: String
    public var finished: Bool

    public init(kind: Kind, description: String, finished: Bool = false) {
        self.kind = kind
        self.description = description
        self.finished = finished
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        kind = try c.decodeIfPresent(Kind.self, forKey: .kind) ?? .other
        description = try c.decodeIfPresent(String.self, forKey: .description) ?? ""
        finished = try c.decodeIfPresent(Bool.self, forKey: .finished) ?? false
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(kind, forKey: .kind)
        try c.encode(description, forKey: .description)
        if finished { try c.encode(true, forKey: .finished) }
    }

    enum CodingKeys: String, CodingKey {
        case kind, description, finished
    }
}

/// A thread's own git worktree (protocol "Worktrees"): it works on its own
/// branch, and `tb land` puts that on main in the main checkout.
public struct ThreadWorktree: Sendable, Hashable, Codable {
    public var branch: String
    public var mainCheckout: String
    public var path: String

    public init(branch: String, mainCheckout: String = "", path: String = "") {
        self.branch = branch
        self.mainCheckout = mainCheckout
        self.path = path
    }

    // Lenient: only the branch is needed to show it.
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        branch = try c.decode(String.self, forKey: .branch)
        mainCheckout = (try? c.decodeIfPresent(String.self, forKey: .mainCheckout)) ?? ""
        path = (try? c.decodeIfPresent(String.self, forKey: .path)) ?? ""
    }
}

/// Who started a thread, when it wasn't Mike (protocol "Who started a thread").
public struct ThreadStartedBy: Sendable, Hashable, Codable {
    /// "tool", "thread", "schedule", "librarian" or "runner"; a kind from a
    /// newer runner reads as a tool.
    public var kind: String
    public var label: String
    /// An SF Symbol a tool asked for.
    public var icon: String?
    public var threadId: String?
    public var threadTitle: String?
    /// A few words: why it was started, then how it came out.
    public var why: String?

    public init(kind: String, label: String, icon: String? = nil, threadId: String? = nil, threadTitle: String? = nil, why: String? = nil) {
        self.kind = kind
        self.label = label
        self.icon = icon
        self.threadId = threadId
        self.threadTitle = threadTitle
        self.why = why
    }
}

/// The schedule that started a thread (protocol "Schedules"), with its
/// title as it was then: the schedule may since be renamed or deleted.
public struct ThreadSchedule: Sendable, Hashable, Codable {
    public var id: String
    public var title: String

    public init(id: String, title: String) {
        self.id = id
        self.title = title
    }
}

/// A panel the thread's agent asked to show Mike (show_panel), waiting on
/// the thread until he's looking at it (docs/protocol.md, "Showing
/// panels").
public struct PanelRequest: Sendable, Hashable, Codable {
    public var id: String
    /// "highlights", "patches", "usage", "updates", or one of the thread's
    /// panels' ids.
    public var panel: String
    public var title: String
    /// Where a closed one opens: "tab", "left", "right", "top", "bottom" or
    /// "window". Nil for its usual place.
    public var `where`: String?
    public var at: String

    public init(id: String, panel: String, title: String, where: String? = nil, at: String = "") {
        self.id = id
        self.panel = panel
        self.title = title
        self.where = `where`
        self.at = at
    }
}

/// What's still open on a thread's done card, as its runner checked it
/// (protocol "Loose ends", experiment looseEnds): `seq` is the card's
/// turn.completed, and no ends means it checked and nothing's left.
public struct LooseEnds: Sendable, Hashable, Codable {
    public var seq: Int
    public var ends: [LooseEnd]

    public init(seq: Int, ends: [LooseEnd]) {
        self.seq = seq
        self.ends = ends
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        guard let seq = c.lenientInt(forKey: .seq) else {
            throw DecodingError.dataCorruptedError(forKey: .seq, in: c, debugDescription: "No seq")
        }
        self.seq = seq
        ends = c.lossyArray(LooseEnd.self, forKey: .ends)
    }

    enum CodingKeys: String, CodingKey { case seq, ends }

    /// Any that should stop a plain Archive: a booked check-in doesn't, as
    /// the thread comes back when it runs.
    public var anyOpen: Bool { ends.contains { !$0.isBooked } }
}

public struct LooseEnd: Sendable, Hashable, Codable {
    /// unlanded, uncommitted, thread or scheduled; a later kind shows as its text.
    public var kind: String
    public var text: String
    /// The thread it's about (kind thread).
    public var threadId: String?
    /// When a booked check-in runs (kind scheduled), ISO.
    public var at: String?

    public init(kind: String, text: String, threadId: String? = nil, at: String? = nil) {
        self.kind = kind
        self.text = text
        self.threadId = threadId
        self.at = at
    }

    public var isBooked: Bool { kind == "scheduled" }
}

/// Whether anyone with its link can read a thread on the website
/// (protocol "Sharing").
public struct ThreadShare: Sendable, Hashable, Codable {
    public enum Access: String, Sendable, Hashable, Codable, CaseIterable {
        case off, link
    }
    public var access: Access
    /// The link is `<website>/s/<slug>`. Kept while sharing is off, so
    /// sharing again brings the same link back.
    public var slug: String

    public init(access: Access, slug: String) {
        self.access = access
        self.slug = slug
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        // Anything else (the "people" of 28 Oct, or a later kind) isn't a
        // public link: off.
        access = (try? c.decode(Access.self, forKey: .access)) ?? .off
        slug = try c.decode(String.self, forKey: .slug)
    }

    enum CodingKeys: String, CodingKey { case access, slug }

    public var isOn: Bool { access == .link }
}

public struct ThreadSummary: Sendable, Hashable, Codable, Identifiable {
    public var id: String
    public var title: String
    public var cwd: String
    public var accountId: String
    public var provider: String
    public var model: String?
    /// The level chosen for the thread; nil is the model's own.
    public var effort: String?
    /// What the CLI actually ran the last turn on and at, once one has run.
    public var modelInUse: String?
    public var effortInUse: String?
    public var permissionMode: PermissionMode
    public var status: ThreadStatus
    public var live: Bool
    public var needsYou: Bool
    /// Image reviews still waiting for a response, independent of whether
    /// the last turn has been read. Absent on older runners.
    public var pendingReviews: Int?
    public var createdAt: Date
    public var updatedAt: Date
    public var lastActivityAt: Date
    public var snoozedUntil: Date?
    /// Hibernating until the runner next starts (snoozedUntil is then a
    /// date far off, which the runner never reaches).
    public var snoozedUntilRestart: Bool
    /// With snoozedUntilRestart: only a start on a new release wakes it.
    public var snoozedUntilRelease: Bool
    /// Hibernated in Mike's words (protocol "Hibernate in words").
    public var wakeWhen: WakeWhen?
    /// Hibernating until these threads finish (end_turn's waitFor).
    public var waitingOn: [WaitingOn]?
    /// Came back from hibernating by itself and not looked at yet: the
    /// row says "Woke up" until then.
    public var woke: ThreadWoke?
    public var archivedAt: Date?
    /// Mike starred it: the Starred section, oldest star first. Kept while
    /// it's archived, so bringing it back stars it again.
    public var starredAt: Date?
    /// Finishing a turn on the runner that handed over to a new release
    /// (protocol "Handovers"); it moves across when the turn ends.
    public var onOldRunner: Bool
    public var preview: String
    public var lastSeq: Int
    public var lastSeenSeq: Int
    public var nativeSessionId: String?
    public var contextTokens: Int?
    /// The model's context window, when the CLI reports it.
    public var contextWindow: Int?
    public var costUsd: Double?
    /// Panels, actions and patches from the folder; empty for most threads.
    public var panels: [Panel]
    public var actions: [Action]
    public var hooks: [Hook]
    public var patches: [PatchInfo]
    /// Background sub-agents and shell jobs the CLI is still running (and
    /// ones just finished whose result it's about to read). Empty when none.
    public var background: [BackgroundTask]
    /// The sub-agents the agent has started: the newest 20, oldest first.
    public var subagents: [Subagent]
    /// The projects it's in, oldest first. Empty when it's in none (or the
    /// runner is from before projects).
    public var projects: [ThreadProject]
    /// The pool that picks its login (docs/pools-plan.md). Nil means it's
    /// pinned to `accountId`, which is every thread from a runner older
    /// than pools.
    public var poolId: String?
    /// Every login in its pool is out of room: it carries on by itself at
    /// `until`.
    public var waitingForRoom: WaitingForRoom?
    /// Its last turn couldn't reach the API (the internet went): it carries
    /// on by itself once the runner reaches it again. Since when.
    public var waitingForNetwork: Date?
    /// Its own worktree, when the repo gives each thread one; nil for most
    /// threads, and from a runner that predates worktrees.
    public var worktree: ThreadWorktree?
    /// One of the tour's sample threads (protocol `threads.samples`): made
    /// up, and nothing can be sent to it.
    public var sample = false
    /// What the last completed turn said it needs from Mike ("you" or
    /// "nothing"), nil when it said neither (docs/protocol.md, "Needs you").
    public var needs: String?
    /// That turn's asks, with Mike's ticks, while it's the open card.
    public var asks: [Ask]
    /// The seq of the turn.completed the asks came with.
    public var asksSeq: Int?
    /// When its highlights last changed other than by a new event (a pin,
    /// a removal, the librarian's brief). The app fetches
    /// `threads.highlights` again when this or `lastSeq` moves. Nil from a
    /// runner from before highlights, or before anything changed.
    public var highlightsAt: Date?
    /// The schedule that started it; nil for one a person or an agent
    /// started, and from a runner that predates this.
    public var schedule: ThreadSchedule?
    /// Who started it, when it wasn't Mike. Nil for his own threads, and from
    /// a runner that predates this.
    public var startedBy: ThreadStartedBy?
    /// Mike's last message to it, one line, for the sidebar's "You: ...".
    /// Nil until he's sent one, and from runners before it (3 Nov).
    public var asked: String?
    /// A panel the agent asked to show Mike, waiting for him to look at the
    /// thread. Nil when there's none, and from a runner older than this.
    public var panelRequest: PanelRequest?
    /// Who else can read it on the website. Nil until it's first shared,
    /// and from a runner older than sharing.
    public var share: ThreadShare?
    /// What's still open on its done card (protocol "Loose ends"). Nil when
    /// it wasn't checked: the experiment's off, the last turn needs Mike,
    /// or a runner older than this.
    public var looseEnds: LooseEnds?
    /// Set by the app for another runner's thread (docs/protocol.md,
    /// "Other runners' threads"): which runner it lives on, so its rows can
    /// say so and its requests go there. Nil for this Mac's own. Never on
    /// the wire: a runner's summaries are all its own.
    public var runnerId: String?

    /// Lives on another runner.
    public var isRemote: Bool { runnerId != nil }

    public init(
        id: String, title: String, cwd: String = "~/ThreadbearThreads", accountId: String = "claude-main",
        provider: String = "claude", model: String? = nil, permissionMode: PermissionMode = .full,
        status: ThreadStatus = .idle, live: Bool = false, needsYou: Bool = false,
        createdAt: Date = Date(), updatedAt: Date = Date(), lastActivityAt: Date = Date(),
        snoozedUntil: Date? = nil, snoozedUntilRestart: Bool = false, snoozedUntilRelease: Bool = false, wakeWhen: WakeWhen? = nil, waitingOn: [WaitingOn]? = nil, woke: ThreadWoke? = nil, archivedAt: Date? = nil, starredAt: Date? = nil, onOldRunner: Bool = false, preview: String = "",
        lastSeq: Int = 0, lastSeenSeq: Int = 0, nativeSessionId: String? = nil,
        contextTokens: Int? = nil, costUsd: Double? = nil,
        effort: String? = nil, modelInUse: String? = nil, effortInUse: String? = nil, contextWindow: Int? = nil,
        panels: [Panel] = [], actions: [Action] = [], hooks: [Hook] = [], patches: [PatchInfo] = [], background: [BackgroundTask] = [],
        subagents: [Subagent] = [], projects: [ThreadProject] = [], pendingReviews: Int? = nil, worktree: ThreadWorktree? = nil, needs: String? = nil, asks: [Ask] = [], asksSeq: Int? = nil,
        highlightsAt: Date? = nil,
        schedule: ThreadSchedule? = nil, poolId: String? = nil, waitingForRoom: WaitingForRoom? = nil,
        panelRequest: PanelRequest? = nil, share: ThreadShare? = nil, startedBy: ThreadStartedBy? = nil,
        looseEnds: LooseEnds? = nil
    ) {
        self.id = id
        self.looseEnds = looseEnds
        self.title = title
        self.cwd = cwd
        self.accountId = accountId
        self.provider = provider
        self.model = model
        self.effort = effort
        self.modelInUse = modelInUse
        self.effortInUse = effortInUse
        self.permissionMode = permissionMode
        self.status = status
        self.live = live
        self.needsYou = needsYou
        self.pendingReviews = pendingReviews
        self.createdAt = createdAt
        self.updatedAt = updatedAt
        self.lastActivityAt = lastActivityAt
        self.snoozedUntil = snoozedUntil
        self.snoozedUntilRestart = snoozedUntilRestart
        self.snoozedUntilRelease = snoozedUntilRelease
        self.wakeWhen = wakeWhen
        self.waitingOn = waitingOn
        self.woke = woke
        self.archivedAt = archivedAt
        self.starredAt = starredAt
        self.onOldRunner = onOldRunner
        self.preview = preview
        self.lastSeq = lastSeq
        self.lastSeenSeq = lastSeenSeq
        self.nativeSessionId = nativeSessionId
        self.contextTokens = contextTokens
        self.contextWindow = contextWindow
        self.costUsd = costUsd
        self.panels = panels
        self.actions = actions
        self.hooks = hooks
        self.patches = patches
        self.background = background
        self.subagents = subagents
        self.projects = projects
        self.poolId = poolId
        self.waitingForRoom = waitingForRoom
        self.worktree = worktree
        self.needs = needs
        self.asks = asks
        self.asksSeq = asksSeq
        self.highlightsAt = highlightsAt
        self.schedule = schedule
        self.startedBy = startedBy
        self.panelRequest = panelRequest
        self.share = share
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        func date(_ key: CodingKeys) throws -> Date? {
            guard let text = try c.decodeIfPresent(String.self, forKey: key) else { return nil }
            return ISO8601.parse(text)
        }
        id = try c.decode(String.self, forKey: .id)
        title = try c.decodeIfPresent(String.self, forKey: .title) ?? ""
        cwd = try c.decodeIfPresent(String.self, forKey: .cwd) ?? ""
        accountId = try c.decodeIfPresent(String.self, forKey: .accountId) ?? ""
        provider = try c.decodeIfPresent(String.self, forKey: .provider) ?? "claude"
        model = try c.decodeIfPresent(String.self, forKey: .model)
        effort = try c.decodeIfPresent(String.self, forKey: .effort)
        modelInUse = try c.decodeIfPresent(String.self, forKey: .modelInUse)
        effortInUse = try c.decodeIfPresent(String.self, forKey: .effortInUse)
        permissionMode = try c.decodeIfPresent(PermissionMode.self, forKey: .permissionMode) ?? .full
        status = try c.decodeIfPresent(ThreadStatus.self, forKey: .status) ?? .idle
        live = try c.decodeIfPresent(Bool.self, forKey: .live) ?? false
        needsYou = try c.decodeIfPresent(Bool.self, forKey: .needsYou) ?? false
        pendingReviews = c.lenientInt(forKey: .pendingReviews)
        let created = try date(.createdAt) ?? Date(timeIntervalSince1970: 0)
        createdAt = created
        updatedAt = try date(.updatedAt) ?? created
        lastActivityAt = try date(.lastActivityAt) ?? updatedAt
        snoozedUntil = try date(.snoozedUntil)
        snoozedUntilRestart = ((try? c.decodeIfPresent(Bool.self, forKey: .snoozedUntilRestart)) ?? nil) ?? false
        snoozedUntilRelease = ((try? c.decodeIfPresent(Bool.self, forKey: .snoozedUntilRelease)) ?? nil) ?? false
        wakeWhen = (try? c.decodeIfPresent(WakeWhen.self, forKey: .wakeWhen)) ?? nil
        waitingOn = (try? c.decodeIfPresent([WaitingOn].self, forKey: .waitingOn)) ?? nil
        woke = (try? c.decodeIfPresent(ThreadWoke.self, forKey: .woke)) ?? nil
        archivedAt = try date(.archivedAt)
        starredAt = try date(.starredAt)
        onOldRunner = ((try? c.decodeIfPresent(Bool.self, forKey: .onOldRunner)) ?? nil) ?? false
        preview = try c.decodeIfPresent(String.self, forKey: .preview) ?? ""
        lastSeq = c.lenientInt(forKey: .lastSeq) ?? 0
        lastSeenSeq = c.lenientInt(forKey: .lastSeenSeq) ?? 0
        nativeSessionId = try c.decodeIfPresent(String.self, forKey: .nativeSessionId)
        contextTokens = try c.decodeIfPresent(Double.self, forKey: .contextTokens).flatMap { $0.wholeCount() }
        contextWindow = ((try? c.decodeIfPresent(Double.self, forKey: .contextWindow)) ?? nil).flatMap { $0.wholeCount() }
        costUsd = try c.decodeIfPresent(Double.self, forKey: .costUsd)
        panels = c.lossyArray(Panel.self, forKey: .panels)
        actions = c.lossyArray(Action.self, forKey: .actions)
        hooks = c.lossyArray(Hook.self, forKey: .hooks)
        patches = c.lossyArray(PatchInfo.self, forKey: .patches)
        background = c.lossyArray(BackgroundTask.self, forKey: .background)
        subagents = c.lossyArray(Subagent.self, forKey: .subagents)
        projects = c.lossyArray(ThreadProject.self, forKey: .projects)
        poolId = ((try? c.decodeIfPresent(String.self, forKey: .poolId)) ?? nil).flatMap { $0.isEmpty ? nil : $0 }
        waitingForRoom = (try? c.decodeIfPresent(WaitingForRoom.self, forKey: .waitingForRoom)) ?? nil
        waitingForNetwork = (try? c.nestedContainer(keyedBy: NetworkWaitKeys.self, forKey: .waitingForNetwork))
            .flatMap { try? $0.decode(String.self, forKey: .since) }
            .flatMap(ISO8601.parse)
        // A malformed one is as good as none, rather than losing the thread.
        worktree = (try? c.decodeIfPresent(ThreadWorktree.self, forKey: .worktree)) ?? nil
        sample = (try? c.decodeIfPresent(Bool.self, forKey: .sample)) ?? false
        needs = (try? c.decodeIfPresent(String.self, forKey: .needs)) ?? nil
        asks = c.lossyArray(Ask.self, forKey: .asks)
        asksSeq = c.lenientInt(forKey: .asksSeq)
        highlightsAt = ((try? c.decodeIfPresent(String.self, forKey: .highlightsAt)) ?? nil).flatMap(ISO8601.parse)
        schedule = (try? c.decodeIfPresent(ThreadSchedule.self, forKey: .schedule)) ?? nil
        startedBy = (try? c.decodeIfPresent(ThreadStartedBy.self, forKey: .startedBy)) ?? nil
        asked = (try? c.decodeIfPresent(String.self, forKey: .asked)) ?? nil
        panelRequest = (try? c.decodeIfPresent(PanelRequest.self, forKey: .panelRequest)) ?? nil
        share = (try? c.decodeIfPresent(ThreadShare.self, forKey: .share)) ?? nil
        looseEnds = (try? c.decodeIfPresent(LooseEnds.self, forKey: .looseEnds)) ?? nil
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(id, forKey: .id)
        try c.encode(title, forKey: .title)
        try c.encode(cwd, forKey: .cwd)
        try c.encode(accountId, forKey: .accountId)
        try c.encode(provider, forKey: .provider)
        try c.encodeIfPresent(model, forKey: .model)
        try c.encodeIfPresent(effort, forKey: .effort)
        try c.encodeIfPresent(modelInUse, forKey: .modelInUse)
        try c.encodeIfPresent(effortInUse, forKey: .effortInUse)
        try c.encode(permissionMode, forKey: .permissionMode)
        try c.encode(status, forKey: .status)
        try c.encode(live, forKey: .live)
        try c.encode(needsYou, forKey: .needsYou)
        try c.encodeIfPresent(pendingReviews, forKey: .pendingReviews)
        try c.encode(ISO8601.format(createdAt), forKey: .createdAt)
        try c.encode(ISO8601.format(updatedAt), forKey: .updatedAt)
        try c.encode(ISO8601.format(lastActivityAt), forKey: .lastActivityAt)
        try c.encodeIfPresent(snoozedUntil.map(ISO8601.format), forKey: .snoozedUntil)
        if snoozedUntilRestart { try c.encode(true, forKey: .snoozedUntilRestart) }
        if snoozedUntilRelease { try c.encode(true, forKey: .snoozedUntilRelease) }
        try c.encodeIfPresent(wakeWhen, forKey: .wakeWhen)
        try c.encodeIfPresent(waitingOn, forKey: .waitingOn)
        try c.encodeIfPresent(woke, forKey: .woke)
        try c.encodeIfPresent(archivedAt.map(ISO8601.format), forKey: .archivedAt)
        try c.encodeIfPresent(starredAt.map(ISO8601.format), forKey: .starredAt)
        if onOldRunner { try c.encode(true, forKey: .onOldRunner) }
        try c.encode(preview, forKey: .preview)
        try c.encode(lastSeq, forKey: .lastSeq)
        try c.encode(lastSeenSeq, forKey: .lastSeenSeq)
        try c.encodeIfPresent(nativeSessionId, forKey: .nativeSessionId)
        try c.encodeIfPresent(contextTokens, forKey: .contextTokens)
        try c.encodeIfPresent(contextWindow, forKey: .contextWindow)
        try c.encodeIfPresent(costUsd, forKey: .costUsd)
        if !panels.isEmpty { try c.encode(panels, forKey: .panels) }
        if !actions.isEmpty { try c.encode(actions, forKey: .actions) }
        if !hooks.isEmpty { try c.encode(hooks, forKey: .hooks) }
        if !patches.isEmpty { try c.encode(patches, forKey: .patches) }
        if !background.isEmpty { try c.encode(background, forKey: .background) }
        if !subagents.isEmpty { try c.encode(subagents, forKey: .subagents) }
        if !projects.isEmpty { try c.encode(projects, forKey: .projects) }
        try c.encodeIfPresent(poolId, forKey: .poolId)
        try c.encodeIfPresent(waitingForRoom, forKey: .waitingForRoom)
        if let since = waitingForNetwork {
            var w = c.nestedContainer(keyedBy: NetworkWaitKeys.self, forKey: .waitingForNetwork)
            try w.encode(ISO8601.format(since), forKey: .since)
        }
        try c.encodeIfPresent(worktree, forKey: .worktree)
        if sample { try c.encode(true, forKey: .sample) }
        try c.encodeIfPresent(needs, forKey: .needs)
        if !asks.isEmpty { try c.encode(asks, forKey: .asks) }
        try c.encodeIfPresent(asksSeq, forKey: .asksSeq)
        try c.encodeIfPresent(highlightsAt.map(ISO8601.format), forKey: .highlightsAt)
        try c.encodeIfPresent(schedule, forKey: .schedule)
        try c.encodeIfPresent(startedBy, forKey: .startedBy)
        try c.encodeIfPresent(asked, forKey: .asked)
        try c.encodeIfPresent(panelRequest, forKey: .panelRequest)
        try c.encodeIfPresent(share, forKey: .share)
        try c.encodeIfPresent(looseEnds, forKey: .looseEnds)
    }

    enum CodingKeys: String, CodingKey {
        case id, title, cwd, accountId, provider, model, effort, modelInUse, effortInUse, permissionMode, status, live, needsYou, pendingReviews
        case createdAt, updatedAt, lastActivityAt, snoozedUntil, snoozedUntilRestart, snoozedUntilRelease, wakeWhen, waitingOn, woke, archivedAt, starredAt, onOldRunner, preview
        case lastSeq, lastSeenSeq, nativeSessionId, contextTokens, contextWindow, costUsd, panels, actions, hooks, patches, background, subagents
        case projects, worktree, needs, asks, asksSeq, highlightsAt, schedule, startedBy, asked, poolId, waitingForRoom, waitingForNetwork, panelRequest, share, sample, looseEnds
    }

    enum NetworkWaitKeys: String, CodingKey { case since }

    /// The first ask Mike hasn't ticked on the open card, if any: what the
    /// sidebar and a notification show instead of the last line of prose.
    public var firstOpenAsk: Ask? { asksSeq == nil ? nil : asks.first { !$0.ticked } }

    /// The last turn finished and said nothing waits on Mike.
    public var saidDone: Bool { needs == "nothing" }

    /// Still being worked on between turns: background sub-agents or jobs
    /// are running (or just finished, with their result still to be read)
    /// and no turn is underway to show for it.
    public var isWorkingInBackground: Bool { !background.isEmpty && !status.isBusy }

    /// Agents are still working for this thread: sub-agents or a workflow's,
    /// including ones just finished whose result is still to be read. Same
    /// rule as the runner's `agentsStillWorking`.
    public var agentsStillWorking: Bool { background.contains { $0.kind == .agent || $0.kind == .other } }

    /// The last turn ended asking Mike for something and he hasn't done it
    /// all yet. Read or not, and whatever job it left running: an agent that
    /// sets a job watching for what it just asked him to do (Mike's "put the
    /// SD card back in the Pi", 1 Nov) would otherwise sit under Running,
    /// where he doesn't look, while the job waits for him and he waits for it.
    /// Sub-agents are different: what they find can change what the agent
    /// asks next, so the thread isn't his move until they're done (Mike,
    /// 2 Nov). Ticking every ask hands it back. `InboxSections` on the phone
    /// has the same rule as `PhoneThread.waitingOnMike`.
    public var waitingOnMike: Bool { needs == "you" && !status.isBusy && !agentsStillWorking && (asks.isEmpty || asks.contains { !$0.ticked }) }

    public var hasPendingReviews: Bool { (pendingReviews ?? 0) > 0 }

    /// A design review waiting on Mike, and the thread has finished
    /// working. show_options doesn't block the turn, so while the turn or
    /// background work carries on the thread stays in Running; it comes
    /// to the inbox as "Needs you" once it's done, like a reply would.
    public var reviewWaiting: Bool { hasPendingReviews && !status.isBusy && background.isEmpty }

    public var isArchived: Bool { archivedAt != nil }

    public var isStarred: Bool { starredAt != nil }

    public func isSnoozed(at now: Date) -> Bool {
        guard let snoozedUntil else { return false }
        return snoozedUntil > now
    }
}

/// When a hibernating thread came back by itself (`at`), and when it was
/// put away (`since`), when the runner knows.
public struct ThreadWoke: Sendable, Hashable, Codable {
    public var at: Date
    public var since: Date?

    public init(at: Date, since: Date? = nil) {
        self.at = at
        self.since = since
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        guard let at = ISO8601.parse(try c.decode(String.self, forKey: .at)) else {
            throw DecodingError.dataCorruptedError(forKey: .at, in: c, debugDescription: "not an ISO time")
        }
        self.at = at
        since = try c.decodeIfPresent(String.self, forKey: .since).flatMap(ISO8601.parse)
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(ISO8601.format(at), forKey: .at)
        try c.encodeIfPresent(since.map(ISO8601.format), forKey: .since)
    }

    enum CodingKeys: String, CodingKey { case at, since }
}

/// When a thread hibernated in Mike's words wakes: what he said, the topic
/// it waits for him to bring up (the librarian listens), and `pending`
/// while the runner's model works out the time.
/// A thread a hibernating one waits on (end_turn's waitFor); done once it
/// has finished, been archived or been deleted.
public struct WaitingOn: Sendable, Hashable, Codable {
    public var threadId: String
    public var title: String
    /// Waits until it has done this ("it reports the I/O saving"), as the
    /// librarian judges, rather than for any finish.
    public var until: String?
    public var done: Bool

    public init(threadId: String, title: String, until: String? = nil, done: Bool = false) {
        self.threadId = threadId
        self.title = title
        self.until = until
        self.done = done
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        threadId = try c.decode(String.self, forKey: .threadId)
        title = try c.decode(String.self, forKey: .title)
        until = (try? c.decodeIfPresent(String.self, forKey: .until)) ?? nil
        done = (try? c.decodeIfPresent(Bool.self, forKey: .done)) ?? false
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(threadId, forKey: .threadId)
        try c.encode(title, forKey: .title)
        try c.encodeIfPresent(until, forKey: .until)
        if done { try c.encode(true, forKey: .done) }
    }

    enum CodingKeys: String, CodingKey { case threadId, title, until, done }
}

extension ThreadSummary {
    /// The thread as it will be once "Wake when…" has landed: put away, its
    /// row saying Thinking… until the runner has worked out when.
    public func hibernating(said: String) -> ThreadSummary {
        var thread = self
        thread.snoozedUntil = .distantFuture
        thread.snoozedUntilRestart = false
        thread.wakeWhen = WakeWhen(said: said, pending: true)
        return thread
    }
}

public struct WakeWhen: Sendable, Hashable, Codable {
    public var said: String
    public var topic: String?
    public var pending: Bool

    public init(said: String, topic: String? = nil, pending: Bool = false) {
        self.said = said
        self.topic = topic
        self.pending = pending
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        said = try c.decode(String.self, forKey: .said)
        topic = try c.decodeIfPresent(String.self, forKey: .topic)
        pending = ((try? c.decodeIfPresent(Bool.self, forKey: .pending)) ?? nil) ?? false
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(said, forKey: .said)
        try c.encodeIfPresent(topic, forKey: .topic)
        if pending { try c.encode(true, forKey: .pending) }
    }

    enum CodingKeys: String, CodingKey { case said, topic, pending }
}

public struct RunnerDefaults: Sendable, Hashable, Codable {
    public var cwd: String
    public var accountId: String
    /// The model a new Claude thread gets when it names none (runner.json's
    /// `defaults.model`; a dev runner sets the cheapest). Nil: the account's.
    public var model: String?
    /// The same per provider ("claude", "codex"); empty from older runners.
    public var models: [String: String]
    /// The effort a new thread gets per provider; missing: the model's own.
    public var efforts: [String: String]
    /// The pool a new thread with nothing named starts on. It doesn't look
    /// at folders: the app applies those itself (`Pools.forFolder`). Nil
    /// from a runner older than pools.
    public var poolId: String?

    public init(cwd: String, accountId: String, model: String? = nil, models: [String: String] = [:], efforts: [String: String] = [:], poolId: String? = nil) {
        self.cwd = cwd
        self.accountId = accountId
        self.model = model
        self.models = models
        self.efforts = efforts
        self.poolId = poolId
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        cwd = (try? c.decodeIfPresent(String.self, forKey: .cwd)) ?? ""
        accountId = (try? c.decodeIfPresent(String.self, forKey: .accountId)) ?? ""
        model = try? c.decodeIfPresent(String.self, forKey: .model)
        models = Self.strings(c, .models)
        efforts = Self.strings(c, .efforts)
        poolId = ((try? c.decodeIfPresent(String.self, forKey: .poolId)) ?? nil).flatMap { $0.isEmpty ? nil : $0 }
    }

    /// The model a new thread on `provider` gets when it names none.
    public func model(for provider: String) -> String? {
        models[provider] ?? (provider == "claude" ? model : nil)
    }

    // A map of strings, skipping values that aren't (a provider this app
    // doesn't know may carry something else).
    private static func strings(_ c: KeyedDecodingContainer<CodingKeys>, _ key: CodingKeys) -> [String: String] {
        guard let raw = (try? c.decodeIfPresent([String: JSONValue].self, forKey: key)) ?? nil else { return [:] }
        return raw.compactMapValues(\.stringValue)
    }

    enum CodingKeys: String, CodingKey { case cwd, accountId, model, models, efforts, poolId }
}

public struct HelloResult: Sendable, Hashable, Decodable {
    public var runnerVersion: String
    public var `protocol`: Int
    public var accounts: [Account]
    public var defaults: RunnerDefaults
    /// Empty from runners older than step 4 (they have no `clis.*` either).
    public var clis: [CliStatus]
    /// The runner's own update (protocol "Runner updates"); nil from a
    /// runner older than that.
    public var updates: RunnerUpdates?
    /// Nil from a runner older than pools: the app then works as before,
    /// with providers in the picker's rail and an account chip.
    public var pools: [Pool]?
    /// The runner's experiments that are on (protocol "hello"), for the
    /// ones that live in the app, like Voice mode. Empty from an older
    /// runner, so they stay off.
    public var experiments: Set<String>

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        runnerVersion = try c.decodeIfPresent(String.self, forKey: .runnerVersion) ?? "?"
        `protocol` = try c.decodeIfPresent(Int.self, forKey: .protocol) ?? 1
        accounts = try c.decodeIfPresent([Account].self, forKey: .accounts) ?? []
        defaults = (try? c.decodeIfPresent(RunnerDefaults.self, forKey: .defaults))
            ?? RunnerDefaults(cwd: "", accountId: accounts.first?.id ?? "claude-main")
        if defaults.accountId.isEmpty { defaults.accountId = accounts.first?.id ?? "claude-main" }
        clis = c.lossyArray(CliStatus.self, forKey: .clis)
        updates = try? c.decodeIfPresent(RunnerUpdates.self, forKey: .updates)
        pools = c.contains(.pools) ? c.lossyArray(Pool.self, forKey: .pools) : nil
        experiments = Set(c.lossyArray(String.self, forKey: .experiments))
    }

    enum CodingKeys: String, CodingKey {
        case runnerVersion, `protocol`, accounts, defaults, clis, updates, pools, experiments
    }
}

/// What the runner's own update is doing (protocol "Runner updates"): hello's
/// `updates` and `runner.updates`. Read leniently.
public struct RunnerUpdates: Sendable, Hashable, Decodable {
    public struct OldRunner: Sendable, Hashable, Decodable {
        public var version: String
        public var threads: [String]

        public init(version: String, threads: [String]) {
            self.version = version
            self.threads = threads
        }

        public init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            version = ((try? c.decodeIfPresent(String.self, forKey: .version)) ?? nil) ?? "?"
            threads = ((try? c.decodeIfPresent([String].self, forKey: .threads)) ?? nil) ?? []
        }

        enum CodingKeys: String, CodingKey { case version, threads }
    }

    /// Mike's releases, for a fork (protocol "Mike's releases").
    public struct Upstream: Sendable, Hashable, Decodable {
        public struct Release: Sendable, Hashable, Decodable {
            /// One verified release's notes, or its commit subjects as a fallback.
            public struct Notes: Sendable, Hashable, Decodable {
                public var tag: String
                public var lines: [String]

                public init(tag: String, lines: [String]) {
                    self.tag = tag
                    self.lines = lines
                }
            }

            public var tag: String
            /// The commit the verified tag names: what Bring them in merges,
            /// rather than a ref name a later fetch could move.
            public var commit: String?
            public var changes: Int
            public var subjects: [String]
            /// Each verified release main doesn't have yet, with notes or subjects,
            /// newest first. Empty from an older runner.
            public var notes: [Notes]

            public init(tag: String, commit: String? = nil, changes: Int, subjects: [String] = [], notes: [Notes] = []) {
                self.tag = tag
                self.commit = commit
                self.changes = changes
                self.subjects = subjects
                self.notes = notes
            }

            public init(from decoder: Decoder) throws {
                let c = try decoder.container(keyedBy: CodingKeys.self)
                tag = ((try? c.decodeIfPresent(String.self, forKey: .tag)) ?? nil) ?? "?"
                commit = (try? c.decodeIfPresent(String.self, forKey: .commit)) ?? nil
                changes = ((try? c.decodeIfPresent(Int.self, forKey: .changes)) ?? nil) ?? 0
                subjects = ((try? c.decodeIfPresent([String].self, forKey: .subjects)) ?? nil) ?? []
                notes = c.lossyArray(Notes.self, forKey: .notes).filter { !$0.lines.isEmpty }
            }

            enum CodingKeys: String, CodingKey { case tag, commit, changes, subjects, notes }
        }

        /// off, idle, checking, available or failed.
        public var state: String
        public var reason: String?
        public var checkout: String?
        public var release: Release?
        /// Mike's own runner: the last release tag it made.
        public var publishedTag: String?
        /// Mike's own runner: why today's release is waiting on GitHub's checks.
        public var heldWhy: String?

        public init(state: String, reason: String? = nil, checkout: String? = nil, release: Release? = nil, publishedTag: String? = nil, heldWhy: String? = nil) {
            self.state = state
            self.reason = reason
            self.checkout = checkout
            self.release = release
            self.publishedTag = publishedTag
            self.heldWhy = heldWhy
        }

        public init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            state = ((try? c.decodeIfPresent(String.self, forKey: .state)) ?? nil) ?? "off"
            reason = (try? c.decodeIfPresent(String.self, forKey: .reason)) ?? nil
            checkout = (try? c.decodeIfPresent(String.self, forKey: .checkout)) ?? nil
            release = (try? c.decodeIfPresent(Release.self, forKey: .release)) ?? nil
            publishedTag = ((try? c.decodeIfPresent(Published.self, forKey: .published)) ?? nil)?.tag
            heldWhy = ((try? c.decodeIfPresent(Held.self, forKey: .held)) ?? nil)?.why
        }

        private struct Published: Decodable { var tag: String }
        private struct Held: Decodable { var why: String }
        enum CodingKeys: String, CodingKey { case state, reason, checkout, release, published, held }

        /// A newer release than main has, to bring in.
        public var available: Bool { state == "available" && (release?.changes ?? 0) > 0 }
    }

    /// off, idle, checking, building, waiting or failed.
    public var state: String
    public var commit: String?
    public var subject: String?
    public var reason: String?
    public var oldRunners: [OldRunner]
    public var launcherChanged: Bool
    /// Which way the LaunchAgent is behind main, in a sentence (runners
    /// from before 29 Oct 2026 don't send it).
    public var launcherReason: String?
    /// Left out by runners before 30 Oct 2026, and while it's off.
    public var upstream: Upstream?

    public init(state: String = "idle", commit: String? = nil, subject: String? = nil, reason: String? = nil, oldRunners: [OldRunner] = [], launcherChanged: Bool = false, launcherReason: String? = nil, upstream: Upstream? = nil) {
        self.state = state
        self.commit = commit
        self.subject = subject
        self.reason = reason
        self.oldRunners = oldRunners
        self.launcherChanged = launcherChanged
        self.launcherReason = launcherReason
        self.upstream = upstream
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        state = ((try? c.decodeIfPresent(String.self, forKey: .state)) ?? nil) ?? "idle"
        commit = (try? c.decodeIfPresent(String.self, forKey: .commit)) ?? nil
        subject = (try? c.decodeIfPresent(String.self, forKey: .subject)) ?? nil
        reason = (try? c.decodeIfPresent(String.self, forKey: .reason)) ?? nil
        oldRunners = c.lossyArray(OldRunner.self, forKey: .oldRunners)
        launcherChanged = ((try? c.decodeIfPresent(Bool.self, forKey: .launcherChanged)) ?? nil) ?? false
        launcherReason = (try? c.decodeIfPresent(String.self, forKey: .launcherReason)) ?? nil
        upstream = (try? c.decodeIfPresent(Upstream.self, forKey: .upstream)) ?? nil
    }

    enum CodingKeys: String, CodingKey { case state, commit, subject, reason, oldRunners, launcherChanged, launcherReason, upstream }

    /// Something's on its way: a release being built or about to start, an
    /// old runner still finishing turns, or a LaunchAgent to reinstall.
    public var isPending: Bool {
        state == "building" || state == "waiting" || !oldRunners.isEmpty || launcherChanged
    }

    public var failed: Bool { state == "failed" }
}

struct RunnerUpdatesParams: Decodable {
    var updates: RunnerUpdates
}

/// Fast parser and formatter for the protocol's ISO 8601 UTC strings.
public enum ISO8601 {
    /// Parses "2026-10-26T13:44:00Z", with optional fractional seconds and a
    /// "+hh:mm" (or "+hhmm") offset; no zone at all is read as UTC. Hand-rolled
    /// because thread lists parse thousands of these. Anything else is nil:
    /// these strings come from other runners and the backend, and an offset
    /// of "+////" once reached `byte - 48` on a byte below "0", which traps
    /// (Daybreak, 7 Nov 2026), so every byte is checked before it's used.
    public static func parse(_ text: String) -> Date? {
        let utf8 = Array(text.utf8)
        // The longest real one is nanoseconds and an offset, 35 bytes.
        guard utf8.count >= 19, utf8.count <= 64 else { return nil }
        func number(_ start: Int, _ length: Int) -> Int? {
            var value = 0
            for index in start..<(start + length) {
                guard index < utf8.count else { return nil }
                let byte = utf8[index]
                guard byte >= 48, byte <= 57 else { return nil }
                value = value * 10 + Int(byte - 48)
            }
            return value
        }
        func byte(_ index: Int, is choices: String) -> Bool {
            index < utf8.count && choices.utf8.contains(utf8[index])
        }
        guard byte(4, is: "-"), byte(7, is: "-"), byte(10, is: "Tt "), byte(13, is: ":"), byte(16, is: ":"),
              let year = number(0, 4), let month = number(5, 2), let day = number(8, 2),
              let hour = number(11, 2), let minute = number(14, 2), let second = number(17, 2),
              (1...12).contains(month), (1...31).contains(day), hour <= 23, minute <= 59, second <= 60
        else { return nil }
        var index = 19
        var fraction = 0.0
        if index < utf8.count, utf8[index] == UInt8(ascii: ".") {
            index += 1
            let digits = index
            var scale = 0.1
            while index < utf8.count, utf8[index] >= 48, utf8[index] <= 57 {
                fraction += Double(utf8[index] - 48) * scale
                scale /= 10
                index += 1
            }
            guard index > digits else { return nil }
        }
        var offsetSeconds = 0
        if index < utf8.count {
            let sign = utf8[index]
            if sign == UInt8(ascii: "Z") || sign == UInt8(ascii: "z") {
                index += 1
            } else if sign == UInt8(ascii: "+") || sign == UInt8(ascii: "-") {
                // "+hh:mm" or "+hhmm", each a digit, and a real offset.
                let colon = byte(index + 3, is: ":") ? 1 : 0
                guard let hours = number(index + 1, 2), let minutes = number(index + 3 + colon, 2),
                      hours <= 23, minutes <= 59 else { return nil }
                offsetSeconds = (hours * 3600 + minutes * 60) * (sign == UInt8(ascii: "+") ? 1 : -1)
                index += 5 + colon
            } else {
                return nil
            }
            guard index == utf8.count else { return nil }
        }
        let days = daysFromCivil(year: year, month: month, day: day)
        let seconds = Double(days * 86_400 + hour * 3600 + minute * 60 + second - offsetSeconds) + fraction
        return Date(timeIntervalSince1970: seconds)
    }

    /// "2026-10-26T13:44:00.250Z". The trailing Z matters: without it the
    /// runner's `Date.parse` reads the time as local, which put snoozes off
    /// by the time zone.
    public static func format(_ date: Date) -> String {
        date.formatted(Date.ISO8601FormatStyle(includingFractionalSeconds: true))
    }

    // Howard Hinnant's days_from_civil.
    private static func daysFromCivil(year: Int, month: Int, day: Int) -> Int {
        let y = month <= 2 ? year - 1 : year
        let era = (y >= 0 ? y : y - 399) / 400
        let yoe = y - era * 400
        let mp = (month + 9) % 12
        let doy = (153 * mp + 2) / 5 + day - 1
        let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy
        return era * 146_097 + doe - 719_468
    }
}

/// One thing a finished turn needs Mike to do (docs/protocol.md, "Needs
/// you"): the action, where he does it, and the words to send back. With
/// options it's a decision: a line of why, the likely answers, and the
/// agent's own pick (an index into options).
public struct Ask: Sendable, Hashable, Codable {
    public var action: String
    public var where_: String?
    public var reply: String?
    public var why: String?
    public var options: [String]
    /// With one reply, what each option does if Mike picks it, in the
    /// options' order ("" for none). The card draws them under the labels
    /// as rows (docs/protocol.md, "One reply").
    public var optionNotes: [String]
    public var suggested: Int?
    /// Where to go to do it or judge it, shown as buttons on the card.
    public var links: [AskLink]
    /// Ticked on the open card (only in a summary's `asks`).
    public var ticked: Bool

    /// The action and where as plain words, for the places that can't draw
    /// markdown (Highlights' Needs you list, notifications, a closed card,
    /// tooltips): an agent's `[the review](review:x)` reads "the review".
    public var plainAction: String { PreviewText.plain(action) }
    public var plainWhere: String? { where_.flatMap { $0.isEmpty ? nil : PreviewText.plain($0) } }

    public init(action: String, where_: String? = nil, reply: String? = nil, why: String? = nil, options: [String] = [], optionNotes: [String] = [], suggested: Int? = nil, links: [AskLink] = [], ticked: Bool = false) {
        self.action = action
        self.where_ = where_
        self.reply = reply
        self.why = why
        self.options = options
        self.optionNotes = optionNotes
        self.suggested = suggested
        self.links = links
        self.ticked = ticked
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        action = try c.decode(String.self, forKey: .action)
        where_ = (try? c.decodeIfPresent(String.self, forKey: .where_)) ?? nil
        reply = (try? c.decodeIfPresent(String.self, forKey: .reply)) ?? nil
        why = (try? c.decodeIfPresent(String.self, forKey: .why)) ?? nil
        let options = ((try? c.decodeIfPresent([String].self, forKey: .options)) ?? nil) ?? []
        self.options = options
        // One note per option, or none: a list that doesn't line up is
        // dropped rather than guessed at.
        let notes = ((try? c.decodeIfPresent([String].self, forKey: .optionNotes)) ?? nil) ?? []
        optionNotes = notes.count == options.count && notes.contains(where: { !$0.isEmpty }) ? notes : []
        let pick = (try? c.decodeIfPresent(Int.self, forKey: .suggested)) ?? nil
        suggested = pick.flatMap { options.indices.contains($0) ? $0 : nil }
        links = c.lossyArray(AskLink.self, forKey: .links)
        ticked = ((try? c.decodeIfPresent(Bool.self, forKey: .ticked)) ?? nil) ?? false
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(action, forKey: .action)
        try c.encodeIfPresent(where_, forKey: .where_)
        try c.encodeIfPresent(reply, forKey: .reply)
        try c.encodeIfPresent(why, forKey: .why)
        if !options.isEmpty { try c.encode(options, forKey: .options) }
        if !optionNotes.isEmpty { try c.encode(optionNotes, forKey: .optionNotes) }
        try c.encodeIfPresent(suggested, forKey: .suggested)
        if !links.isEmpty { try c.encode(links, forKey: .links) }
        if ticked { try c.encode(true, forKey: .ticked) }
    }

    enum CodingKeys: String, CodingKey {
        case action, reply, ticked, why, options, optionNotes, suggested, links
        case where_ = "where"
    }
}

/// A button on an ask: a web page, a file or folder on this Mac (an
/// absolute, `~` or `file://` path), or `review:<id>`, one of the
/// thread's design reviews.
public struct AskLink: Sendable, Hashable, Codable {
    public var title: String
    public var url: String

    public init(title: String, url: String) {
        self.title = title
        self.url = url
    }

    /// What clicking it opens: the web page, the file with `~` expanded,
    /// or the review.
    public var target: URL? {
        if url.hasPrefix("~/") || url.hasPrefix("/") { return URL(fileURLWithPath: (url as NSString).expandingTildeInPath) }
        guard let parsed = URL(string: url), let scheme = parsed.scheme?.lowercased(), ["http", "https", "file", WorkLinks.reviewScheme].contains(scheme) else { return nil }
        if scheme == WorkLinks.reviewScheme, WorkLinks.reviewId(of: parsed) == nil { return nil }
        return parsed
    }
}

/// One of the open card's asks a message answered, and the answer he
/// picked (docs/protocol.md, "Needs you"): sent with `threads.send` and
/// kept on the `user.message`, so the bubble can show it as an answer.
public struct AskAnswer: Sendable, Hashable, Codable {
    public var action: String
    public var answer: String

    public init(action: String, answer: String) {
        self.action = action
        self.answer = answer
    }
}
