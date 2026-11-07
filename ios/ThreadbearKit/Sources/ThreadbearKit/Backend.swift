import Foundation

/// What the app needs from Threadbear's Convex mirror (convex/phone.ts).
/// Reads are live; writes are commands the owning runner picks up and
/// applies, each returning a command id the app can watch.
public extension Backend {
    func send(threadId: String, text: String) async throws -> String {
        try await send(threadId: threadId, text: text, answers: [])
    }

    func send(threadId: String, text: String, answers: [AskAnswer]) async throws -> String {
        try await send(threadId: threadId, text: text, answers: answers, images: [])
    }

    func create(text: String, runnerId: String?, cwd: String?) async throws -> String {
        try await create(text: text, runnerId: runnerId, cwd: cwd, images: [])
    }

    func create(text: String, runnerId: String?, cwd: String?, images: [String]) async throws -> String {
        try await create(text: text, runnerId: runnerId, cwd: cwd, images: images, settings: NewThreadSettings())
    }
}

public protocol Backend: Sendable {
    func me() async throws -> PhoneIdentity
    func runners() -> AsyncThrowingStream<[PhoneRunner], Error>
    /// Every runner's projects (not archived ones), with their icons from
    /// backend API 5, so a row can show its project the way the Mac does.
    func projects() -> AsyncThrowingStream<[PhoneProject], Error>
    func threads(_ view: ThreadsView) -> AsyncThrowingStream<[PhoneThread], Error>
    /// The inbox, read whole once and then only the rows written since
    /// (backend API 43), so a phone left open doesn't read the whole list for
    /// every row a runner writes.
    func inboxChanges() -> AsyncThrowingStream<[PhoneThread], Error>
    /// Archived threads with these words in their title or last reply
    /// (backend API 16), for the search to find ones older than the den's
    /// newest 100. Once, not live: it runs again as the words change.
    func search(_ text: String) async throws -> [PhoneThread]
    /// Every runner's schedules, for the inbox's Waiting section: which
    /// threads have booked themselves a message for later.
    func schedules() -> AsyncThrowingStream<[PhoneSchedule], Error>
    /// How many threads are hibernating and archived (backend API 16), for
    /// the folded headings, so those lists needn't be loaded.
    func counts() -> AsyncThrowingStream<PhoneCounts, Error>
    /// Nil once the thread's gone from the mirror.
    func thread(_ threadId: String) -> AsyncThrowingStream<ThreadDetail?, Error>
    func command(_ commandId: String) -> AsyncThrowingStream<CommandStatus?, Error>
    /// The thread's messages from the phone its runner hasn't applied yet,
    /// oldest first, live (backend API 57).
    func waiting(_ threadId: String) -> AsyncThrowingStream<[WaitingSend], Error>
    /// Takes back a waiting message (backend API 57). False once the runner
    /// has taken it, too late to stop.
    func cancel(_ commandId: String) async throws -> Bool
    func connectionStates() -> AsyncStream<Bool>

