import Foundation
import Synchronization

public enum RPCError: Error, Sendable, Equatable, LocalizedError {
    case server(code: Int, message: String)
    case disconnected(String?)
    case timeout(String)
    case unauthorized
    case connectFailed(String)
    case badResponse(String)

    public var errorDescription: String? {
        switch self {
        // The app updates a few minutes before the runner can (it builds and
        // tests main first), and during a handover an old runner still
        // answers for the threads it's finishing, so a new feature can meet
        // a runner that doesn't know it yet. Callers that check the code
        // for an old runner still see -32601.
        case .server(Self.methodNotFound, _): return "The runner hasn't caught up with this version of the app yet. Try again in a minute."
        case .server(_, let message): return message
        case .disconnected: return "Lost the connection to the runner."
        case .timeout(let method): return "The runner didn't answer \(method) in time."
        case .unauthorized: return "The runner didn't accept the token."
        case .connectFailed(let reason): return "Couldn't reach the runner (\(reason))."
        case .badResponse(let reason): return "The runner sent something unexpected (\(reason))."
        }
    }

    public static let threadNotFound = -32004
    public static let scheduleNotFound = -32005
    public static let subagentNotFound = -32006
    public static let projectNotFound = -32007
    public static let methodNotFound = -32601
    public static let busy = -32020
    /// The runner's Convex CLI isn't signed in, or its login can't reach
    /// the panel's deployment (docs/protocol.md, "The Convex panel").
    public static let convexSignedOut = -32040
    public static let convexNoAccess = -32041
    /// `threads.edit` would stop the thread's background work; sent again
    /// with `stopBackground` once Mike says so (docs/protocol.md,
    /// "Editing a message").
    public static let backgroundRunning = -32050
}

public enum RPCNotification: Sendable {
    case threadUpdated(ThreadSummary)
    case threadEvent(threadId: String, event: Event)
    case threadDeleted(threadId: String)
    case accountsUpdated([Account])
    /// The whole pool list, after `pools.save` or when the logins change
    /// the runner's defaults.
    case poolsUpdated([Pool])
    /// The CLIs' versions and any update under way, whole each time.
    case clisUpdated([CliStatus])
    /// The whole schedule list, after any change.
    case schedulesUpdated([Schedule])
    /// Other runners and their threads, whole each time (docs/protocol.md,
    /// "Other runners' threads").
    case remoteThreadsUpdated(RemoteThreads)
    /// Every project, archived ones too, after any change. Thread
    /// membership comes as `thread.updated`.
    case projectsUpdated([Project])
    /// The librarian's status, whole, whenever it changes.
    case librarianUpdated(LibrarianStatus)
    /// The Connectors gateway's services, whole, whenever what the panel
    /// shows changes.
    case connectorsUpdated(ConnectorsStatus)
    /// The runner's settings after any change (a setting, the key, or the
    /// spend going up).
    case settingsUpdated(RunnerSettings)
    case standingInstructions(StandingInstructions)
    case runnerNotice(level: String, message: String)
    /// The runner's own update, whole each time.
    case runnerUpdates(RunnerUpdates)
    case other(method: String)
}

public struct EmptyResult: Sendable, Decodable {
    public init() {}
}

/// JSON-RPC 2.0 client over any `RPCTransport`. Responses are decoded on the
/// receive task, never on the main thread.
public final class RPCClient: Sendable {
    public let notifications: AsyncStream<RPCNotification>
    /// Finishes with the reason the connection ended.
    public let closed: AsyncStream<RPCError>

    private let transport: RPCTransport
    private let notificationContinuation: AsyncStream<RPCNotification>.Continuation
    private let closedContinuation: AsyncStream<RPCError>.Continuation
    /// Requests go out through one queue so they reach the runner in the
    /// order they were made.
    private let outgoing: AsyncStream<(id: Int, text: String)>.Continuation
    private let state = Mutex(State())

    private struct Pending {
        var handler: @Sendable (Result<Data, RPCError>) -> Void
        var timeout: Task<Void, Never>?
    }

    private struct State {
        var nextId = 1
        var pending: [Int: Pending] = [:]
        var isClosed = false
        var receiveTask: Task<Void, Never>?
    }

