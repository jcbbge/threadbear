import Foundation

/// Other runners' threads (docs/protocol.md, "Other runners' threads"):
/// what `remoteThreads.list` answers and `remoteThreads.updated` sends. The
/// runner reads them from the backend; the app lists them beside its own
/// runner's and, to open one, connects to that thread's runner itself
/// (`RemoteClients`). Runners never talk to each other.
public struct RemoteThreads: Sendable, Hashable, Decodable {
    public var runners: [RemoteRunner]
    public var threads: [RemoteThread]
    /// Mike's runner order (backend API 58): every runner's id, this one's
    /// too, the same order the phone sets. Nil from an older runner or
    /// backend, which has none to give.
    public var order: [String]?

    public init(runners: [RemoteRunner] = [], threads: [RemoteThread] = [], order: [String]? = nil) {
        self.runners = runners
        self.threads = threads
        self.order = order
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        runners = c.lossyArray(RemoteRunner.self, forKey: .runners)
        threads = c.lossyArray(RemoteThread.self, forKey: .threads)
        order = try? c.decodeIfPresent([String].self, forKey: .order)
    }

    enum CodingKeys: String, CodingKey { case runners, threads, order }

    public func runner(_ id: String) -> RemoteRunner? { runners.first { $0.id == id } }

    /// The threads as sidebar summaries, each marked with its runner.
    public var summaries: [ThreadSummary] { threads.map(\.summary) }
}

/// Another runner, as the backend knows it, and how to reach it from here.
public struct RemoteRunner: Sendable, Hashable, Decodable, Identifiable {
    public var id: String
    /// "bruce": its Mac's hostname by default.
    public var name: String
    /// An SF Symbol for its Mac ("macmini"), as `RunnerInfo.icon`.
    public var icon: String?
    /// Heard from in the last 3 minutes.
    public var online: Bool
    public var lastSeenAt: Date?
    /// Its `sync.rpcUrl`: a `wss://…/rpc` on the tailnet.
    public var rpcUrl: URL?
    /// Where this Mac keeps that runner's token, once it's been copied in.
    /// Nil means its threads can be listed but not opened.
    public var tokenFile: String?

    public init(id: String, name: String, icon: String? = nil, online: Bool = true, lastSeenAt: Date? = nil, rpcUrl: URL? = nil, tokenFile: String? = nil) {
        self.id = id
        self.name = name
        self.icon = icon
        self.online = online
        self.lastSeenAt = lastSeenAt
        self.rpcUrl = rpcUrl
        self.tokenFile = tokenFile
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        func text(_ key: CodingKeys) -> String? { ((try? c.decodeIfPresent(String.self, forKey: key)) ?? nil).flatMap { $0.isEmpty ? nil : $0 } }
        name = text(.name) ?? id
        icon = text(.icon)
        online = ((try? c.decodeIfPresent(Bool.self, forKey: .online)) ?? nil) ?? false
        lastSeenAt = text(.lastSeenAt).flatMap(ISO8601.parse)
        rpcUrl = text(.rpcUrl).flatMap(URL.init(string:))
        tokenFile = text(.tokenFile)
    }

    enum CodingKeys: String, CodingKey { case id, name, icon, online, lastSeenAt, rpcUrl, tokenFile }
}

/// One row of another runner's sidebar table: what a sidebar row shows,
/// not the whole summary that runner keeps.
public struct RemoteThread: Sendable, Hashable, Decodable {
    public var runnerId: String
    public var threadId: String
    public var title: String
    public var cwd: String
    public var accountId: String
    public var provider: String
    public var model: String?
    public var status: ThreadStatus
    public var needsYou: Bool
    public var unread: Bool
    public var preview: String
    public var createdAt: Date
    public var lastActivityAt: Date
    public var snoozedUntil: Date?
    public var archivedAt: Date?
    public var starredAt: Date?
    /// Who started it, when it wasn't Mike: the row's byline.
    public var startedBy: ThreadStartedBy?
    /// What Mike last said to it (backend API 32): the row's "You: ...".
    public var asked: String?