    /// `answers` (backend API 14): the open card's asks the message answers.
    /// `images` (backend API 18): storage ids from `uploadPhoto`.
    func send(threadId: String, text: String, answers: [AskAnswer], images: [String]) async throws -> String
    /// Puts a JPEG in file storage on its way to the runner (backend API 18), and returns its
    /// storage id. The backend deletes it once the runner has its copy.
    func uploadPhoto(_ jpeg: Data) async throws -> String
    /// Takes back a photo that was uploaded and then never sent (backend API 25).
    func discardPhoto(_ storageId: String) async throws
    func respond(threadId: String, approvalId: String, decision: ApprovalOption) async throws -> String
    /// Presses a reply button (backend API 59): queues it for the thread's
    /// runner, which presses it once however many times it's asked.
    func press(threadId: String, buttonId: String) async throws -> String
    /// Answers keyed by question text, several choices joined with ", ",
    /// as the Mac app sends them. `summary` goes in the transcript.
    func answer(threadId: String, approvalId: String, answers: [String: String], summary: String) async throws -> String
    /// A secret card's answer (backend API 35): the value sealed to the
    /// runner's key (SecretSeal), or a decline. The backend only ever sees
    /// the sealed form.
    func secret(threadId: String, approvalId: String, answer: SecretAnswer) async throws -> String
    func update(threadId: String, change: ThreadChange) async throws -> String
    /// `settings` (backend API 20 for an effort): the model and effort it starts on.
    func create(text: String, runnerId: String?, cwd: String?, images: [String], settings: NewThreadSettings) async throws -> String
    /// Every runner's logins with the models they offer (backend API 20), for the new thread pickers.
    func accounts() -> AsyncThrowingStream<[PhoneAccount], Error>
    /// A quick ask that's been answered (backend API 10): the runner makes it a thread with the
    /// question and its answer in, without running a turn, so a follow-up is an ordinary reply.
    /// The command's threadId is that thread.
    func quickAsk(_ ask: QuickAskRecord) async throws -> String
    /// The newest `limit` messages of a thread, tool lines included, live
    /// (backend API 2). Reads Convex alone, so it works while the Mac sleeps;
    /// more history is a bigger limit.
    func messages(_ threadId: String, limit: Int) -> AsyncThrowingStream<MessagePage, Error>
    /// For a backend before API 2: asks the runner for up to 50 text messages older than `beforeSeq`;
    /// they turn up in `thread(_:)` once it has written them.
    func loadEarlier(threadId: String, beforeSeq: Int) async throws -> String
    /// The Pocket's cards (backend API 19), live.
    func pocket() -> AsyncThrowingStream<[PocketCard], Error>
    func removePocketCard(id: String) async throws
    /// pushKey (backend API 4): base64 of this phone's relay key (PushKeyStore).
    func registerDevice(apnsToken: String, environment: String, pushKey: String?) async throws
    /// Backend API 3: when this phone (by its APNs token) is notified.
    func setNotifications(apnsToken: String, notify: NotifyMode) async throws
    /// Puts the runners in this order (backend API 57): new threads start on
    /// the first one online, and runners() lists them so.
    func setRunnerOrder(_ runnerIds: [String]) async throws
}

/// The real backend: convex/phone.ts, called with the phone token.
public final class ConvexBackend: Backend, @unchecked Sendable {
    private let transport: any ConvexTransport
    private let token: String
    private let post: PhotoPost

    /// POSTs a photo's bytes to an upload URL and returns the response body.
    public typealias PhotoPost = @Sendable (URL, Data) async throws -> Data

    public init(transport: any ConvexTransport, token: String, post: @escaping PhotoPost = ConvexBackend.urlSessionPost) {
        self.transport = transport
        self.token = token
        self.post = post
    }

    public static let urlSessionPost: PhotoPost = { url, jpeg in
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("image/jpeg", forHTTPHeaderField: "Content-Type")
        let (data, response) = try await URLSession.shared.upload(for: request, from: jpeg)
        guard (response as? HTTPURLResponse)?.statusCode == 200 else {
            throw TransportError.server("Couldn't upload the photo.")
        }
        return data
    }

    public convenience init(deploymentURL: URL, token: String) {
        self.init(transport: ConvexMobileTransport(deploymentURL: deploymentURL), token: token)
    }

    private func args(_ extra: [String: JSONValue] = [:]) -> [String: JSONValue] {
        extra.merging(["token": .string(token)]) { $1 }
    }

    private static func decode<T: Decodable>(_ type: T.Type, _ data: Data) throws -> T {
        do { return try JSONDecoder().decode(T.self, from: data) } catch {
            throw TransportError.server("Couldn't read the server's answer: \(error)")
        }
    }

    /// A live query. For one that can say "not found" (`missing`), that
    /// error becomes the value instead, and the stream ends.
    private func live<T: Decodable & Sendable>(_ name: String, _ extra: [String: JSONValue], as: T.Type,
                                               missing: T? = nil) -> AsyncThrowingStream<T, Error> {
        let raw = transport.subscribe(name, args(extra))
        return AsyncThrowingStream { continuation in
            let task = Task {
                do {
                    for try await data in raw { continuation.yield(try Self.decode(T.self, data)) }
                    continuation.finish()
                } catch TransportError.notFound(let message) {
                    if let missing { continuation.yield(missing); continuation.finish() } else {
                        continuation.finish(throwing: TransportError.notFound(message))
                    }
                } catch {
                    continuation.finish(throwing: error)
                }
            }
            continuation.onTermination = { _ in task.cancel() }
        }
    }

    private func command(_ name: String, _ extra: [String: JSONValue]) async throws -> String {
        let data = try await transport.mutation(name, args(extra))
        // The mutation answers the command id as a bare string.
        return try Self.decode(String.self, data)
    }

    public func me() async throws -> PhoneIdentity {
        try Self.decode(PhoneIdentity.self, try await transport.query("phone:me", args()))
    }

