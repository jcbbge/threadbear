import Foundation

/// Typed wrappers for the requests in docs/protocol.md.
public extension RPCClient {
    /// `build` is the bundle's build (commit, short, tree), so the runner
    /// can tell threads waiting for it when the app is back on a new one
    /// (docs/protocol.md, "App restarts"). A dev build has none.
    func hello(client: String = "threadbear-mac", version: String, build: (commit: String, short: String, tree: String)? = nil) async throws -> HelloResult {
        var params: [String: JSONValue] = ["client": .string(client), "version": .string(version)]
        if client == "threadbear-mac" { params["browserPanel"] = .bool(true) }
        if let build {
            params["build"] = .object(["commit": .string(build.commit), "short": .string(build.short), "tree": .string(build.tree)])
        }
        return try await call("hello", .object(params))
    }

    func listThreads(include: [ThreadListScope] = [.inbox]) async throws -> [ThreadSummary] {
        let params: JSONValue = .object(["include": .array(include.map { .string($0.rawValue) })])
        return try await call("threads.list", params, as: ThreadsResult.self).threads
    }

    func searchThreads(_ query: String, limit: Int? = nil) async throws -> [ThreadSummary] {
        var params: [String: JSONValue] = ["query": .string(query)]
        if let limit { params["limit"] = .number(Double(limit)) }
        return try await call("threads.search", .object(params), as: ThreadsResult.self).threads
    }

    func createThread(_ request: NewThreadRequest) async throws -> ThreadSummary {
        var params: [String: JSONValue] = ["text": .string(request.text)]
        if !request.images.isEmpty { params["images"] = .array(request.images.map(\.jsonValue)) }
        if let cwd = request.cwd { params["cwd"] = .string(cwd) }
        if let accountId = request.accountId { params["accountId"] = .string(accountId) }
        if let poolId = request.poolId { params["poolId"] = .string(poolId) }
        if let model = request.model { params["model"] = .string(model) }
        if let effort = request.effort { params["effort"] = .string(effort) }
        if let mode = request.permissionMode { params["permissionMode"] = .string(mode.rawValue) }
        if let title = request.title { params["title"] = .string(title) }
        if let runnerId = request.runnerId { params["runnerId"] = .string(runnerId) }
        return try await call("threads.create", .object(params), as: ThreadResult.self, timeout: RPCClient.sendTimeout).thread
    }

    /// The tour's sample threads (protocol `threads.samples`), made in
    /// `cwd` unless they're there already; `remove` deletes them all.
    @discardableResult
    func samples(cwd: String, remove: Bool = false) async throws -> [ThreadSummary] {
        var params: [String: JSONValue] = ["cwd": .string(cwd)]
        if remove { params["remove"] = .bool(true) }
        return try await call("threads.samples", .object(params), as: ThreadsResult.self).threads
    }

    @discardableResult
    func send(threadId: String, text: String, images: [ImageRef] = [], answers: [AskAnswer] = []) async throws -> String? {
        var params: [String: JSONValue] = ["threadId": .string(threadId), "text": .string(text)]
        if !images.isEmpty { params["images"] = .array(images.map(\.jsonValue)) }
        // The card's answers it carries, for the bubble (docs/protocol.md, "Needs you").
        if !answers.isEmpty {
            params["answers"] = .array(answers.map { .object(["action": .string($0.action), "answer": .string($0.answer)]) })
        }
        return try await call("threads.send", .object(params), as: TurnResult.self, timeout: RPCClient.sendTimeout).turnId
    }

    /// A send or a new thread waits longer than the usual 30 s: on a Mac
    /// loaded with renders and backups the runner's event loop has stalled
    /// for 35 s, and giving up then put the draft back in the box while
    /// the runner went on to send it anyway (twice, once Mike sent it
    /// again). The app shows the message on its way meanwhile, and a
    /// dropped connection still fails it at once.
    static var sendTimeout: Duration { .seconds(120) }

    /// Replaces the message at `seq` and carries on from there: the runner
    /// stops the thread, cuts it back to before that message, undoes the
    /// agent's file changes since and sends `text` as a new turn
    /// (docs/protocol.md, "Editing a message"). It answers once the new
    /// turn has started, which can take a while: a turn to stop, a CLI to
    /// start for the files.
    @discardableResult
    /// While background work runs it fails with `RPCError.backgroundRunning`
    /// unless `stopBackground`, as going back stops it.
    func editMessage(threadId: String, seq: Int, text: String, images: [ImageRef] = [], stopBackground: Bool = false) async throws -> String? {
        var params: [String: JSONValue] = ["threadId": .string(threadId), "seq": .number(Double(seq)), "text": .string(text)]
        if !images.isEmpty { params["images"] = .array(images.map(\.jsonValue)) }
        if stopBackground { params["stopBackground"] = .bool(true) }
        return try await call("threads.edit", .object(params), as: TurnResult.self, timeout: .seconds(120)).turnId
    }

    /// Draws an image panel (the Simulator's screenshot) or fills a list
    /// panel. Slow: it waits for simctl or the patch's function (20 s at
    /// most).
    func renderPanel(threadId: String, panelId: String) async throws -> PanelRender {
        try await call("panels.render", .object(["threadId": .string(threadId), "panelId": .string(panelId)]), as: PanelRender.self, timeout: .seconds(30))
    }