    public init(runnerId: String, threadId: String, title: String = "", cwd: String = "", accountId: String = "", provider: String = "claude",
                model: String? = nil, status: ThreadStatus = .idle, needsYou: Bool = false, unread: Bool = false, preview: String = "",
                createdAt: Date = Date(), lastActivityAt: Date = Date(), snoozedUntil: Date? = nil, archivedAt: Date? = nil, startedBy: ThreadStartedBy? = nil) {
        self.runnerId = runnerId
        self.threadId = threadId
        self.title = title
        self.cwd = cwd
        self.accountId = accountId
        self.provider = provider
        self.model = model
        self.status = status
        self.needsYou = needsYou
        self.unread = unread
        self.preview = preview
        self.createdAt = createdAt
        self.lastActivityAt = lastActivityAt
        self.snoozedUntil = snoozedUntil
        self.archivedAt = archivedAt
        self.startedBy = startedBy
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        runnerId = try c.decode(String.self, forKey: .runnerId)
        threadId = try c.decode(String.self, forKey: .threadId)
        func text(_ key: CodingKeys) -> String? { (try? c.decodeIfPresent(String.self, forKey: key)) ?? nil }
        func flag(_ key: CodingKeys) -> Bool { ((try? c.decodeIfPresent(Bool.self, forKey: key)) ?? nil) ?? false }
        title = text(.title) ?? ""
        cwd = text(.cwd) ?? ""
        accountId = text(.accountId) ?? ""
        provider = text(.provider).flatMap { $0.isEmpty ? nil : $0 } ?? "claude"
        model = text(.model).flatMap { $0.isEmpty ? nil : $0 }
        status = ((try? c.decodeIfPresent(ThreadStatus.self, forKey: .status)) ?? nil) ?? .idle
        needsYou = flag(.needsYou)
        unread = flag(.unread)
        preview = text(.preview) ?? ""
        createdAt = text(.createdAt).flatMap(ISO8601.parse) ?? Date(timeIntervalSince1970: 0)
        lastActivityAt = text(.lastActivityAt).flatMap(ISO8601.parse) ?? createdAt
        snoozedUntil = text(.snoozedUntil).flatMap(ISO8601.parse)
        archivedAt = text(.archivedAt).flatMap(ISO8601.parse)
        starredAt = text(.starredAt).flatMap(ISO8601.parse)
        startedBy = (try? c.decodeIfPresent(ThreadStartedBy.self, forKey: .startedBy)) ?? nil
        asked = text(.asked).flatMap { $0.isEmpty ? nil : $0 }
    }

    enum CodingKeys: String, CodingKey {
        case runnerId, threadId, title, cwd, accountId, provider, model, status, needsYou, unread, preview
        case createdAt, lastActivityAt, snoozedUntil, archivedAt, starredAt, startedBy, asked
    }

    /// As a summary the sidebar's rows and sections take like a local one.
    /// The table has no seqs, so an unread one gets 1 and 0, which is all
    /// the rows look at; opening the thread fetches the real summary from
    /// its runner.
    public var summary: ThreadSummary {
        var summary = ThreadSummary(
            id: threadId, title: title, cwd: cwd, accountId: accountId, provider: provider, model: model,
            status: status, needsYou: needsYou, createdAt: createdAt, updatedAt: lastActivityAt, lastActivityAt: lastActivityAt,
            snoozedUntil: snoozedUntil, archivedAt: archivedAt, starredAt: starredAt, preview: preview,
            lastSeq: unread ? 1 : 0, lastSeenSeq: 0
        )
        // Hibernating until that runner restarts is kept as a date in the
        // year 9999 (`threads.update` with "restart").
        if let snoozedUntil, snoozedUntil > Self.restartFarOff { summary.snoozedUntilRestart = true }
        summary.runnerId = runnerId
        summary.startedBy = startedBy
        summary.asked = asked
        return summary
    }

    static let restartFarOff = Date(timeIntervalSince1970: 200_000_000_000)
}

/// Where a thread's requests go: this Mac's own runner, or the runner it
/// lives on.
public enum ThreadRoute: Sendable, Equatable {
    case local
    case remote(RemoteRunner)
    /// Another runner's thread whose runner isn't listed any more.
    case unknownRunner(String)

    public static func of(_ thread: ThreadSummary?, runners: [RemoteRunner]) -> ThreadRoute {
        guard let runnerId = thread?.runnerId else { return .local }
        guard let runner = runners.first(where: { $0.id == runnerId }) else { return .unknownRunner(runnerId) }
        return .remote(runner)
    }
}

/// Why another runner's thread can't be opened from this Mac, in words for
/// the place its transcript would be.
public struct RemoteUnreachable: Error, Sendable, Equatable, LocalizedError {
    public enum Reason: Sendable, Equatable {
        /// No token for it on this Mac (`tokenFile` absent or unreadable).
        case noToken
        /// It hasn't told the backend its `sync.rpcUrl`.
        case noAddress
        /// Its runner isn't in the list any more.
        case unknownRunner
        /// It turned the token down.
        case refused
        /// It didn't answer, or the connection failed.
        case failed(String)
        /// Its `rpcUrl` names a different host from the one written beside
        /// its token, so the token wasn't sent (`RunnerHostPin`).
        case hostChanged(pinned: String, seen: String)
        /// There's no readable host file beside its token (`file`), so the
        /// token wasn't sent: the mirror's host is never trusted alone.
        case noHostPin(file: String)
    }

    public var runnerId: String
    public var runnerName: String
    public var online: Bool
    public var reason: Reason

