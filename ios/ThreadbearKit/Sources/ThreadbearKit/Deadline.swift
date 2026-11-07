import Foundation
import os

/// Waits for a call at most this long. The call itself carries on, as a Convex
/// mutation can't be taken back, but whoever was waiting isn't stuck: a client
/// replaced while it was waiting (coming back from the background, a pull to
/// refresh) may never answer.
public enum Deadline {
    public struct TimedOut: LocalizedError {
        public var errorDescription: String? { "The phone couldn't reach Convex. Try again." }
    }

    public static func run<T: Sendable>(seconds: Double, _ call: @escaping @Sendable () async throws -> T) async throws -> T {
        let once = OSAllocatedUnfairLock(initialState: false)
        return try await withCheckedThrowingContinuation { (done: CheckedContinuation<T, Error>) in
            func finish(_ result: Result<T, Error>) {
                guard once.withLock({ was in defer { was = true }; return !was }) else { return }
                done.resume(with: result)
            }
            let work = Task { finish(await Result { try await call() }) }
            Task {
                try? await Task.sleep(for: .seconds(seconds))
                finish(.failure(TimedOut()))
                _ = work
            }
        }
    }
}

private extension Result where Failure == Error {
    init(catching body: () async throws -> Success) async {
        do { self = .success(try await body()) } catch { self = .failure(error) }
    }
}