    /// Cloud deployments for the panel's project, resolved by its CLI.
    func convexPanelDeployments(threadId: String, panelId: String, refresh: Bool = false) async throws -> ConvexDeployments {
        try await call("panels.convexDeployments", .object(["threadId": .string(threadId), "panelId": .string(panelId), "refresh": .bool(refresh)]), as: ConvexDeployments.self, timeout: .seconds(150))
    }

    /// Starts signing the runner's Convex CLI in, or with `check`, says how
    /// the sign-in going is getting on. Answers once the CLI has printed
    /// the page to approve it on.
    func convexPanelLogin(threadId: String, panelId: String, check: Bool = false, force: Bool = false) async throws -> ConvexLogin {
        var params: [String: JSONValue] = ["threadId": .string(threadId), "panelId": .string(panelId)]
        if check { params["check"] = .bool(true) }
        if force { params["force"] = .bool(true) }
        return try await call("panels.convexLogin", .object(params), as: ConvexLogin.self, timeout: .seconds(60))
    }

    /// A deploy key for a Convex panel's embedded dashboard. Slow the first
    /// time for a deployment, while the runner has the Convex CLI make one.
    func convexPanelKey(threadId: String, panelId: String, deployment: String? = nil, renew: Bool = false) async throws -> ConvexPanelKey {
        var params: [String: JSONValue] = ["threadId": .string(threadId), "panelId": .string(panelId)]
        if let deployment { params["deployment"] = .string(deployment) }
        if renew { params["renew"] = .bool(true) }
        return try await call("panels.convexKey", .object(params), as: ConvexPanelKey.self, timeout: .seconds(150))
    }

    /// What the thread has made, shared and pinned (docs/protocol.md,
    /// "Highlights"). A runner from before highlights answers `-32601`.
    func threadHighlights(threadId: String) async throws -> ThreadHighlights {
        try await call("threads.highlights", .object(["threadId": .string(threadId)]), as: ThreadHighlights.self)
    }

    /// The slash commands the thread can run, for the composer's palette
    /// (docs/protocol.md, "Slash commands"). The first ask for a folder
    /// starts a CLI to list them, which takes a second or two.
    func threadCommands(threadId: String) async throws -> [SlashCommand] {
        try await call("threads.commands", .object(["threadId": .string(threadId)]), as: SlashCommandList.self, timeout: .seconds(30)).commands
    }

    /// Asks the small model about words selected in the thread (see
    /// "Explain"). The pool's CLI can take a few seconds to start.
    func explain(_ session: ExplainSession, threadId: String, turn index: Int) async throws -> ExplainResult {
        try await call("threads.explain", session.params(threadId: threadId, for: index), as: ExplainResult.self, timeout: .seconds(75))
    }

    /// Hibernates a thread until when Mike said, in his own words ("at the
    /// weekend", "next time I talk about woodworking"). The runner puts it
    /// away at once and answers once Opus has worked out when, which on
    /// the pool's CLI can take a while.
    func hibernateWhen(threadId: String, said: String) async throws -> ThreadSummary {
        try await call("threads.hibernateWhen", .object(["threadId": .string(threadId), "said": .string(said)]), as: ThreadResult.self, timeout: .seconds(150)).thread
    }

    /// Takes one off the list for good: a later mention doesn't bring it back.
    func removeHighlight(threadId: String, highlightId: String) async throws -> ThreadSummary {
        try await call("threads.removeHighlight", .object(["threadId": .string(threadId), "highlightId": .string(highlightId)]), as: ThreadResult.self).thread
    }

    /// The thread's panel request (show_panel) is showing now, which clears
    /// it. Another id changes nothing.
    func panelShown(threadId: String, requestId: String) async throws -> ThreadSummary {
        try await call("threads.panelShown", .object(["threadId": .string(threadId), "requestId": .string(requestId)]), as: ThreadResult.self).thread
    }

    /// Runs an action from the thread's patches. A command action answers
    /// when the command has finished. Land has an hour for queueing and
    /// checking; other commands have ten minutes. Allow a minute for the reply.
    func runAction(threadId: String, actionId: String) async throws -> ActionRunResult {
        let minutes = actionId == "worktree.land" ? 61 : 11
        return try await call("actions.run", .object(["threadId": .string(threadId), "actionId": .string(actionId)]), as: ActionRunResult.self, timeout: .seconds(minutes * 60))
    }

    /// Trusts the versions of the thread's waiting patch files that were
    /// shown (by hash), so they load (docs/protocol.md, "Trusting a
    /// folder's patches").
    func trustPatches(threadId: String, files: [(file: String, hash: String)]) async throws {
        let list = files.map { JSONValue.object(["file": .string($0.file), "hash": .string($0.hash)]) }
        _ = try await call("patches.trust", .object(["threadId": .string(threadId), "files": .array(list)]), as: EmptyResult.self)
    }

    func interrupt(threadId: String) async throws {
        _ = try await call("threads.interrupt", .object(["threadId": .string(threadId)]), as: EmptyResult.self)
    }

    func updateThread(_ threadId: String, _ update: ThreadUpdate) async throws -> ThreadSummary {
        var params = update.params
        params["threadId"] = .string(threadId)
        return try await call("threads.update", .object(params), as: ThreadResult.self).thread
    }