    public init(transport: RPCTransport) {
        self.transport = transport
        (notifications, notificationContinuation) = AsyncStream.makeStream(bufferingPolicy: .unbounded)
        (closed, closedContinuation) = AsyncStream.makeStream(bufferingPolicy: .bufferingNewest(1))
        let (stream, continuation) = AsyncStream<(id: Int, text: String)>.makeStream(bufferingPolicy: .unbounded)
        outgoing = continuation
        Task.detached(priority: .userInitiated) { [transport, weak self] in
            for await message in stream {
                do {
                    try await transport.send(message.text)
                } catch {
                    self?.resolve(message.id, .failure(.disconnected("send failed")))
                }
            }
        }
    }

    /// Opens the transport and starts reading.
    public func start() async throws {
        try await transport.open()
        let task = Task.detached(priority: .userInitiated) { [self] in
            await receiveLoop()
        }
        state.withLock { $0.receiveTask = task }
    }

    public func close() {
        transport.close()
        finish(.disconnected("closed by app"))
    }

    public var isClosed: Bool { state.withLock { $0.isClosed } }

    /// Sends a request and decodes its `result` as `R`.
    public func call<R: Decodable & Sendable>(
        _ method: String,
        _ params: JSONValue = .object([:]),
        as type: R.Type = R.self,
        timeout: Duration = .seconds(30)
    ) async throws -> R {
        let id: Int? = state.withLock { state in
            guard !state.isClosed else { return nil }
            defer { state.nextId += 1 }
            return state.nextId
        }
        guard let id else { throw RPCError.disconnected(nil) }
        let request = RPCRequest(id: id, method: method, params: params)
        let text = String(decoding: try JSONEncoder().encode(request), as: UTF8.self)

        return try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<R, Error>) in
            let handler: @Sendable (Result<Data, RPCError>) -> Void = { result in
                switch result {
                case .failure(let error):
                    continuation.resume(throwing: error)
                case .success(let data):
                    do {
                        let response = try JSONDecoder().decode(RPCResponse<R>.self, from: data)
                        if let error = response.error {
                            continuation.resume(throwing: RPCError.server(code: error.code, message: error.message))
                        } else if let result = response.result {
                            continuation.resume(returning: result)
                        } else if let empty = EmptyResult() as? R {
                            continuation.resume(returning: empty)
                        } else {
                            continuation.resume(throwing: RPCError.badResponse("\(method) had no result"))
                        }
                    } catch {
                        continuation.resume(throwing: RPCError.badResponse("\(method): \(error)"))
                    }
                }
            }
            let registered = state.withLock { state -> Bool in
                guard !state.isClosed else { return false }
                state.pending[id] = Pending(handler: handler)
                return true
            }
            guard registered else {
                handler(.failure(.disconnected(nil)))
                return
            }
            // Cancelled when the answer arrives, so finished calls don't
            // leave a sleeping task behind.
            let timer = Task.detached { [weak self] in
                try? await Task.sleep(for: timeout)
                guard !Task.isCancelled else { return }
                self?.resolve(id, .failure(.timeout(method)))
            }
            let stillPending = state.withLock { state -> Bool in
                guard state.pending[id] != nil else { return false }
                state.pending[id]?.timeout = timer
                return true
            }
            if !stillPending { timer.cancel() }
            outgoing.yield((id, text))
        }
    }

    private func resolve(_ id: Int, _ result: Result<Data, RPCError>) {
        let entry = state.withLock { $0.pending.removeValue(forKey: id) }
        entry?.timeout?.cancel()
        entry?.handler(result)
    }

    private func receiveLoop() async {
        while true {
            let data: Data
            do {
                data = try await transport.receive()
            } catch let error as RPCError {
                finish(error)
                return
            } catch {
                finish(.disconnected(error.localizedDescription))
                return
            }
            handle(data)
        }
    }

    func handle(_ data: Data) {
        let peek = JSONPeek.topLevel(data)
        if let method = peek.method {
            if peek.hasId { return } // Requests from the runner aren't part of v1.
            if let notification = decodeNotification(method: method, data: data) {
                notificationContinuation.yield(notification)
            }
        } else if let id = peek.id {
            resolve(id, .success(data))
        }
    }

    private func decodeNotification(method: String, data: Data) -> RPCNotification? {
        let decoder = JSONDecoder()
        switch method {
        case "thread.updated":
            guard let params = try? decoder.decode(RPCNotificationEnvelope<ThreadUpdatedParams>.self, from: data).params
            else { return nil }
            return .threadUpdated(params.thread)
        case "thread.event":
            guard let params = try? decoder.decode(RPCNotificationEnvelope<ThreadEventParams>.self, from: data).params
            else { return nil }
            return .threadEvent(threadId: params.threadId, event: params.event)
        case "thread.deleted":
            guard let params = try? decoder.decode(RPCNotificationEnvelope<ThreadDeletedParams>.self, from: data).params
            else { return nil }
            return .threadDeleted(threadId: params.threadId)
        case "accounts.updated":
            guard let params = try? decoder.decode(RPCNotificationEnvelope<AccountsUpdatedParams>.self, from: data).params
            else { return nil }
            return .accountsUpdated(params.accounts)
        case "pools.updated":
            guard let params = try? decoder.decode(RPCNotificationEnvelope<PoolsResult>.self, from: data).params
            else { return nil }
            return .poolsUpdated(params.pools)
        case "clis.updated":
            guard let params = try? decoder.decode(RPCNotificationEnvelope<ClisResult>.self, from: data).params
            else { return nil }
            return .clisUpdated(params.clis)
        case "schedules.updated":
            guard let params = try? decoder.decode(RPCNotificationEnvelope<SchedulesResult>.self, from: data).params
            else { return nil }
            return .schedulesUpdated(params.schedules)
        case "remoteThreads.updated":
            guard let params = try? decoder.decode(RPCNotificationEnvelope<RemoteThreads>.self, from: data).params
            else { return nil }
            return .remoteThreadsUpdated(params)
        case "projects.updated":
            guard let params = try? decoder.decode(RPCNotificationEnvelope<ProjectsResult>.self, from: data).params
            else { return nil }
            return .projectsUpdated(params.projects)
        case "librarian.updated":
            guard let params = try? decoder.decode(RPCNotificationEnvelope<LibrarianResult>.self, from: data).params
            else { return nil }
            return .librarianUpdated(params.librarian)
        case "connectors.updated":
            guard let params = try? decoder.decode(RPCNotificationEnvelope<ConnectorsResult>.self, from: data).params
            else { return nil }
            return .connectorsUpdated(params.connectors)
        case "settings.updated":
            guard let params = try? decoder.decode(RPCNotificationEnvelope<SettingsResult>.self, from: data).params
            else { return nil }
            return .settingsUpdated(params.settings)
        case "instructions.updated":
            guard let params = try? decoder.decode(RPCNotificationEnvelope<StandingInstructionsResult>.self, from: data).params
            else { return nil }
            return .standingInstructions(params.instructions)
        case "runner.updates":
            guard let params = try? decoder.decode(RPCNotificationEnvelope<RunnerUpdatesParams>.self, from: data).params
            else { return nil }
            return .runnerUpdates(params.updates)
        case "runner.notice":
            guard let params = try? decoder.decode(RPCNotificationEnvelope<RunnerNoticeParams>.self, from: data).params
            else { return nil }
            return .runnerNotice(level: params.level ?? "info", message: params.message ?? "")
        default:
            return .other(method: method)
        }
    }

    private func finish(_ reason: RPCError) {
        let pending = state.withLock { state -> [Pending] in
            guard !state.isClosed else { return [] }
            state.isClosed = true
            let entries = Array(state.pending.values)
            state.pending.removeAll()
            return entries
        }
        outgoing.finish()
        // A refused token (close code 4401 after the first request) fails
        // the waiting calls as unauthorized, so the app can say so.
        let failure: RPCError = reason == .unauthorized ? .unauthorized : .disconnected(nil)
        for entry in pending {
            entry.timeout?.cancel()
            entry.handler(.failure(failure))
        }
        closedContinuation.yield(reason)
        closedContinuation.finish()
        notificationContinuation.finish()
    }
}

