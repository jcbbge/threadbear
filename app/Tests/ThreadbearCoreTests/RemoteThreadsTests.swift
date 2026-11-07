import Foundation
import XCTest
@testable import ThreadbearCore

/// Other runners' threads (docs/protocol.md, "Other runners' threads"): the
/// list, its rows as sidebar summaries, and which runner a thread's
/// requests go to.
final class RemoteThreadsTests: XCTestCase {
    private func decode(_ object: [String: Any]) throws -> RemoteThreads {
        try JSONDecoder().decode(RemoteThreads.self, from: Data(E.json(object).utf8))
    }

    /// Mike's runner order (backend API 58), the same one the phone sets,
    /// for Settings > Runners. An older runner has none: nil, not empty.
    func testCarriesTheRunnerOrder() throws {
        XCTAssertEqual(try decode(["runners": [], "threads": [], "order": ["r_m5", "r_bruce"]]).order, ["r_m5", "r_bruce"])
        XCTAssertNil(try decode(["runners": [], "threads": []]).order)
        XCTAssertNil(try decode(["runners": [], "threads": [], "order": "nonsense"]).order)
    }

    func testDecodesTolerantly() throws {
        let list = try decode([
            "runners": [
                ["id": "r_bruce", "name": "bruce", "icon": "macmini", "online": true, "lastSeenAt": "2026-10-29T10:00:00Z",
                 "rpcUrl": "wss://bruce.example.ts.net/rpc", "tokenFile": "/tmp/tb/secrets/runners/r_bruce.token", "extra": 1],
                // Nothing but an id: named by it, offline, can't be opened.
                ["id": "r_studio", "name": "", "rpcUrl": ""],
                // No id: dropped, not the whole list.
                ["name": "nobody"],
            ],
            "threads": [
                ["runnerId": "r_bruce", "threadId": "t1", "title": "Backup", "cwd": "/Users/bruce/misc", "accountId": "claude-main",
                 "provider": "claude", "model": "opus", "status": "running", "needsYou": false, "unread": true, "preview": "Going",
                 "createdAt": "2026-10-29T09:00:00Z", "lastActivityAt": "2026-10-29T09:30:00Z", "future": ["x": 1]],
                ["runnerId": "r_studio", "threadId": "t2", "status": "something-new"],
                ["runnerId": "r_bruce"],
            ],
        ])
        XCTAssertEqual(list.runners.map(\.id), ["r_bruce", "r_studio"])
        let bruce = try XCTUnwrap(list.runner("r_bruce"))
        XCTAssertEqual(bruce.name, "bruce")
        XCTAssertEqual(bruce.icon, "macmini")
        XCTAssertTrue(bruce.online)
        XCTAssertEqual(bruce.rpcUrl?.absoluteString, "wss://bruce.example.ts.net/rpc")
        XCTAssertEqual(bruce.tokenFile, "/tmp/tb/secrets/runners/r_bruce.token")
        XCTAssertNotNil(bruce.lastSeenAt)
        let studio = try XCTUnwrap(list.runner("r_studio"))
        XCTAssertEqual(studio.name, "r_studio")
        XCTAssertFalse(studio.online)
        XCTAssertNil(studio.rpcUrl)
        XCTAssertNil(studio.tokenFile)

        XCTAssertEqual(list.threads.map(\.threadId), ["t1", "t2"])
        XCTAssertEqual(list.threads[0].status, .running)
        XCTAssertEqual(list.threads[0].model, "opus")
        XCTAssertEqual(list.threads[1].status, .idle, "a status this app doesn't know reads as idle")
        XCTAssertEqual(list.threads[1].provider, "claude")
        XCTAssertEqual(list.threads[1].lastActivityAt, list.threads[1].createdAt)

        XCTAssertEqual(try decode([:]), RemoteThreads(), "an empty answer is none")
    }