    func events(threadId: String, afterSeq: Int? = nil, beforeSeq: Int? = nil, limit: Int? = nil) async throws -> EventsPage {
        var params: [String: JSONValue] = ["threadId": .string(threadId)]
        if let afterSeq { params["afterSeq"] = .number(Double(afterSeq)) }
        if let beforeSeq { params["beforeSeq"] = .number(Double(beforeSeq)) }
        if let limit { params["limit"] = .number(Double(limit)) }
        return try await call("threads.events", .object(params), as: EventsPage.self, timeout: .seconds(60))
    }

    func subscribe(threadId: String, afterSeq: Int? = nil) async throws -> SubscribeResult {
        var params: [String: JSONValue] = ["threadId": .string(threadId)]
        if let afterSeq { params["afterSeq"] = .number(Double(afterSeq)) }
        return try await call("threads.subscribe", .object(params), as: SubscribeResult.self, timeout: .seconds(60))
    }

    /// What a sub-agent has done so far, from the CLI's own record of it.
    /// `-32006` when there's no record.
    func subagent(threadId: String, subagentId: String) async throws -> SubagentTranscript {
        try await call("threads.subagent", .object(["threadId": .string(threadId), "subagentId": .string(subagentId)]), as: SubagentTranscript.self, timeout: .seconds(30))
    }

    func unsubscribe(threadId: String) async throws {
        _ = try await call("threads.unsubscribe", .object(["threadId": .string(threadId)]), as: EmptyResult.self)
    }

    func markSeen(threadId: String, seq: Int) async throws -> ThreadSummary {
        try await call("threads.markSeen", .object(["threadId": .string(threadId), "seq": .number(Double(seq))]), as: ThreadResult.self).thread
    }

    /// Ticks or unticks one ask on the open card. Sends nothing to the agent.
    /// Whether anyone with the link can read the thread on the website
    /// (protocol "Sharing"). `newLink` makes a fresh link, which stops the
    /// old one.
    func share(threadId: String, access: ThreadShare.Access, newLink: Bool = false) async throws -> ThreadSummary {
        var params: [String: JSONValue] = ["threadId": .string(threadId), "access": .string(access.rawValue)]
        if newLink { params["newLink"] = .bool(true) }
        return try await call("threads.share", .object(params), as: ThreadResult.self).thread
    }

    func tickAsk(threadId: String, asksSeq: Int, index: Int, ticked: Bool) async throws -> ThreadSummary {
        try await call("threads.tickAsk", .object([
            "threadId": .string(threadId), "asksSeq": .number(Double(asksSeq)), "index": .number(Double(index)), "ticked": .bool(ticked),
        ]), as: ThreadResult.self).thread
    }

    func respond(threadId: String, approvalId: String, decision: ApprovalDecision, message: String? = nil, answers: [String: String]? = nil) async throws {
        var params: [String: JSONValue] = [
            "threadId": .string(threadId),
            "approvalId": .string(approvalId),
            "decision": .string(decision.rawValue),
        ]
        if let message { params["message"] = .string(message) }
        if let answers { params["answers"] = .object(answers.mapValues { .string($0) }) }
        _ = try await call("approvals.respond", .object(params), as: EmptyResult.self)
    }

    /// Another runner's request for a new thread, as it was filed
    /// (docs/protocol.md, "Asking another runner"). Only this Mac's own
    /// runner, with the owner key, can read and answer it.
    func startRequest(threadId: String, approvalId: String) async throws -> StartRequest {
        try await call("requests.get", .object(["threadId": .string(threadId), "approvalId": .string(approvalId)]), as: StartRequest.self)
    }

    /// Starts it (on `runnerId`) or says no, then answers its card.
    func answerStartRequest(threadId: String, approvalId: String, allow: Bool, runnerId: String?, fingerprint: String?) async throws {
        var params: [String: JSONValue] = ["threadId": .string(threadId), "approvalId": .string(approvalId), "allow": .bool(allow)]
        if let runnerId { params["runnerId"] = .string(runnerId) }
        if let fingerprint { params["fingerprint"] = .string(fingerprint) }
        _ = try await call("requests.answer", .object(params), as: JSONValue.self)
    }

    /// Go ahead on a "Plan first" plan (docs/protocol.md, "Plan first").
    func approvePlan(threadId: String, itemId: String) async throws {
        _ = try await call("plans.approve", .object(["threadId": .string(threadId), "itemId": .string(itemId)]), as: EmptyResult.self)
    }

    /// Answers a `secret.requested` card (docs/protocol.md, "Secrets").
    /// The value goes in this one request and nowhere else: not logged,
    /// not kept, not retried.
    func answerSecret(threadId: String, approvalId: String, _ answer: SecretAnswer) async throws {
        _ = try await call("secrets.answer", .object(answer.params(threadId: threadId, approvalId: approvalId)), as: EmptyResult.self)
    }

    func importMedia(path: String) async throws -> ImageRef {
        try await call("media.import", .object(["path": .string(path)]), as: MediaImportResult.self).image
    }
}

// MARK: Usage history (docs/protocol.md, "Usage history")

public extension RPCClient {
    /// Each login's tokens by the hour and its limit readings over time.
    /// `-32601` from a runner older than it: the panel shows no charts.
    func usageStats(days: Int = 8) async throws -> UsageStats {
        try await call("usage.stats", .object(["days": .number(Double(days))]), as: UsageStats.self)
    }
}

// MARK: CLIs (docs/protocol.md, "CLI requests")