    public init(runnerId: String, runnerName: String, online: Bool, reason: Reason) {
        self.runnerId = runnerId
        self.runnerName = runnerName
        self.online = online
        self.reason = reason
    }

    public init(_ runner: RemoteRunner, _ reason: Reason) {
        self.init(runnerId: runner.id, runnerName: runner.name, online: runner.online, reason: reason)
    }

    public var headline: String { "Can't reach \(runnerName) from this Mac." }

    public var detail: String {
        switch reason {
        case .noToken: return "Its runner token isn't on this Mac yet (secrets/runners/\(runnerId).token)."
        case .noAddress: return "It hasn't said how to reach it yet (sync.rpcUrl in its runner.json)."
        case .unknownRunner: return "Its runner isn't listed any more."
        case .refused: return "It didn't accept the token this Mac has for it."
        case .hostChanged(let pinned, let seen):
            return "Its address changed from \(pinned) to \(seen), so this Mac didn't send it its token. "
                + "If it really moved, run tb pair on that Mac and put the host it prints in secrets/runners/\(runnerId).host here."
        case .noHostPin(let file):
            // Never offers the mirror's host: that's the one that can't be trusted.
            return "This Mac only sends its token to a host it was told about on that Mac. "
                + "Run tb pair on \(runnerName), then put the host line it prints into \(file) on this Mac and open it again."
        case .failed(let why):
            // Offline or not, the usual cause is a Mac asleep or Tailscale off.
            return online ? "It didn't answer (\(why))." : "It's offline, or Tailscale is off on one of the Macs."
        }
    }

    public var errorDescription: String? { detail }

    static func from(_ error: Error, runner: RemoteRunner) -> RemoteUnreachable {
        if let unreachable = error as? RemoteUnreachable { return unreachable }
        switch error as? RPCError {
        case .unauthorized?: return RemoteUnreachable(runner, .refused)
        case .connectFailed(let why)?: return RemoteUnreachable(runner, .failed(why))
        case .timeout?: return RemoteUnreachable(runner, .failed("it took too long"))
        case .disconnected?: return RemoteUnreachable(runner, .failed("the connection closed"))
        default: return RemoteUnreachable(runner, .failed(error.localizedDescription))
        }
    }
}

/// The app's connections to other runners: one per runner, opened when one
/// of its threads is opened and closed when none is, with the same
/// transport and protocol as the app's own runner's.
@MainActor
public final class RemoteClients {
    public typealias MakeTransport = @Sendable (URL, String) -> RPCTransport

    /// Every notification from a runner's connection, with its id.
    public var onNotification: ((_ runnerId: String, RPCNotification) -> Void)?
    /// A connection came up (after its hello).
    public var onConnected: ((_ runnerId: String, RPCClient) -> Void)?
    /// A connection ended: closed here or dropped.
    public var onClosed: ((_ runnerId: String) -> Void)?
    /// A line for the app's log (a host pinned or refused).
    public var onLog: ((String) -> Void)?

    private struct Entry {
        var client: RPCClient
        var url: URL
        var token: String
    }

    private let version: String
    private let makeTransport: MakeTransport
    private let readToken: (String) -> String?
    private let pins: RunnerHostPins
    private var open: [String: Entry] = [:]
    private var connecting: [String: Task<RPCClient, Error>] = [:]

    public init(version: String, makeTransport: @escaping MakeTransport = { WebSocketTransport(url: $0, token: $1) },
                readToken: @escaping (String) -> String? = RemoteClients.readTokenFile,
                pins: RunnerHostPins = .files) {
        self.version = version
        self.makeTransport = makeTransport
        self.readToken = readToken
        self.pins = pins
    }

    public nonisolated static func readTokenFile(_ path: String) -> String? {
        guard let raw = try? String(contentsOfFile: path, encoding: .utf8) else { return nil }
        let token = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        return token.isEmpty ? nil : token
    }

    /// The runner's connection, if it's up.
    public func connected(_ runnerId: String) -> RPCClient? {
        guard let entry = open[runnerId], !entry.client.isClosed else { return nil }
        return entry.client
    }

    public var connectedRunners: Set<String> { Set(open.keys.filter { connected($0) != nil }) }

    /// The client a thread's requests go to, without connecting: this
    /// Mac's runner's for its own threads, the thread's runner's while
    /// that's connected, nil otherwise.
    public func client(for route: ThreadRoute, local: RPCClient?) -> RPCClient? {
        switch route {
        case .local: return local
        case .remote(let runner): return connected(runner.id)
        case .unknownRunner: return nil
        }
    }

