import Foundation
import Testing
@testable import ThreadbearKit

/// A call on a Convex client that's since been replaced may never answer, so
/// waiting for it with a spinner needs an end.
@Suite struct DeadlineTests {
    @Test func anAnswerInTimeComesBack() async throws {
        let value = try await Deadline.run(seconds: 2) { 42 }
        #expect(value == 42)
    }

    @Test func aCallThatNeverAnswersStopsBeingWaitedFor() async {
        let started = Date.now
        await #expect(throws: Deadline.TimedOut.self) {
            try await Deadline.run(seconds: 0.2) {
                try await Task.sleep(for: .seconds(30))
                return 1
            }
        }
        #expect(Date.now.timeIntervalSince(started) < 5)
    }

    @Test func itsOwnErrorComesThrough() async {
        await #expect(throws: TransportError.self) {
            try await Deadline.run(seconds: 2) { () async throws -> Int in throw TransportError.server("no") }
        }
    }
}