/// Each CLI request returns at once with the state when it arrived; the
/// progress of a check or an update comes through `clis.updated`. A runner
/// older than step 4 answers `-32601`, which callers read as "no CLI info"
/// rather than an error.
public extension RPCClient {
    func listClis() async throws -> [CliStatus] {
        try await call("clis.list", .object([:]), as: ClisResult.self).clis
    }

    /// Starts a check now; nil checks both.
    func checkClis(provider: String? = nil) async throws -> [CliStatus] {
        var params: [String: JSONValue] = [:]
        if let provider { params["provider"] = .string(provider) }
        return try await call("clis.check", .object(params), as: ClisResult.self).clis
    }

    /// Starts an update. `version` picks a kept Codex version (this is
    /// "Go back"); `force` installs past a hold ("Update anyway").
    func updateCli(provider: String, version: String? = nil, force: Bool = false) async throws -> [CliStatus] {
        var params: [String: JSONValue] = ["provider": .string(provider)]
        if let version { params["version"] = .string(version) }
        if force { params["force"] = .bool(true) }
        return try await call("clis.update", .object(params), as: ClisResult.self).clis
    }

    /// "auto", "notify" or "off".
    func setCliPolicy(provider: String, policy: String) async throws -> [CliStatus] {
        try await call("clis.setPolicy", .object(["provider": .string(provider), "policy": .string(policy)]), as: ClisResult.self).clis
    }
}

public struct ClisResult: Sendable, Decodable {
    public var clis: [CliStatus]

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        clis = c.lossyArray(CliStatus.self, forKey: .clis)
    }

    enum CodingKeys: String, CodingKey { case clis }
}

public enum ThreadListScope: String, Sendable, CaseIterable {
    case inbox, snoozed, archived
}

public struct NewThreadRequest: Sendable, Hashable {
    public var text: String
    public var images: [ImageRef]
    public var cwd: String?
    public var accountId: String?
    /// The pool that picks its login. With `accountId` too, the runner
    /// pins it to that login instead.
    public var poolId: String?
    public var model: String?
    public var effort: String?
    public var permissionMode: PermissionMode?
    public var title: String?
    /// Another runner, when this Mac's runner makes it there through
    /// Convex (docs/protocol.md, "Other runners' threads through the backend").
    public var runnerId: String?

    public init(text: String, images: [ImageRef] = [], cwd: String? = nil, accountId: String? = nil, poolId: String? = nil, model: String? = nil, effort: String? = nil, permissionMode: PermissionMode? = nil, title: String? = nil) {
        self.text = text
        self.images = images
        self.cwd = cwd
        self.accountId = accountId
        self.poolId = poolId
        self.model = model
        self.effort = effort
        self.permissionMode = permissionMode
        self.title = title
    }
}

/// How it went, from the done card's Archive menu (`threads.update`'s
/// `verdict`), so a thread put away on purpose reads differently from one
/// that was just cleared away (Mike, 5 Nov).
public enum ArchiveVerdict: String, Sendable, Hashable, Codable, CaseIterable {
    case worked, didntWork, notNeeded

    public var label: String {
        switch self {
        case .worked: "Worked"
        case .didntWork: "Didn't work"
        case .notNeeded: "Not needed"
        }
    }

    public var symbol: String {
        switch self {
        case .worked: "checkmark"
        case .didntWork: "xmark"
        case .notNeeded: "minus"
        }
    }
}

/// Fields for `threads.update`. A nil property is left out; the double
/// optionals send an explicit `null` to clear a value.
public struct ThreadUpdate: Sendable, Hashable {
    public var title: String?
    public var cwd: String?
    public var accountId: String?
    public var model: String??
    public var effort: String??
    public var permissionMode: PermissionMode?
    public var snoozedUntil: Date??
    /// Hibernate until the runner next starts (`snoozedUntil: "restart"`).
    /// Wins over `snoozedUntil`.
    public var snoozeUntilRestart: Bool
    public var archived: Bool?
    /// With `archived: true`: Mike's pick from the done card's Archive
    /// menu, kept on the thread as how it went (`verdict`).
    public var verdict: ArchiveVerdict?
    public var starred: Bool?
    /// A pool id moves the thread into that pool (and onto one of its
    /// logins at once if its current one isn't in it); `.some(nil)` sends
    /// null, which pins it to the login it's on. `accountId` pins too.
    public var poolId: String??

    public init(title: String? = nil, cwd: String? = nil, accountId: String? = nil, model: String?? = nil, effort: String?? = nil, permissionMode: PermissionMode? = nil, snoozedUntil: Date?? = nil, snoozeUntilRestart: Bool = false, archived: Bool? = nil, verdict: ArchiveVerdict? = nil, starred: Bool? = nil, poolId: String?? = nil) {
        self.verdict = verdict
        self.title = title
        self.cwd = cwd
        self.accountId = accountId
        self.poolId = poolId
        self.model = model
        self.effort = effort
        self.permissionMode = permissionMode
        self.snoozedUntil = snoozedUntil
        self.snoozeUntilRestart = snoozeUntilRestart
        self.archived = archived
        self.starred = starred
    }

