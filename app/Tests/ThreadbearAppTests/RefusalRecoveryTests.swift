import AppKit
import Observation
import XCTest
@testable import Threadbear
import ThreadbearCore

final class RefusalRecoveryTests: XCTestCase {
    private let refusal = "API Error: Opus 5.5's safeguards flagged this message. Claude Code can't respond to this message with Opus 5.5. Details: [reasoning_extraction]"
    private let sol = ModelChoice(id: "gpt-6.1-sol", model: "gpt-6.1-sol", title: "GPT-6.1-Sol")

    func testRecognisesTheProviderRefusalWithoutMatchingOrdinaryErrors() {
        XCTAssertTrue(RefusalRecovery.isRefusal(refusal))
        XCTAssertTrue(RefusalRecovery.isRefusal("API Error: Claude's safeguards flagged this message"))
        for text in ["Failed to authenticate", "Rate limit reached", "Network error", "Please investigate reasoning_extraction", "The app's safeguards flagged this message"] {
            XCTAssertFalse(RefusalRecovery.isRefusal(text), text)
        }
    }

    func testOnlyOffersForTheLatestFailedClaudeTurn() {
        var thread = ThreadSummary(id: "t", title: "t", accountId: "claude-main", status: .error)
        var completion = TurnCompletion(turnId: "turn", outcome: .failed, durationMs: 1, error: refusal)
        let accounts = [Account(id: "codex-main", provider: "codex", title: "Codex", models: [sol])]
        XCTAssertNotNil(RefusalRecovery.target(thread: thread, completion: completion, accounts: accounts))
        completion.outcome = .completed
        XCTAssertNil(RefusalRecovery.target(thread: thread, completion: completion, accounts: accounts))
        completion.outcome = .failed
        thread.status = .running
        XCTAssertNil(RefusalRecovery.target(thread: thread, completion: completion, accounts: accounts))
        thread.status = .error
        thread.provider = "codex"
        XCTAssertNil(RefusalRecovery.target(thread: thread, completion: completion, accounts: accounts))
    }

    func testOnlyOffersALoginThatActuallyHasSolAndRoom() {
        let thread = ThreadSummary(id: "t", title: "t", accountId: "claude-main", status: .error)
        let completion = TurnCompletion(turnId: "turn", outcome: .failed, durationMs: 1, error: refusal)
        let blocked = AccountUsage(windows: [], blocked: true)
        let accounts = [
            Account(id: "unknown", provider: "codex", title: "Unknown"),
            Account(id: "blocked", provider: "codex", title: "Blocked", models: [sol], usage: blocked),
            Account(id: "noted", provider: "codex", title: "Work", models: [sol], note: "Work only"),
            Account(id: "ready", provider: "codex", title: "Ready", models: [sol]),
        ]
        XCTAssertEqual(RefusalRecovery.target(thread: thread, completion: completion, accounts: accounts)?.id, "ready")
        XCTAssertNil(RefusalRecovery.target(thread: thread, completion: completion, accounts: Array(accounts.prefix(3))))
        XCTAssertNil(RefusalRecovery.target(thread: thread, completion: nil, accounts: accounts))
    }
}

@MainActor
final class RefusalContinuationTests: XCTestCase {
    private func setup() async throws -> (AppModel, RefusalTransport) {
        _ = NSApplication.shared
        let app = AppModel()
        app.accounts = [Account(id: "codex-main", provider: "codex", title: "Codex",
                                models: [ModelChoice(id: "gpt-6.1-sol", model: "gpt-6.1-sol", title: "Sol")])]
        let transport = RefusalTransport()
        let client = RPCClient(transport: transport)
        try await client.start()
        app.useClientForTesting(client)
        app.threads["t"] = ThreadSummary(id: "t", title: "Fix it", accountId: "claude-main", status: .error)
        let session = app.session(for: "t")
        session.open(width: 800)
        try await until { session.state == .loaded }
        XCTAssertNotNil(app.refusalTarget(for: app.threads["t"]!))
        return (app, transport)
    }

    private func until(_ condition: () -> Bool) async throws {
        for _ in 0..<400 where !condition() { try await Task.sleep(for: .milliseconds(5)) }
        XCTAssertTrue(condition())
    }

    func testAwaitsSwitchBeforeSendingAndKeepsDraftAndIgnoresDoubleClick() async throws {
        let (app, transport) = try await setup()
        let draft = Draft(text: "Still writing this", images: [ImageRef(path: "/picture.png", mediaType: "image/png")])
        app.drafts["t"] = draft
        app.continueRefusal("t")
        app.continueRefusal("t")
        try await until { transport.updateId != nil }
        XCTAssertEqual(transport.methods.filter { $0 == "threads.update" }.count, 1)
        XCTAssertFalse(transport.methods.contains("threads.send"))
        XCTAssertEqual(transport.updateParams?["model"] as? String, "gpt-6.1-sol")
        XCTAssertEqual(transport.updateParams?["accountId"] as? String, "codex-main")
        transport.finishSwitch()
        try await until { !app.continuingRefusals.contains("t") }
        XCTAssertEqual(transport.methods.filter { $0 == "threads.send" }.count, 1)
        XCTAssertEqual(transport.sendParams?["text"] as? String, RefusalRecovery.continuation)
        XCTAssertEqual(transport.sendParams?["threadId"] as? String, "t")
        XCTAssertNil(transport.sendParams?["images"], "the unsent pictures must stay in the draft")
        XCTAssertEqual(app.drafts["t"], draft)
        XCTAssertNil(app.refusalTarget(for: app.threads["t"]!))
    }