    func testRowsBecomeSummariesMarkedWithTheirRunner() throws {
        let created = Date(timeIntervalSince1970: 1_800_000_000)
        let unread = RemoteThread(runnerId: "r_bruce", threadId: "t1", title: "Backup", cwd: "/Users/bruce/misc", model: "opus",
                                  needsYou: true, unread: true, preview: "Done", createdAt: created, lastActivityAt: created.addingTimeInterval(60))
        let summary = unread.summary
        XCTAssertEqual(summary.id, "t1")
        XCTAssertEqual(summary.runnerId, "r_bruce")
        XCTAssertTrue(summary.isRemote)
        XCTAssertEqual(summary.title, "Backup")
        XCTAssertEqual(summary.model, "opus")
        XCTAssertEqual(summary.lastActivityAt, created.addingTimeInterval(60))
        XCTAssertGreaterThan(summary.lastSeq, summary.lastSeenSeq, "unread shows as unread")
        XCTAssertTrue(ThreadRowLook(summary).unread)

        let read = RemoteThread(runnerId: "r_bruce", threadId: "t2").summary
        XCTAssertEqual(read.lastSeq, read.lastSeenSeq)

        let untilRestart = RemoteThread(runnerId: "r_bruce", threadId: "t3", snoozedUntil: ISO8601.parse("9999-12-31T00:00:00.000Z")).summary
        XCTAssertTrue(untilRestart.snoozedUntilRestart)
        let untilMonday = RemoteThread(runnerId: "r_bruce", threadId: "t4", snoozedUntil: Date().addingTimeInterval(86_400)).summary
        XCTAssertFalse(untilMonday.snoozedUntilRestart)

        // Never on the wire: a runner's summaries are all its own.
        let encoded = try JSONSerialization.jsonObject(with: JSONEncoder().encode(summary)) as? [String: Any]
        XCTAssertNil(encoded?["runnerId"])
        XCTAssertNil(try JSONDecoder().decode(ThreadSummary.self, from: JSONEncoder().encode(summary)).runnerId)
    }

    func testRemoteThreadsSortIntoSectionsLikeLocalOnes() {
        let now = Date()
        let local = ThreadSummary(id: "local", title: "Here", status: .idle, needsYou: true, lastActivityAt: now.addingTimeInterval(-600))
        let list = RemoteThreads(runners: [RemoteRunner(id: "r", name: "bruce")], threads: [
            RemoteThread(runnerId: "r", threadId: "needy", needsYou: true, unread: true, lastActivityAt: now.addingTimeInterval(-60)),
            RemoteThread(runnerId: "r", threadId: "busy", status: .running, lastActivityAt: now),
            RemoteThread(runnerId: "r", threadId: "idle", lastActivityAt: now.addingTimeInterval(-7200)),
            RemoteThread(runnerId: "r", threadId: "away", snoozedUntil: now.addingTimeInterval(3600)),
            RemoteThread(runnerId: "r", threadId: "gone", archivedAt: now),
        ])
        let sections = ThreadSections.build([local] + list.summaries, now: now)
        XCTAssertEqual(sections.inbox.map(\.id), ["needy", "local", "idle"], "needing Mike first, newest first within that")
        XCTAssertEqual(sections.running.map(\.id), ["busy"])
        XCTAssertEqual(sections.hibernating.map(\.id), ["away"])
        XCTAssertEqual(sections.archived.map(\.id), ["gone"])
    }

    func testListFallsBackToNoneOnAnOlderRunner() async throws {
        let transport = FakeTransport()
        transport.onSend = { request in
            [E.json(["jsonrpc": "2.0", "id": request["id"]!, "error": ["code": -32601, "message": "Unknown method remoteThreads.list"]])]
        }
        let client = RPCClient(transport: transport)
        try await client.start()
        let list = try await client.remoteThreads()
        XCTAssertEqual(list, RemoteThreads())
        XCTAssertEqual(transport.sent.first?["method"] as? String, "remoteThreads.list")
    }