    public var params: [String: JSONValue] {
        var params: [String: JSONValue] = [:]
        if let title { params["title"] = .string(title) }
        if let cwd { params["cwd"] = .string(cwd) }
        if let accountId { params["accountId"] = .string(accountId) }
        if let model { params["model"] = model.map { .string($0) } ?? .null }
        if let effort { params["effort"] = effort.map { .string($0) } ?? .null }
        if let permissionMode { params["permissionMode"] = .string(permissionMode.rawValue) }
        if snoozeUntilRestart {
            params["snoozedUntil"] = .string("restart")
        } else if let snoozedUntil {
            params["snoozedUntil"] = snoozedUntil.map { .string(ISO8601.format($0)) } ?? .null
        }
        if let archived { params["archived"] = .bool(archived) }
        if archived == true, let verdict { params["verdict"] = .string(verdict.rawValue) }
        if let starred { params["starred"] = .bool(starred) }
        if let poolId { params["poolId"] = poolId.map { .string($0) } ?? .null }
        return params
    }

    /// The summary as it will be once the runner has made this change, for
    /// the parts it's safe to guess, so a click on Archive, Snooze or a
    /// permission or model pick shows straight away rather than after a
    /// busy runner answers. The runner's reply replaces it either way. A
    /// folder, login or pool change is left to the runner: it can move the
    /// thread to another provider and reset other settings with it.
    public func applied(to thread: ThreadSummary, now: Date = Date()) -> ThreadSummary {
        var thread = thread
        if let title, !title.isEmpty { thread.title = title }
        if let permissionMode { thread.permissionMode = permissionMode }
        if accountId == nil, poolId == nil {
            if let model { thread.model = model }
            if let effort { thread.effort = effort }
        }
        if snoozeUntilRestart {
            thread.snoozedUntil = .distantFuture
            thread.snoozedUntilRestart = true
        } else if let snoozedUntil {
            thread.snoozedUntil = snoozedUntil
            thread.snoozedUntilRestart = false
            if snoozedUntil == nil { thread.wakeWhen = nil; thread.waitingOn = nil }
        }
        if let archived { thread.archivedAt = archived ? (thread.archivedAt ?? now) : nil }
        if let starred { thread.starredAt = starred ? (thread.starredAt ?? now) : nil }
        return thread
    }
}

public struct ThreadsResult: Sendable, Decodable {
    public var threads: [ThreadSummary]

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        threads = try c.decodeIfPresent(LossyArray<ThreadSummary>.self, forKey: .threads)?.elements ?? []
    }

    enum CodingKeys: String, CodingKey { case threads }
}

public struct ThreadResult: Sendable, Decodable {
    public var thread: ThreadSummary
}

public struct TurnResult: Sendable, Decodable {
    public var turnId: String?
}

public struct SubscribeResult: Sendable, Decodable {
    public var events: [Event]
    /// Text streamed so far for items still streaming (an older runner
    /// leaves it out).
    public var inProgress: [EventsPage.InProgress]

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        events = try c.decodeIfPresent(LossyArray<Event>.self, forKey: .events)?.elements ?? []
        inProgress = c.lossyArray(EventsPage.InProgress.self, forKey: .inProgress)
    }

    enum CodingKeys: String, CodingKey { case events, inProgress }
}

public struct MediaImportResult: Sendable, Decodable {
    public var image: ImageRef
}

extension ImageRef {
    public var jsonValue: JSONValue {
        var object: [String: JSONValue] = ["path": .string(path), "mediaType": .string(mediaType)]
        if let width { object["width"] = .number(Double(width)) }
        if let height { object["height"] = .number(Double(height)) }
        return .object(object)
    }
}

// MARK: Schedules (docs/protocol.md, "Schedules")

public extension RPCClient {
    func listSchedules(threadId: String? = nil) async throws -> [Schedule] {
        var params: [String: JSONValue] = [:]
        if let threadId { params["threadId"] = .string(threadId) }
        return try await call("schedules.list", .object(params), as: SchedulesResult.self).schedules
    }

    func createSchedule(_ request: NewScheduleRequest) async throws -> Schedule {
        try await call("schedules.create", .object(request.params), as: ScheduleResult.self).schedule
    }

    func updateSchedule(_ scheduleId: String, _ update: ScheduleUpdate) async throws -> Schedule {
        var params = update.params
        params["scheduleId"] = .string(scheduleId)
        return try await call("schedules.update", .object(params), as: ScheduleResult.self).schedule
    }

    func deleteSchedule(_ scheduleId: String) async throws {
        _ = try await call("schedules.delete", .object(["scheduleId": .string(scheduleId)]), as: EmptyResult.self)
    }

    /// The runners a schedule can be put on, this one first. A runner from
    /// before step 6 answers -32601, which means just itself: no choice to
    /// offer, so an empty list.
    func listRunners() async throws -> [RunnerInfo] {
        do {
            return try await call("runners.list", .object([:]), as: RunnersResult.self).runners
        } catch RPCError.server(let code, _) where code == RPCError.methodNotFound {
            return []
        }
    }

    /// Other runners' threads for the sidebar (docs/protocol.md, "Other
    /// runners' threads"). A runner from before them answers -32601, which
    /// is none: the sidebar has only this Mac's.
    /// Another runner's logins for the composer's pickers, from Convex
    /// through this Mac's runner (`remoteThreads.logins`).
    func remoteLogins(runnerId: String) async throws -> RunnerLogins {
        struct Reply: Decodable {
            var accounts: [Account]
            var pools: [Pool]?
            var defaults: RunnerDefaults
        }
        let reply = try await call("remoteThreads.logins", .object(["runnerId": .string(runnerId)]), as: Reply.self)
        return RunnerLogins(accounts: reply.accounts, pools: reply.pools ?? [], defaults: reply.defaults)
    }