private struct RPCRequest: Encodable {
    let jsonrpc = "2.0"
    let id: Int
    let method: String
    let params: JSONValue
}

private struct RPCErrorObject: Decodable {
    var code: Int
    var message: String

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        code = try c.decodeIfPresent(Int.self, forKey: .code) ?? -32000
        message = try c.decodeIfPresent(String.self, forKey: .message) ?? "Unknown error"
    }

    enum CodingKeys: String, CodingKey { case code, message }
}

private struct RPCResponse<R: Decodable>: Decodable {
    var result: R?
    var error: RPCErrorObject?
}

private struct RPCNotificationEnvelope<P: Decodable>: Decodable {
    var params: P
}

private struct ThreadUpdatedParams: Decodable {
    var thread: ThreadSummary
}

private struct ThreadEventParams: Decodable {
    var threadId: String
    var event: Event
}

private struct ThreadDeletedParams: Decodable {
    var threadId: String
}

private struct AccountsUpdatedParams: Decodable {
    var accounts: [Account]

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        accounts = c.lossyArray(Account.self, forKey: .accounts)
    }

    enum CodingKeys: String, CodingKey { case accounts }
}

private struct RunnerNoticeParams: Decodable {
    var level: String?
    var message: String?
}

/// Reads the top-level `id` and `method` of a JSON-RPC message in one byte
/// scan, so a multi-megabyte response is only fully decoded once, by the
/// caller that knows its type.
public enum JSONPeek {
    public struct Result: Equatable {
        public var id: Int?
        public var hasId: Bool
        public var method: String?
    }