    func testListAndUpdatedNotification() async throws {
        let transport = FakeTransport()
        // As text, so the responder closure can hold it.
        let answer = E.json([
            "runners": [["id": "r_bruce", "name": "bruce", "online": true]],
            "threads": [["runnerId": "r_bruce", "threadId": "t1", "title": "Backup"]],
        ])
        transport.onSend = { request in ["{\"jsonrpc\":\"2.0\",\"id\":\(request["id"] as! Int),\"result\":\(answer)}"] }
        let client = RPCClient(transport: transport)
        try await client.start()
        let list = try await client.remoteThreads()
        XCTAssertEqual(list.threads.first?.title, "Backup")

        var iterator = client.notifications.makeAsyncIterator()
        transport.push("{\"jsonrpc\":\"2.0\",\"method\":\"remoteThreads.updated\",\"params\":\(answer)}")
        guard case .remoteThreadsUpdated(let updated)? = await iterator.next() else { return XCTFail("no remoteThreads.updated") }
        XCTAssertEqual(updated, list)
    }

    func testRouteFollowsTheThreadsRunner() {
        let bruce = RemoteRunner(id: "r_bruce", name: "bruce")
        var remote = ThreadSummary(id: "t1", title: "")
        remote.runnerId = "r_bruce"
        var orphan = ThreadSummary(id: "t2", title: "")
        orphan.runnerId = "r_gone"
        XCTAssertEqual(ThreadRoute.of(ThreadSummary(id: "t0", title: ""), runners: [bruce]), .local)
        XCTAssertEqual(ThreadRoute.of(nil, runners: [bruce]), .local, "no thread (a new one) is this Mac's")
        XCTAssertEqual(ThreadRoute.of(remote, runners: [bruce]), .remote(bruce))
        XCTAssertEqual(ThreadRoute.of(orphan, runners: [bruce]), .unknownRunner("r_gone"))
    }

    func testUnreachableSaysWhy() {
        let bruce = RemoteRunner(id: "r_bruce", name: "bruce", online: false)
        XCTAssertEqual(RemoteUnreachable(bruce, .noToken).headline, "Can't reach bruce from this Mac.")
        XCTAssertTrue(RemoteUnreachable(bruce, .noToken).detail.contains("secrets/runners/r_bruce.token"))
        XCTAssertEqual(RemoteUnreachable.from(RPCError.unauthorized, runner: bruce).reason, .refused)
        let offline = RemoteUnreachable.from(RPCError.connectFailed("timed out"), runner: bruce)
        XCTAssertEqual(offline.localizedDescription, "It's offline, or Tailscale is off on one of the Macs.")
        var online = bruce
        online.online = true
        XCTAssertEqual(RemoteUnreachable.from(RPCError.connectFailed("timed out"), runner: online).detail, "It didn't answer (timed out).")
        XCTAssertFalse(offline.detail.contains("—"), "no em dashes in UI copy")
    }
}

/// The connections to other runners, over fake transports.
@MainActor
final class RemoteClientsTests: XCTestCase {
    private let url = URL(string: "wss://bruce.example.ts.net/rpc")!

    /// A transport that answers hello and remembers what it was made with.
    private final class Made: @unchecked Sendable {
        var transports: [(url: URL, token: String, transport: FakeTransport)] = []
    }

    private func clients(_ made: Made, tokens: [String: String] = ["/tokens/bruce": "secret"]) -> RemoteClients {
        RemoteClients(version: "test", makeTransport: { url, token in
            let transport = FakeTransport()
            transport.onSend = { request in
                guard request["method"] as? String == "hello" else { return [E.json(["jsonrpc": "2.0", "id": request["id"]!, "result": [:]])] }
                return [E.json(["jsonrpc": "2.0", "id": request["id"]!, "result": [
                    "runnerVersion": "0.1.0", "protocol": 1, "accounts": [], "defaults": ["cwd": "/Users/bruce", "accountId": "claude-main"],
                ]])]
            }
            made.transports.append((url, token, transport))
            return transport
        }, readToken: { tokens[$0] }, pins: .memory(["/tokens/bruce": "bruce.example.ts.net"]))
    }