    func remoteThreads() async throws -> RemoteThreads {
        do {
            return try await call("remoteThreads.list", .object([:]), as: RemoteThreads.self)
        } catch RPCError.server(let code, _) where code == RPCError.methodNotFound {
            return RemoteThreads()
        }
    }

    /// Puts the runners in this order (every runner's id, this one's too):
    /// the one order the phone sets as well. It comes back in
    /// `remoteThreads.updated`.
    func setRunnerOrder(_ runnerIds: [String]) async throws {
        _ = try await call("runners.setOrder", .object(["runnerIds": .array(runnerIds.map { .string($0) })]), as: EmptyResult.self)
    }

    /// Runs it now, as if it were due, even when paused. Another runner's
    /// schedule comes back `queued`, with no thread: that runner runs it.
    func runSchedule(_ scheduleId: String) async throws -> ScheduleRunResult {
        try await call("schedules.run", .object(["scheduleId": .string(scheduleId)]), as: ScheduleRunResult.self)
    }

    /// What a cron or time means and when it would next run, for the
    /// editor to show as Mike types. A cron it can't read is `-32602`.
    func previewSchedule(_ when: ScheduleWhen, timezone: String? = nil, count: Int = 3) async throws -> SchedulePreview {
        var params = when.params
        if let timezone { params["timezone"] = .string(timezone) }
        params["count"] = .number(Double(count))
        return try await call("schedules.preview", .object(params), as: SchedulePreview.self)
    }
}

/// When a schedule runs: once, or on a cron.
public enum ScheduleWhen: Sendable, Hashable {
    case at(Date)
    case cron(String)

    public var params: [String: JSONValue] {
        switch self {
        case .at(let date): return ["at": .string(ISO8601.format(date))]
        case .cron(let cron): return ["cron": .string(cron)]
        }
    }
}

public struct NewScheduleRequest: Sendable, Hashable {
    public var text: String
    public var title: String?
    public var when: ScheduleWhen
    /// Sends here; nil starts a new thread each time with the settings below.
    public var threadId: String?
    public var cwd: String?
    public var accountId: String?
    /// The pool that picks each run's login, instead of `accountId`.
    public var poolId: String?
    public var model: String?
    public var effort: String?
    public var permissionMode: PermissionMode?
    /// Another runner's id (or name) from `runners.list`; nil is this one.
    /// Only for a new thread each time: a thread's schedule runs where it is.
    public var runnerId: String?

    public init(text: String, title: String? = nil, when: ScheduleWhen, threadId: String? = nil, cwd: String? = nil,
                accountId: String? = nil, poolId: String? = nil, model: String? = nil, effort: String? = nil,
                permissionMode: PermissionMode? = nil, runnerId: String? = nil) {
        self.text = text
        self.title = title
        self.when = when
        self.threadId = threadId
        self.cwd = cwd
        self.accountId = accountId
        self.poolId = poolId
        self.model = model
        self.effort = effort
        self.permissionMode = permissionMode
        self.runnerId = runnerId
    }

    public var params: [String: JSONValue] {
        var params = when.params
        params["text"] = .string(text)
        if let title { params["title"] = .string(title) }
        if let threadId {
            params["threadId"] = .string(threadId)
        } else {
            // New-thread settings only mean something without a thread.
            if let cwd { params["cwd"] = .string(cwd) }
            // The runner takes one or the other; a pool picks the login.
            if let poolId { params["poolId"] = .string(poolId) } else if let accountId { params["accountId"] = .string(accountId) }
            if let model { params["model"] = .string(model) }
            if let effort { params["effort"] = .string(effort) }
            if let permissionMode { params["permissionMode"] = .string(permissionMode.rawValue) }
            if let runnerId { params["runnerId"] = .string(runnerId) }
        }
        return params
    }
}

/// Fields for `schedules.update`; nil ones are left out. The target thread
/// can't change (the runner says to make a new schedule).
public struct ScheduleUpdate: Sendable, Hashable {
    public var title: String?
    public var text: String?
    public var when: ScheduleWhen?
    public var paused: Bool?
    public var cwd: String?

    public init(title: String? = nil, text: String? = nil, when: ScheduleWhen? = nil, paused: Bool? = nil, cwd: String? = nil) {
        self.title = title
        self.text = text
        self.when = when
        self.paused = paused
        self.cwd = cwd
    }

    public var params: [String: JSONValue] {
        var params = when?.params ?? [:]
        if let title { params["title"] = .string(title) }
        if let text { params["text"] = .string(text) }
        if let paused { params["paused"] = .bool(paused) }
        if let cwd { params["cwd"] = .string(cwd) }
        return params
    }
}

public struct SchedulesResult: Sendable, Decodable {
    public var schedules: [Schedule]

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        schedules = c.lossyArray(Schedule.self, forKey: .schedules)
    }

    enum CodingKeys: String, CodingKey { case schedules }
}

public struct ScheduleResult: Sendable, Decodable {
    public var schedule: Schedule
}