    /// The runner's connection, opening it if need be. Throws
    /// `RemoteUnreachable` saying why it can't.
    public func client(for runner: RemoteRunner) async throws -> RPCClient {
        if let client = connected(runner.id) { return client }
        if let pending = connecting[runner.id] { return try await pending.value }
        guard let url = runner.rpcUrl, let host = url.host, !host.isEmpty else { throw RemoteUnreachable(runner, .noAddress) }
        guard let file = runner.tokenFile, let token = readToken(file) else { throw RemoteUnreachable(runner, .noToken) }
        // The rpcUrl comes from the backend's mirror, which any runner with
        // the shared key can rewrite, so the token only goes to the host
        // copied in beside it, from that Mac (`tb pair`). No pin, or one
        // that can't be read, means no token: never trust on first use.
        switch RunnerHostPin.decide(host: host, pinned: pins.read(file)) {
        case .send: break
        case .noPin:
            let pinFile = RunnerHostPin.file(forToken: file)
            onLog?("didn't send \(runner.name) (\(runner.id))'s token: no readable \(pinFile)")
            throw RemoteUnreachable(runner, .noHostPin(file: pinFile))
        case .refuse(let pinned, let seen):
            onLog?("refused to send \(runner.name) (\(runner.id))'s token to \(seen): it's pinned to \(pinned)")
            throw RemoteUnreachable(runner, .hostChanged(pinned: pinned, seen: seen))
        }
        let makeTransport = makeTransport
        let version = version
        let task = Task { () throws -> RPCClient in
            let client = RPCClient(transport: makeTransport(url, token))
            do {
                try await client.start()
                _ = try await client.hello(version: version)
            } catch {
                client.close()
                throw RemoteUnreachable.from(error, runner: runner)
            }
            return client
        }
        connecting[runner.id] = task
        let client: RPCClient
        do {
            client = try await task.value
        } catch {
            connecting[runner.id] = nil
            throw error
        }
        connecting[runner.id] = nil
        adopt(client, runnerId: runner.id, url: url, token: token)
        return client
    }

    private func adopt(_ client: RPCClient, runnerId: String, url: URL, token: String) {
        open[runnerId]?.client.close()
        open[runnerId] = Entry(client: client, url: url, token: token)
        Task { [weak self] in
            for await notification in client.notifications {
                self?.onNotification?(runnerId, notification)
            }
            // Dropped rather than closed here: closing removes it first.
            guard let self, self.open[runnerId]?.client === client else { return }
            self.open[runnerId] = nil
            self.onClosed?(runnerId)
        }
        onConnected?(runnerId, client)
    }

    public func close(_ runnerId: String) {
        guard let entry = open.removeValue(forKey: runnerId) else { return }
        entry.client.close()
        onClosed?(runnerId)
    }

    public func closeAll() {
        for id in Array(open.keys) { close(id) }
    }
}

/// Which host a runner's token may go to. The token is copied in by hand,
/// but where to send it comes from the backend's mirror (`rpcUrl`), which
/// anyone holding the shared runner key can rewrite. So the host is copied
/// in too, from that Mac (`tb pair` prints it), into `<id>.host` next to
/// `<id>.token`, and the token goes only there. With no pin the token isn't
/// sent at all: trusting the mirror's first answer would let whoever wrote
/// it first have the token. Only the host is pinned: a new port on the same
/// Mac is still that Mac.
public enum RunnerHostPin {
    public enum Decision: Sendable, Equatable {
        case send
        /// No pin (or an unreadable one): don't send.
        case noPin
        case refuse(pinned: String, seen: String)
    }

    public static func decide(host: String, pinned: String?) -> Decision {
        let seen = normalized(host)
        guard let pinned = pinned.map(normalized), !pinned.isEmpty else { return .noPin }
        return pinned == seen ? .send : .refuse(pinned: pinned, seen: seen)
    }

    /// The pin file for a token file: `<id>.host` beside `<id>.token`.
    public static func file(forToken tokenFile: String) -> String {
        tokenFile.hasSuffix(".token") ? String(tokenFile.dropLast(".token".count)) + ".host" : tokenFile + ".host"
    }

    static func normalized(_ host: String) -> String {
        var host = host.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        while host.hasSuffix(".") { host.removeLast() }
        return host
    }
}

/// Where `RemoteClients` reads the pins, by token file: files on a real
/// Mac, a fixed map in tests. Read only: the app never writes a pin, as the
/// only host it could write is the mirror's.
public struct RunnerHostPins: Sendable {
    /// Nil when there's no pin or it can't be read; both refuse.
    public var read: @Sendable (_ tokenFile: String) -> String?

    public init(read: @escaping @Sendable (String) -> String?) {
        self.read = read
    }

    public static let files = RunnerHostPins(read: { RemoteClients.readTokenFile(RunnerHostPin.file(forToken: $0)) })

    /// Pins by token file, as if copied in.
    public static func memory(_ pins: [String: String] = [:]) -> RunnerHostPins {
        RunnerHostPins(read: { pins[$0] })
    }
}