    func testAFailedSwitchSendsNothingAndCanBeRetried() async throws {
        let (app, transport) = try await setup()
        app.continueRefusal("t")
        try await until { transport.updateId != nil }
        transport.finishSwitch(fail: true)
        try await until { !app.continuingRefusals.contains("t") }
        XCTAssertFalse(transport.methods.contains("threads.send"))
        XCTAssertEqual(app.errorMessage, "The login is unavailable")
        XCTAssertNotNil(app.refusalTarget(for: app.threads["t"]!))
    }

    func testAChangedModelListIsCheckedAgainOnClick() async throws {
        let (app, transport) = try await setup()
        app.accounts = []
        app.continueRefusal("t")
        XCTAssertTrue(app.continuingRefusals.isEmpty)
        XCTAssertNil(transport.updateId)
    }

    func testARunnerThatFallsBackToAnotherModelDoesNotGetAContinuation() async throws {
        let (app, transport) = try await setup()
        app.continueRefusal("t")
        try await until { transport.updateId != nil }
        transport.finishSwitch(model: "gpt-6-luna")
        try await until { !app.continuingRefusals.contains("t") }
        XCTAssertFalse(transport.methods.contains("threads.send"))
        XCTAssertEqual(app.errorMessage, "Codex Sol is no longer available. Choose a model to carry on.")
    }

    func testANewerSuccessfulCompletionHidesTheOffer() async throws {
        let (app, _) = try await setup()
        let session = app.session(for: "t")
        let redraw = expectation(description: "the offer observes a new completion")
        withObservationTracking {
            _ = app.refusalTarget(for: app.threads["t"]!)
        } onChange: { redraw.fulfill() }
        session.receive(Event(seq: 3, threadId: "t", turnId: "next", type: "turn.completed",
                              payload: .turnCompleted(TurnCompletion(turnId: "next", outcome: .completed, durationMs: 1))))
        session.flush()
        await fulfillment(of: [redraw], timeout: 1)
        XCTAssertNil(app.refusalTarget(for: app.threads["t"]!))
    }

    func testStartingAnotherTurnClearsTheOldRefusalEvenBeforeItsSummaryArrives() async throws {
        let (app, _) = try await setup()
        let session = app.session(for: "t")
        session.receive(Event(seq: 3, threadId: "t", turnId: "next", type: "turn.started", payload: .turnStarted()))
        session.flush()
        XCTAssertNil(app.refusalTarget(for: app.threads["t"]!))
    }
}

/// Hold the update reply so the test proves a continuation cannot race it.
private final class RefusalTransport: RPCTransport, @unchecked Sendable {
    private let lock = NSLock()
    private var inbox: [Data] = []
    private var waiter: CheckedContinuation<Data, Error>?
    private var calls: [[String: Any]] = []
    var methods: [String] { lock.withLock { calls.compactMap { $0["method"] as? String } } }
    var updateId: Int? { lock.withLock { calls.last { $0["method"] as? String == "threads.update" }?["id"] as? Int } }
    var updateParams: [String: Any]? { params("threads.update") }
    var sendParams: [String: Any]? { params("threads.send") }
    private func params(_ method: String) -> [String: Any]? {
        lock.withLock { calls.last { $0["method"] as? String == method }?["params"] as? [String: Any] }
    }
    func open() async throws {}
    func close() {}
    func send(_ text: String) async throws {
        let call = try JSONSerialization.jsonObject(with: Data(text.utf8)) as! [String: Any]
        guard let id = call["id"] as? Int, let method = call["method"] as? String else { return }
        lock.withLock { calls.append(call) }
        if method == "threads.update" { return }
        let result: [String: Any]
        if method == "threads.events" {
            result = ["events": [
                ["seq": 1, "threadId": "t", "turnId": "failed", "type": "error", "message": "API Error: Claude's safeguards flagged this message. Details: [reasoning_extraction]"],
                ["seq": 2, "threadId": "t", "turnId": "failed", "type": "turn.completed", "outcome": "failed", "durationMs": 1,
                 "error": "API Error: Claude's safeguards flagged this message. Details: [reasoning_extraction]"],
            ], "atStart": true]
        } else { result = ["turnId": "continued", "events": []] }
        reply(["jsonrpc": "2.0", "id": id, "result": result])
    }
    func finishSwitch(fail: Bool = false, model: String = "gpt-6.1-sol") {
        guard let id = updateId else { return }
        if fail {
            reply(["jsonrpc": "2.0", "id": id, "error": ["code": -32000, "message": "The login is unavailable"]])
        } else {
            reply(["jsonrpc": "2.0", "id": id, "result": ["thread": ["id": "t", "title": "Fix it", "status": "error",
                    "provider": "codex", "accountId": "codex-main", "model": model]]])
        }
    }
    func receive() async throws -> Data {
        try await withCheckedThrowingContinuation { continuation in
            lock.lock()
            if !inbox.isEmpty {
                let data = inbox.removeFirst()
                lock.unlock()
                continuation.resume(returning: data)
            } else {
                waiter = continuation
                lock.unlock()
            }
        }
    }
    private func reply(_ object: [String: Any]) {
        let data = try! JSONSerialization.data(withJSONObject: object)
        lock.lock()
        if let waiter {
            self.waiter = nil
            lock.unlock()
            waiter.resume(returning: data)
        } else {
            inbox.append(data)
            lock.unlock()
        }
    }
}