public struct ScheduleRunResult: Sendable, Decodable {
    public var schedule: Schedule
    /// The thread it sent to or started; nil when it was `queued`.
    public var threadId: String?
    public var turnId: String?
    /// Another runner's schedule: asked of that runner, which runs it when
    /// it next hears (the schedule's `runRequestedAt` until then).
    public var queued: Bool

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        schedule = try c.decode(Schedule.self, forKey: .schedule)
        threadId = try? c.decodeIfPresent(String.self, forKey: .threadId)
        turnId = try? c.decodeIfPresent(String.self, forKey: .turnId)
        queued = (try? c.decodeIfPresent(Bool.self, forKey: .queued)) ?? false
    }

    enum CodingKeys: String, CodingKey { case schedule, threadId, turnId, queued }
}

public struct RunnersResult: Sendable, Decodable {
    public var runners: [RunnerInfo]

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        runners = c.lossyArray(RunnerInfo.self, forKey: .runners)
    }

    enum CodingKeys: String, CodingKey { case runners }
}

// MARK: Projects and the librarian (docs/protocol.md, "Projects")

/// A runner from before projects answers these with `-32601`, which callers
/// read as "no projects here" and hide them.
public extension RPCClient {
    /// Newest activity first; archived ones only (all of them) with `archived`.
    func listProjects(archived: Bool = false) async throws -> [Project] {
        var params: [String: JSONValue] = [:]
        if archived { params["archived"] = .bool(true) }
        return try await call("projects.list", .object(params), as: ProjectsResult.self).projects
    }

    func getProject(_ projectId: String) async throws -> ProjectGetResult {
        try await call("projects.get", .object(["projectId": .string(projectId)]), as: ProjectGetResult.self)
    }

    func createProject(_ request: NewProjectRequest) async throws -> Project {
        try await call("projects.create", .object(request.params), as: ProjectResult.self).project
    }

    func updateProject(_ projectId: String, _ update: ProjectUpdate) async throws -> Project {
        var params = update.params
        params["projectId"] = .string(projectId)
        return try await call("projects.update", .object(params), as: ProjectResult.self).project
    }

    /// Reads the project's Notion board again (unless it was read in the
    /// last minute; `force` reads it anyway) and gives the project back.
    func refreshProjectTasks(_ projectId: String, force: Bool = false) async throws -> Project {
        try await call("projects.refreshTasks", .object(["projectId": .string(projectId), "force": .bool(force)]), as: ProjectResult.self).project
    }

    /// Mike's icon for a project: a picture file, an SF Symbol, or neither
    /// for automatic again (the librarian finds one).
    func setProjectIcon(_ projectId: String, path: String? = nil, symbol: String? = nil) async throws -> Project {
        var params: [String: JSONValue] = ["projectId": .string(projectId)]
        if let path { params["path"] = .string(path) }
        if let symbol { params["symbol"] = .string(symbol) }
        return try await call("projects.setIcon", .object(params), as: ProjectResult.self).project
    }

    /// Moves `projectId`'s folders and threads into `intoId` and deletes it.
    func mergeProject(_ projectId: String, into intoId: String) async throws -> Project {
        try await call("projects.merge", .object(["projectId": .string(projectId), "intoId": .string(intoId)]), as: ProjectResult.self).project
    }

    func deleteProject(_ projectId: String) async throws {
        _ = try await call("projects.delete", .object(["projectId": .string(projectId)]), as: EmptyResult.self)
    }

    /// What Mike does by hand: an added project is pinned, a removed one is
    /// never put back by the librarian.
    func setThreadProjects(_ threadId: String, add: [String] = [], remove: [String] = []) async throws -> ThreadSummary {
        try await call("threads.setProjects", .object(SetProjectsRequest(threadId: threadId, add: add, remove: remove).params), as: ThreadResult.self).thread
    }

    func librarianStatus() async throws -> LibrarianStatus {
        try await call("librarian.status", .object([:]), as: LibrarianResult.self).librarian
    }

    /// A look at one thread now, or with none a backfill over every thread
    /// it has never looked at.
    func runLibrarian(threadId: String? = nil) async throws -> LibrarianStatus {
        var params: [String: JSONValue] = [:]
        if let threadId { params["threadId"] = .string(threadId) }
        return try await call("librarian.run", .object(params), as: LibrarianResult.self).librarian
    }

    func updateLibrarian(paused: Bool) async throws -> LibrarianStatus {
        try await call("librarian.update", .object(["paused": .bool(paused)]), as: LibrarianResult.self).librarian
    }
}

// MARK: Connectors (docs/protocol.md, "Connectors")

/// A runner from before Connectors answers `-32601`, which the app reads as
/// "no Connectors panel".
public extension RPCClient {
    /// What the runner last heard from the gateway, or with `refresh` a
    /// fresh answer (unless it asked in the last few seconds).
    func connectorsStatus(refresh: Bool = false) async throws -> ConnectorsStatus {
        var params: [String: JSONValue] = [:]
        if refresh { params["refresh"] = .bool(true) }
        return try await call("connectors.status", .object(params), as: ConnectorsResult.self).connectors
    }
}

public struct NewProjectRequest: Sendable, Hashable {
    public var title: String
    public var folders: [String]
    public var goals: String?
    public var threadIds: [String]

    public init(title: String, folders: [String] = [], goals: String? = nil, threadIds: [String] = []) {
        self.title = title
        self.folders = folders
        self.goals = goals
        self.threadIds = threadIds
    }

    public var params: [String: JSONValue] {
        var params: [String: JSONValue] = ["title": .string(title)]
        if !folders.isEmpty { params["folders"] = .array(folders.map { .string($0) }) }
        if let goals { params["goals"] = .string(goals) }
        if !threadIds.isEmpty { params["threadIds"] = .array(threadIds.map { .string($0) }) }
        return params
    }
}