    func testNoTokenOrAddressCantBeOpened() async {
        let made = Made()
        let remote = clients(made)
        for (runner, reason) in [
            (RemoteRunner(id: "r_bruce", name: "bruce", rpcUrl: url), RemoteUnreachable.Reason.noToken),
            (RemoteRunner(id: "r_bruce", name: "bruce", rpcUrl: url, tokenFile: "/tokens/missing"), .noToken),
            (RemoteRunner(id: "r_bruce", name: "bruce", tokenFile: "/tokens/bruce"), .noAddress),
        ] {
            do {
                _ = try await remote.client(for: runner)
                XCTFail("expected \(reason)")
            } catch let error as RemoteUnreachable {
                XCTAssertEqual(error.reason, reason)
                XCTAssertEqual(error.runnerName, "bruce")
            } catch {
                XCTFail("unexpected \(error)")
            }
        }
        XCTAssertTrue(made.transports.isEmpty, "nothing is dialled without both")
    }

    func testConnectsWithTheTokenOnceAndRoutesToIt() async throws {
        let made = Made()
        let remote = clients(made)
        var connected: [String] = []
        remote.onConnected = { id, _ in connected.append(id) }
        let bruce = RemoteRunner(id: "r_bruce", name: "bruce", rpcUrl: url, tokenFile: "/tokens/bruce")
        let local = RPCClient(transport: FakeTransport())

        XCTAssertNil(remote.client(for: .remote(bruce), local: local), "not before it's connected")
        let client = try await remote.client(for: bruce)
        XCTAssertEqual(made.transports.count, 1)
        XCTAssertEqual(made.transports[0].url, url)
        XCTAssertEqual(made.transports[0].token, "secret")
        XCTAssertEqual(made.transports[0].transport.sent.first?["method"] as? String, "hello")
        XCTAssertEqual(connected, ["r_bruce"])

        let again = try await remote.client(for: bruce)
        XCTAssertTrue(again === client, "one connection per runner")
        XCTAssertEqual(made.transports.count, 1)

        XCTAssertTrue(remote.client(for: .remote(bruce), local: local) === client)
        XCTAssertTrue(remote.client(for: .local, local: local) === local)
        XCTAssertNil(remote.client(for: .unknownRunner("r_gone"), local: local))
        XCTAssertEqual(remote.connectedRunners, ["r_bruce"])
    }

    func testTwoOpensAtOnceShareOneConnection() async throws {
        let made = Made()
        let remote = clients(made)
        let bruce = RemoteRunner(id: "r_bruce", name: "bruce", rpcUrl: url, tokenFile: "/tokens/bruce")
        async let first = remote.client(for: bruce)
        async let second = remote.client(for: bruce)
        let (a, b) = try await (first, second)
        XCTAssertTrue(a === b)
        XCTAssertEqual(made.transports.count, 1)
    }

    func testNotificationsComeWithTheRunnerAndADropIsSaid() async throws {
        let made = Made()
        let remote = clients(made)
        var heard: [(String, String)] = []
        var closed: [String] = []
        remote.onNotification = { id, notification in
            if case .threadUpdated(let thread) = notification { heard.append((id, thread.id)) }
        }
        remote.onClosed = { closed.append($0) }
        let bruce = RemoteRunner(id: "r_bruce", name: "bruce", rpcUrl: url, tokenFile: "/tokens/bruce")
        _ = try await remote.client(for: bruce)
        let transport = made.transports[0].transport
        transport.push(E.json(["jsonrpc": "2.0", "method": "thread.updated", "params": ["thread": ["id": "t1", "title": "Backup"]]]))
        for _ in 0..<200 where heard.isEmpty { try await Task.sleep(for: .milliseconds(5)) }
        XCTAssertEqual(heard.first?.0, "r_bruce")
        XCTAssertEqual(heard.first?.1, "t1")

        transport.close(with: .disconnected("gone"))
        for _ in 0..<200 where closed.isEmpty { try await Task.sleep(for: .milliseconds(5)) }
        XCTAssertEqual(closed, ["r_bruce"])
        XCTAssertNil(remote.connected("r_bruce"))
        XCTAssertNil(remote.client(for: .remote(bruce), local: nil))
    }