    public func runners() -> AsyncThrowingStream<[PhoneRunner], Error> {
        live("phone:runners", [:], as: [PhoneRunner].self)
    }

    public func projects() -> AsyncThrowingStream<[PhoneProject], Error> {
        live("phone:projects", [:], as: [PhoneProject].self)
    }

    public func threads(_ view: ThreadsView) -> AsyncThrowingStream<[PhoneThread], Error> {
        live("phone:threads", ["view": .string(view.rawValue)], as: [PhoneThread].self)
    }

    public func inboxChanges() -> AsyncThrowingStream<[PhoneThread], Error> {
        AsyncThrowingStream { continuation in
            let task = Task {
                do {
                    let first = try Self.decode(ThreadsAtAnswer.self, try await transport.query("phone:threadsAt", args(["view": .string(ThreadsView.inbox.rawValue)])))
                    var list = InboxChanges(rows: first.rows, at: first.at)
                    continuation.yield(list.rows)
                    // Each answer can move where to ask from, which is a new
                    // subscription; the loop ends when the task is cancelled.
                    while !Task.isCancelled {
                        let since = list.since
                        var reload = false
                        for try await data in transport.subscribe("phone:threadsSince", args(["since": .number(since)])) {
                            let answer = try Self.decode(ThreadsSinceAnswer.self, data)
                            if answer.more == true {
                                reload = true
                                break
                            }
                            list.merge(answer)
                            continuation.yield(list.rows)
                            if list.since != since { break }
                        }
                        if reload {
                            // After the margin: loading now would ask from before
                            // the same burst and hear `more` again, over and over.
                            try await Task.sleep(for: .milliseconds(Int(InboxChanges.marginMs) + 1000))
                            let again = try Self.decode(ThreadsAtAnswer.self, try await transport.query("phone:threadsAt", args(["view": .string(ThreadsView.inbox.rawValue)])))
                            list = InboxChanges(rows: again.rows, at: again.at)
                            continuation.yield(list.rows)
                        } else if list.since == since, !Task.isCancelled {
                            // The subscription ended with nothing new (a test
                            // transport); nothing more will come.
                            break
                        }
                    }
                    continuation.finish()
                } catch {
                    continuation.finish(throwing: error)
                }
            }
            continuation.onTermination = { _ in task.cancel() }
        }
    }

    public func search(_ text: String) async throws -> [PhoneThread] {
        try Self.decode([PhoneThread].self, try await transport.query("phone:search", args(["text": .string(text)])))
    }

    public func pocket() -> AsyncThrowingStream<[PocketCard], Error> {
        live("phone:pocket", [:], as: [PocketCard].self)
    }

    public func removePocketCard(id: String) async throws {
        _ = try await transport.mutation("phone:removePocketCard", args(["id": .string(id)]))
    }

    public func schedules() -> AsyncThrowingStream<[PhoneSchedule], Error> {
        live("phone:schedules", [:], as: [PhoneSchedule].self)
    }

    public func counts() -> AsyncThrowingStream<PhoneCounts, Error> {
        live("phone:counts", [:], as: PhoneCounts.self)
    }

    public func thread(_ threadId: String) -> AsyncThrowingStream<ThreadDetail?, Error> {
        live("phone:thread", ["threadId": .string(threadId)], as: ThreadDetail?.self, missing: .some(nil))
    }

    public func messages(_ threadId: String, limit: Int) -> AsyncThrowingStream<MessagePage, Error> {
        live("phone:messages", ["threadId": .string(threadId), "limit": .number(Double(limit)), "tools": .bool(true)], as: MessagePage.self)
    }

    public func command(_ commandId: String) -> AsyncThrowingStream<CommandStatus?, Error> {
        live("phone:command", ["commandId": .string(commandId)], as: CommandStatus?.self, missing: .some(nil))
    }

    public func waiting(_ threadId: String) -> AsyncThrowingStream<[WaitingSend], Error> {
        live("phone:waiting", ["threadId": .string(threadId)], as: [WaitingSend].self)
    }

    public func cancel(_ commandId: String) async throws -> Bool {
        try Self.decode(Bool.self, try await transport.mutation("phone:cancel", args(["commandId": .string(commandId)])))
    }

    public func connectionStates() -> AsyncStream<Bool> { transport.connectionStates() }

