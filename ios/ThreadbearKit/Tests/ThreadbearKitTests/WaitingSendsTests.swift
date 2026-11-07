import Foundation
import Testing
@testable import ThreadbearKit

/// Messages sent from the phone while the thread's runner is offline: each
/// shows dimmed with its own Cancel until the runner takes it (Mike, 6 Nov,
/// after "Sending…" sat there with the M5 asleep).
@Suite struct WaitingSendsTests {
    let t0 = Date(timeIntervalSince1970: 1_800_000_000)
    var ms: Double { t0.timeIntervalSince1970 * 1000 }

    @Test func pendingOnesAlwaysShow() {
        let waiting = [WaitingSend(commandId: "b", state: .pending, text: "land it", createdAt: ms + 1000),
                       WaitingSend(commandId: "a", state: .pending, text: "land it", createdAt: ms)]
        let messages = [PhoneMessage(seq: 2, role: .user, text: "land it", origin: "phone", at: t0.addingTimeInterval(2))]
        // Oldest first, whatever order they came in.
        #expect(WaitingSends.shown(waiting, messages: messages).map(\.id) == ["a", "b"])
    }

    @Test func aTakenOneGoesOnceItsMessageArrives() {
        let waiting = [WaitingSend(commandId: "a", state: .taken, text: "land it", createdAt: ms),
                       WaitingSend(commandId: "b", state: .taken, text: "land it", createdAt: ms + 1000)]
        #expect(WaitingSends.shown(waiting, messages: []).map(\.id) == ["a", "b"])
        // One copy in the transcript stands for one of them (the older), not both.
        let one = [PhoneMessage(seq: 6, role: .user, text: "land it", origin: "phone", at: t0.addingTimeInterval(2))]
        #expect(WaitingSends.shown(waiting, messages: one).map(\.id) == ["b"])
        // The mirror's line for photos is part of the words it looks for.
        let photo = [WaitingSend(commandId: "c", state: .taken, text: "this one", photos: 1, createdAt: ms)]
        let mirrored = [PhoneMessage(seq: 6, role: .user, text: "this one\n\n[1 picture]", origin: "phone", at: t0)]
        #expect(WaitingSends.shown(photo, messages: mirrored).isEmpty)
        let alone = [WaitingSend(commandId: "d", state: .taken, text: "", photos: 2, createdAt: ms)]
        #expect(WaitingSends.shown(alone, messages: [PhoneMessage(seq: 7, role: .user, text: "[2 pictures]", origin: "phone", at: t0)]).isEmpty)
        // Typed at the Mac: not this one.
        let mac = [PhoneMessage(seq: 6, role: .user, text: "land it", at: t0.addingTimeInterval(2))]
        #expect(WaitingSends.shown(Array(waiting.prefix(1)), messages: mac).map(\.id) == ["a"])
    }

    /// Codex's review: "yes" sent twice a minute apart, the first already in
    /// the transcript, hid the second before it had gone anywhere; "yes"
    /// matched "yesterday"; a photo-only send matched anything.
    @Test func onlyItsOwnCopyHidesIt() {
        let again = [WaitingSend(commandId: "b", state: .taken, text: "yes", createdAt: ms)]
        let earlier = [PhoneMessage(seq: 4, role: .user, text: "yes", origin: "phone", at: t0.addingTimeInterval(-60))]
        #expect(WaitingSends.shown(again, messages: earlier).map(\.id) == ["b"])
        let longer = [PhoneMessage(seq: 5, role: .user, text: "yesterday was fine", origin: "phone", at: t0.addingTimeInterval(2))]
        #expect(WaitingSends.shown(again, messages: longer).map(\.id) == ["b"])
        let photo = [WaitingSend(commandId: "p", state: .taken, text: "", photos: 1, createdAt: ms)]
        #expect(WaitingSends.shown(photo, messages: longer).map(\.id) == ["p"])
    }

    @Test func theLineSaysWhichRunnerIsOffline() {
        let pending = WaitingSend(commandId: "a", state: .pending, text: "x", createdAt: ms)
        #expect(WaitingSends.note(pending, offlineRunner: "M5") == "M5 is offline, sends when it's back")
        #expect(WaitingSends.note(pending, offlineRunner: nil) == "Sending…")
        // Taken: it's going, offline or not.
        var taken = pending
        taken.state = .taken
        #expect(WaitingSends.note(taken, offlineRunner: "M5") == "Sending…")
        #expect(!taken.canCancel && pending.canCancel)
    }

    /// The bug behind it: the old line only looked at whether every runner
    /// was offline, and Bruce and the cloud box are always up.
    @Test func offlineGoesByTheThreadsOwnRunner() {
        let runners = [PhoneRunner(runnerId: "m5", name: "M5", lastSeenAt: t0.addingTimeInterval(-600)),
                       PhoneRunner(runnerId: "bruce", name: "bruce", lastSeenAt: t0)]
        #expect(WaitingSends.offlineRunner("m5", in: runners, at: t0) == "M5")
        #expect(WaitingSends.offlineRunner("bruce", in: runners, at: t0) == nil)
        #expect(WaitingSends.offlineRunner("gone", in: runners, at: t0) == nil)
    }

    @Test func theFakeBackendQueuesWhileItsRunnerIsOffline() async throws {
        let backend = FakeBackend(turnDelay: .milliseconds(10), runnerOnline: false)
        let thread = try #require(try await firstInbox(backend))
        let first = try await backend.send(threadId: thread.threadId, text: "one")
        _ = try await backend.send(threadId: thread.threadId, text: "two")
        var stream = backend.waiting(thread.threadId).makeAsyncIterator()
        #expect(try await stream.next()?.map(\.text) == ["one", "two"])
        #expect(try await backend.cancel(first))
        #expect(try await backend.cancel(first) == false)
        var again = backend.waiting(thread.threadId).makeAsyncIterator()
        #expect(try await again.next()?.map(\.text) == ["two"])
    }

    private func firstInbox(_ backend: FakeBackend) async throws -> PhoneThread? {
        var it = backend.threads(.inbox).makeAsyncIterator()
        return try await it.next()?.first
    }
}
