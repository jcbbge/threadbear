import Foundation
import Testing
@testable import ThreadbearKit

/// The sample backend can take its time over an answer, or refuse it, the way a
/// real runner can, so the app's cards can be seen waiting and failing.
@Suite struct SlowAnswersTests {
    private func status(_ fake: FakeBackend, _ id: String) async throws -> CommandStatus? {
        var iterator = fake.command(id).makeAsyncIterator()
        return try await iterator.next() ?? nil
    }

    private func pending(_ fake: FakeBackend, _ id: String) async throws -> PendingApproval? {
        var iterator = fake.thread(id).makeAsyncIterator()
        return try await iterator.next()??.thread.pendingApproval
    }

    @Test func aSlowAnswerWaitsThenLands() async throws {
        let fake = FakeBackend(turnDelay: .seconds(60))
        fake.answerDelay = .milliseconds(100)
        let id = try await fake.respond(threadId: "a1", approvalId: "ap1", decision: .allow)
        #expect(try await status(fake, id)?.state == .pending)
        #expect(try await pending(fake, "a1") != nil)
        try await Task.sleep(for: .milliseconds(400))
        #expect(try await status(fake, id)?.state == .done)
        #expect(try await pending(fake, "a1") == nil)
    }

    @Test func aRefusedAnswerLeavesTheCard() async throws {
        let fake = FakeBackend(turnDelay: .seconds(60))
        fake.answerDelay = .milliseconds(100)
        fake.answersFail = true
        let id = try await fake.respond(threadId: "a1", approvalId: "ap1", decision: .allow)
        try await Task.sleep(for: .milliseconds(400))
        #expect(try await status(fake, id)?.state == .failed)
        #expect(try await pending(fake, "a1") != nil)
    }

    @Test func withNoDelayItsAtOnceAsBefore() async throws {
        let fake = FakeBackend(turnDelay: .seconds(60))
        let id = try await fake.respond(threadId: "a1", approvalId: "ap1", decision: .deny)
        #expect(try await status(fake, id)?.state == .done)
        #expect(try await pending(fake, "a1") == nil)
    }
}