    func testCloseLetsItGo() async throws {
        let made = Made()
        let remote = clients(made)
        var closed: [String] = []
        remote.onClosed = { closed.append($0) }
        let bruce = RemoteRunner(id: "r_bruce", name: "bruce", rpcUrl: url, tokenFile: "/tokens/bruce")
        let client = try await remote.client(for: bruce)
        remote.close("r_bruce")
        XCTAssertTrue(client.isClosed)
        XCTAssertEqual(closed, ["r_bruce"])
        try await Task.sleep(for: .milliseconds(30))
        XCTAssertEqual(closed, ["r_bruce"], "said once, not again when its stream ends")
        _ = try await remote.client(for: bruce)
        XCTAssertEqual(made.transports.count, 2, "opened afresh next time")
    }

    func testRefusedTokenSaysSo() async {
        let remote = RemoteClients(version: "test", makeTransport: { _, _ in
            let transport = FakeTransport()
            transport.openError = .unauthorized
            return transport
        }, readToken: { _ in "wrong" }, pins: .memory(["/tokens/bruce": "bruce.example.ts.net"]))
        let bruce = RemoteRunner(id: "r_bruce", name: "bruce", online: true, rpcUrl: url, tokenFile: "/tokens/bruce")
        do {
            _ = try await remote.client(for: bruce)
            XCTFail("expected a refusal")
        } catch let error as RemoteUnreachable {
            XCTAssertEqual(error.reason, .refused)
        } catch {
            XCTFail("unexpected \(error)")
        }
        XCTAssertNil(remote.connected("r_bruce"))
    }

    func testAnotherRunnersThreadCarriesItsBylineToTheRow() throws {
        let json = #"{"runnerId":"r","threadId":"t","title":"t","cwd":"/x/misc","status":"idle","startedBy":{"kind":"tool","label":"Sentry","why":"2 events"}}"#
        let summary = try JSONDecoder().decode(RemoteThread.self, from: Data(json.utf8)).summary
        XCTAssertEqual(ThreadByline.line(summary), .init(symbol: ThreadByline.toolSymbol, text: "misc", tip: "Started by Sentry (2 events)"))
        XCTAssertNil(RemoteThread(runnerId: "r", threadId: "t2").summary.startedBy)
    }

    func testAnotherRunnersThreadNamesItsPlaceWithWhatMikeAskedAsItsTip() throws {
        let json = #"{"runnerId":"r","threadId":"t","title":"t","cwd":"/x/misc","status":"idle","preview":"Backup done","asked":"try the GPU route"}"#
        let summary = try JSONDecoder().decode(RemoteThread.self, from: Data(json.utf8)).summary
        XCTAssertEqual(ProjectMark.place(summary), "misc")
        XCTAssertEqual(ProjectMark.lineTip(summary), "You: try the GPU route")
    }

    func testAToolResultSaysWhereItsOutputCanBeAskedFor() throws {
        let json = #"{"itemId":"relay-5","ok":true,"text":"The output is kept on bruce.","truncated":false,"images":[],"heldBack":{"seq":5}}"#
        let held = try JSONDecoder().decode(ToolResult.self, from: Data(json.utf8))
        XCTAssertEqual(held.heldBackSeq, 5)
        let plain = try JSONDecoder().decode(ToolResult.self, from: Data(#"{"itemId":"i","ok":true,"text":"x","truncated":false,"images":[]}"#.utf8))
        XCTAssertNil(plain.heldBackSeq)
    }
}
