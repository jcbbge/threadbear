import Foundation
import Testing
@testable import ThreadbearKit

/// The real ConvexBackend against a running deployment, the same code the
/// app uses. Off unless TB_LIVE_URL and TB_LIVE_TOKEN are set, e.g. the
/// local `npx convex dev` backend with a dev phone token:
///
///   TB_LIVE_URL=http://127.0.0.1:3210 TB_LIVE_TOKEN=tb_… swift test --filter LiveBackend
///
/// Needs at least one inbox thread in the mirror (a runner, or sync:upsertThreads).
@Suite(.enabled(if: ProcessInfo.processInfo.environment["TB_LIVE_TOKEN"] != nil))
struct LiveBackendTests {
    let backend: ConvexBackend

    init() {
        let env = ProcessInfo.processInfo.environment
        backend = ConvexBackend(deploymentURL: URL(string: env["TB_LIVE_URL"] ?? "http://127.0.0.1:3210")!,
                                token: env["TB_LIVE_TOKEN"] ?? "")
    }

    @Test func readsAndQueuesCommands() async throws {
        let me = try await backend.me()
        #expect(!me.name.isEmpty)

        var runners = backend.runners().makeAsyncIterator()
        _ = try #require(try await runners.next())

        var inbox = backend.threads(.inbox).makeAsyncIterator()
        let threads = try #require(try await inbox.next())
        let thread = try #require(threads.first)

        var detailStream = backend.thread(thread.threadId).makeAsyncIterator()
        let detail = try #require(try await detailStream.next() ?? nil)
        #expect(detail.thread.threadId == thread.threadId)

        // Each write lands as a pending command for the runner to apply.
        let sent = try await backend.send(threadId: thread.threadId, text: "From the live test")
        var status = backend.command(sent).makeAsyncIterator()
        #expect(try await status.next()??.state == .pending)
        _ = try await backend.update(threadId: thread.threadId, change: .snooze(until: .now.addingTimeInterval(3600)))
        _ = try await backend.update(threadId: thread.threadId, change: .rename("Renamed from the test"))
        _ = try await backend.answer(threadId: thread.threadId, approvalId: "x", answers: ["Which?": "A, B"], summary: "A, B")
        _ = try await backend.respond(threadId: thread.threadId, approvalId: "x", decision: .allowAlways)
        _ = try await backend.create(text: "A new thread from the test", runnerId: nil, cwd: nil)
        try await backend.registerDevice(apnsToken: String(repeating: "0f", count: 32), environment: "sandbox", pushKey: nil)
    }

    @Test func aMissingThreadIsNil() async throws {
        var stream = backend.thread("no-such-thread").makeAsyncIterator()
        #expect(try await stream.next() == .some(nil))
    }

    @Test func aBadTokenIsUnauthorized() async throws {
        let env = ProcessInfo.processInfo.environment
        let bad = ConvexBackend(deploymentURL: URL(string: env["TB_LIVE_URL"] ?? "http://127.0.0.1:3210")!, token: "tb_nope")
        await #expect(throws: TransportError.self) { _ = try await bad.me() }
        do { _ = try await bad.me() } catch let error as TransportError {
            guard case .unauthorized = error else { Issue.record("expected unauthorized, got \(error)"); return }
        }
    }
}