/// Fields for `projects.update`; nil ones are left out, and what's given
/// replaces what was there.
public struct ProjectUpdate: Sendable, Hashable {
    public var title: String?
    public var folders: [String]?
    public var goals: String?
    public var state: String?
    public var notes: String?
    public var archived: Bool?
    /// A Notion page with the project's task board; empty takes it off.
    public var notion: String?

    public init(title: String? = nil, folders: [String]? = nil, goals: String? = nil, state: String? = nil, notes: String? = nil, archived: Bool? = nil, notion: String? = nil) {
        self.title = title
        self.folders = folders
        self.goals = goals
        self.state = state
        self.notes = notes
        self.archived = archived
        self.notion = notion
    }

    public var params: [String: JSONValue] {
        var params: [String: JSONValue] = [:]
        if let title { params["title"] = .string(title) }
        if let folders { params["folders"] = .array(folders.map { .string($0) }) }
        if let goals { params["goals"] = .string(goals) }
        if let state { params["state"] = .string(state) }
        if let notes { params["notes"] = .string(notes) }
        if let archived { params["archived"] = .bool(archived) }
        if let notion { params["notion"] = .string(notion) }
        return params
    }

    /// The project as it will be once the runner has made this change, so
    /// a save shows straight away however slow the runner is. Its reply
    /// replaces the guess. A different Notion page has a board nobody has
    /// read yet, so the old one goes.
    public func applied(to project: Project, now: Date = Date()) -> Project {
        var project = project
        if let title, !title.isEmpty { project.title = title }
        if let folders { project.folders = folders }
        if let goals { project.goals = goals }
        if let state {
            project.state = state
            project.stateUpdatedAt = now
        }
        if let notes { project.notes = notes }
        if let archived { project.archived = archived }
        if let notion {
            let link = notion.isEmpty ? nil : notion
            if link != project.notion { project.tasks = nil }
            project.notion = link
        }
        return project
    }
}

public struct SetProjectsRequest: Sendable, Hashable {
    public var threadId: String
    public var add: [String]
    public var remove: [String]

    public init(threadId: String, add: [String] = [], remove: [String] = []) {
        self.threadId = threadId
        self.add = add
        self.remove = remove
    }

    public var params: [String: JSONValue] {
        var params: [String: JSONValue] = ["threadId": .string(threadId)]
        if !add.isEmpty { params["add"] = .array(add.map { .string($0) }) }
        if !remove.isEmpty { params["remove"] = .array(remove.map { .string($0) }) }
        return params
    }
}

public struct ProjectsResult: Sendable, Decodable {
    public var projects: [Project]

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        projects = c.lossyArray(Project.self, forKey: .projects)
    }

    enum CodingKeys: String, CodingKey { case projects }
}

public struct ProjectResult: Sendable, Decodable {
    public var project: Project
}

public struct ProjectGetResult: Sendable, Decodable {
    public var project: Project
    /// Its threads, newest activity first, put away ones included.
    public var threadIds: [String]

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        project = try c.decode(Project.self, forKey: .project)
        threadIds = c.lossyArray(String.self, forKey: .threadIds)
    }

    enum CodingKeys: String, CodingKey { case project, threadIds }
}

public struct LibrarianResult: Sendable, Decodable {
    public var librarian: LibrarianStatus
}

// MARK: Pools (docs/pools-plan.md, "Protocol")

/// A runner from before pools answers these with `-32601`; the app then
/// keeps its account chip and provider rail.
public extension RPCClient {
    func listPools() async throws -> [Pool] {
        try await call("pools.list", .object([:]), as: PoolsResult.self).pools
    }

    /// Replaces the whole list in runner.json. `-32602` for a duplicate id,
    /// a pool with no logins, or a login the runner doesn't have.
    func savePools(_ pools: [Pool]) async throws -> [Pool] {
        try await call("pools.save", .object(["pools": .array(pools.map(\.jsonValue))]), as: PoolsResult.self).pools
    }
}

public struct PoolsResult: Sendable, Decodable {
    public var pools: [Pool]

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        pools = c.lossyArray(Pool.self, forKey: .pools)
    }

    enum CodingKeys: String, CodingKey { case pools }
}

/// What Mike gave a secret card: the value, or no. Printing one (a log
/// line, a debugger's `po`) never shows the value.
public enum SecretAnswer: Sendable, CustomStringConvertible, CustomDebugStringConvertible, CustomReflectable {
    case secret(String)
    case decline

    public var description: String {
        switch self {
        case .secret: return "SecretAnswer.secret(<hidden>)"
        case .decline: return "SecretAnswer.decline"
        }
    }

    public var debugDescription: String { description }
    public var customMirror: Mirror { Mirror(self, children: [], displayStyle: .enum) }

    /// `secrets.answer`'s params: `secret` or `decline: true`, never both.
    public func params(threadId: String, approvalId: String) -> [String: JSONValue] {
        var params: [String: JSONValue] = ["threadId": .string(threadId), "approvalId": .string(approvalId)]
        switch self {
        case .secret(let value): params["secret"] = .string(value)
        case .decline: params["decline"] = .bool(true)
        }
        return params
    }

    /// Whether Save can send it: the runner refuses an empty or
    /// whitespace-only secret (-32602).
    public static func canSave(_ typed: String) -> Bool {
        !typed.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }
}