    public static func topLevel(_ data: Data) -> Result {
        var result = Result(id: nil, hasId: false, method: nil)
        data.withUnsafeBytes { (raw: UnsafeRawBufferPointer) in
            let bytes = raw.bindMemory(to: UInt8.self)
            let count = bytes.count
            var index = 0
            func skipSpace() {
                while index < count, bytes[index] == 0x20 || bytes[index] == 0x0A || bytes[index] == 0x0D || bytes[index] == 0x09 {
                    index += 1
                }
            }
            // Returns the byte range of a string's contents, index after the closing quote.
            func scanString() -> Range<Int>? {
                guard index < count, bytes[index] == 0x22 else { return nil }
                index += 1
                let start = index
                while index < count {
                    let byte = bytes[index]
                    if byte == 0x5C { index += 2; continue }
                    if byte == 0x22 { let range = start..<index; index += 1; return range }
                    index += 1
                }
                return nil
            }
            func skipValue() {
                skipSpace()
                guard index < count else { return }
                let byte = bytes[index]
                if byte == 0x22 { _ = scanString(); return }
                if byte == 0x7B || byte == 0x5B {
                    var depth = 0
                    while index < count {
                        let current = bytes[index]
                        if current == 0x22 { _ = scanString(); continue }
                        if current == 0x7B || current == 0x5B { depth += 1 }
                        if current == 0x7D || current == 0x5D {
                            depth -= 1
                            if depth == 0 { index += 1; return }
                        }
                        index += 1
                    }
                    return
                }
                while index < count, bytes[index] != 0x2C, bytes[index] != 0x7D { index += 1 }
            }
            func string(_ range: Range<Int>) -> String {
                String(decoding: UnsafeBufferPointer(rebasing: bytes[range]), as: UTF8.self)
            }

            skipSpace()
            guard index < count, bytes[index] == 0x7B else { return }
            index += 1
            while index < count {
                skipSpace()
                guard let keyRange = scanString() else { return }
                skipSpace()
                guard index < count, bytes[index] == 0x3A else { return }
                index += 1
                skipSpace()
                let key = string(keyRange)
                if key == "id" {
                    result.hasId = true
                    if index < count, bytes[index] == 0x22 {
                        if let range = scanString() { result.id = Int(string(range)) }
                    } else {
                        let start = index
                        skipValue()
                        result.id = Int(string(start..<index).trimmingCharacters(in: .whitespaces))
                    }
                } else if key == "method" {
                    if let range = scanString() { result.method = string(range) }
                } else {
                    skipValue()
                }
                skipSpace()
                guard index < count else { return }
                if bytes[index] == 0x2C { index += 1; continue }
                return
            }
        }
        return result
    }
}