    public func uploadPhoto(_ jpeg: Data) async throws -> String {
        let answer = try await transport.mutation("phone:imageUploadUrl", args())
        guard let url = URL(string: try Self.decode(String.self, answer)) else {
            throw TransportError.server("Couldn't upload the photo.")
        }
        struct Uploaded: Decodable { var storageId: String }
        return try Self.decode(Uploaded.self, try await post(url, jpeg)).storageId
    }

    public func discardPhoto(_ storageId: String) async throws {
        _ = try await transport.mutation("phone:discardImage", args(["storageId": .string(storageId)]))
    }

    public func send(threadId: String, text: String, answers: [AskAnswer], images: [String]) async throws -> String {
        var args: [String: JSONValue] = ["threadId": .string(threadId), "text": .string(text)]
        // Likewise: a backend before API 18 refuses it.
        if !images.isEmpty { args["images"] = .array(images.map { .string($0) }) }
        // Only when there are some: a backend before API 14 refuses the field.
        if !answers.isEmpty {
            args["answers"] = .array(answers.map { .object(["action": .string($0.action), "answer": .string($0.answer)]) })
        }
        return try await command("phone:send", args)
    }

    public func press(threadId: String, buttonId: String) async throws -> String {
        try await command("phone:press", ["threadId": .string(threadId), "buttonId": .string(buttonId)])
    }

    public func respond(threadId: String, approvalId: String, decision: ApprovalOption) async throws -> String {
        try await command("phone:respond", [
            "threadId": .string(threadId), "approvalId": .string(approvalId), "decision": .string(decision.rawValue),
        ])
    }

    public func answer(threadId: String, approvalId: String, answers: [String: String], summary: String) async throws -> String {
        try await command("phone:answer", [
            "threadId": .string(threadId), "approvalId": .string(approvalId),
            "answers": .object(answers.mapValues { .string($0) }), "message": .string(summary),
        ])
    }

    public func secret(threadId: String, approvalId: String, answer: SecretAnswer) async throws -> String {
        var extra: [String: JSONValue] = ["threadId": .string(threadId), "approvalId": .string(approvalId)]
        switch answer {
        case let .sealed(sealed):
            extra["sealed"] = .object(["epk": .string(sealed.epk), "nonce": .string(sealed.nonce), "box": .string(sealed.box)])
        case .decline:
            extra["decline"] = .bool(true)
        }
        return try await command("phone:secret", extra)
    }

    public func update(threadId: String, change: ThreadChange) async throws -> String {
        try await command("phone:update", ["threadId": .string(threadId), "change": change.json])
    }

    public func accounts() -> AsyncThrowingStream<[PhoneAccount], Error> {
        live("phone:accounts", [:], as: [PhoneAccount].self)
    }

    public func create(text: String, runnerId: String?, cwd: String?, images: [String], settings: NewThreadSettings) async throws -> String {
        var extra: [String: JSONValue] = ["text": .string(text)]
        if let model = settings.model { extra["model"] = .string(model) }
        if let effort = settings.effort { extra["effort"] = .string(effort) }
        if !images.isEmpty { extra["images"] = .array(images.map { .string($0) }) }
        if let runnerId { extra["runnerId"] = .string(runnerId) }
        if let cwd { extra["cwd"] = .string(cwd) }
        return try await command("phone:create", extra)
    }

    public func quickAsk(_ ask: QuickAskRecord) async throws -> String {
        var extra: [String: JSONValue] = [
            "question": .string(ask.question), "answer": .string(ask.answer),
            "askedAt": .number(ask.askedAt.timeIntervalSince1970 * 1000),
        ]
        if !ask.sources.isEmpty {
            extra["sources"] = .array(ask.sources.map { .object(["title": .string($0.title), "url": .string($0.url)]) })
        }
        return try await command("phone:quickAsk", extra)
    }

    public func loadEarlier(threadId: String, beforeSeq: Int) async throws -> String {
        try await command("phone:loadEarlier", ["threadId": .string(threadId), "beforeSeq": .number(Double(beforeSeq))])
    }

    public func registerDevice(apnsToken: String, environment: String, pushKey: String?) async throws {
        var extra: [String: JSONValue] = ["apnsToken": .string(apnsToken), "environment": .string(environment)]
        if let pushKey { extra["pushKey"] = .string(pushKey) }
        _ = try await transport.mutation("phone:registerDevice", args(extra))
    }

    public func setNotifications(apnsToken: String, notify: NotifyMode) async throws {
        _ = try await transport.mutation("phone:setNotifications", args([
            "apnsToken": .string(apnsToken), "notify": .string(notify.rawValue),
        ]))
    }

    public func setRunnerOrder(_ runnerIds: [String]) async throws {
        _ = try await transport.mutation("phone:setRunnerOrder", args(["runnerIds": .array(runnerIds.map { .string($0) })]))
    }
}

/// A spoken question and the answer the archive server gave, for `Backend.quickAsk`. Clipped to
/// what phone:quickAsk takes.
public struct QuickAskRecord: Sendable, Equatable {
    public struct Source: Sendable, Equatable {
        public var title: String
        public var url: String
        public init(title: String, url: String) { self.title = title; self.url = url }
    }

    public var question: String
    public var answer: String
    public var sources: [Source]
    public var askedAt: Date

    public init(question: String, answer: String, sources: [Source], askedAt: Date) {
        self.question = String(question.trimmingCharacters(in: .whitespacesAndNewlines).prefix(2000))
        self.answer = String(answer.trimmingCharacters(in: .whitespacesAndNewlines).prefix(20000))
        self.sources = Array(sources.filter { !$0.url.isEmpty }.prefix(10))
        self.askedAt = askedAt
    }

    /// Worth keeping: there's a question and some answer.
    public var isWorthKeeping: Bool { !question.isEmpty && !answer.isEmpty }
}

/// The answers map for a question card, as the Mac app builds it
/// (Cells.swift): chosen labels per question, joined with ", "; typed text
/// replaces a single choice on the last question and is added to a
/// multiple one.
public enum Answers {
    public static func build(_ questions: [Question], chosen: [Int: Set<String>], typed: String) -> [String: String] {
        var answers: [String: String] = [:]
        let typed = typed.trimmingCharacters(in: .whitespacesAndNewlines)
        let last = questions.count - 1
        for (index, question) in questions.enumerated() {
            var parts = question.options.map(\.label).filter { chosen[index]?.contains($0) == true }
            if !typed.isEmpty, index == last {
                if question.multiSelect { parts.append(typed) } else { parts = [typed] }
            }
            if !parts.isEmpty { answers[question.question] = parts.joined(separator: ", ") }
        }
        return answers
    }

    /// One line for the transcript: "Which database? Convex · Tests? Yes".
    public static func summary(_ questions: [Question], answers: [String: String]) -> String {
        questions.compactMap { q in answers[q.question].map { questions.count == 1 ? $0 : "\(q.header ?? q.question) \($0)" } }
            .joined(separator: " · ")
    }
}

/// phone:threadsAt: a list, and when it was read.
struct ThreadsAtAnswer: Decodable, Sendable {
    var rows: [PhoneThread]
    var at: Double
}

/// phone:threadsSince: rows written since, in any view, and threads gone.
struct ThreadsSinceAnswer: Decodable, Sendable {
    struct Row: Decodable, Sendable {
        var thread: PhoneThread
        var view: String
        var updatedMs: Double
        private enum Keys: String, CodingKey { case view, updatedMs }
        init(from decoder: Decoder) throws {
            thread = try PhoneThread(from: decoder)
            let c = try decoder.container(keyedBy: Keys.self)
            view = try c.decode(String.self, forKey: .view)
            updatedMs = try c.decode(Double.self, forKey: .updatedMs)
        }
    }
    var rows: [Row]
    var gone: [String]
    var more: Bool?
}

/// The inbox as a phone holds it while following phone:threadsSince.
struct InboxChanges: Sendable {
    /// A row is stamped by the mutation that wrote it, which can commit just
    /// after one stamped later, so it asks from a little before the newest.
    static let marginMs: Double = 5000
    private(set) var rows: [PhoneThread]
    private(set) var since: Double

    init(rows: [PhoneThread], at: Double) {
        self.rows = rows
        since = at - Self.marginMs
    }

    mutating func merge(_ answer: ThreadsSinceAnswer) {
        var byId = Dictionary(rows.map { ($0.threadId, $0) }, uniquingKeysWith: { _, new in new })
        for row in answer.rows {
            if row.view == ThreadsView.inbox.rawValue { byId[row.thread.threadId] = row.thread } else { byId[row.thread.threadId] = nil }
            since = max(since, row.updatedMs - Self.marginMs)
        }
        for id in answer.gone { byId[id] = nil }
        rows = byId.values.sorted { $0.lastActivityAt > $1.lastActivityAt }
    }
}
