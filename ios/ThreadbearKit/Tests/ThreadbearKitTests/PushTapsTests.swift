import Foundation
import Testing
@testable import ThreadbearKit

/// A tapped push: UIKit's completion handler has to run on the main
/// thread (THREADBEAR-12), exactly once, and a tap that launched the app
/// before its model was there still opens the thread.
@MainActor
struct PushTapsTests {
    /// Calls `tapped` from a background queue, as nothing guarantees which
    /// thread the delegate is entered on, and waits for `done`.
    private func tap(_ taps: PushTaps, threadId: String?) async -> (calls: Int, onMain: Bool) {
        final class Seen: @unchecked Sendable {
            let lock = NSLock()
            var calls = 0
            var onMain = true
        }
        let seen = Seen()
        await withCheckedContinuation { (finished: CheckedContinuation<Void, Never>) in
            DispatchQueue.global().async {
                taps.tapped(threadId: threadId) {
                    seen.lock.withLock {
                        seen.calls += 1
                        seen.onMain = seen.onMain && Thread.isMainThread
                    }
                    finished.resume()
                }
            }
        }
        // Long enough for a second call to show up if there were one.
        try? await Task.sleep(for: .milliseconds(50))
        return seen.lock.withLock { (seen.calls, seen.onMain) }
    }

    @Test func doneRunsOnceOnMainAndOpensTheThread() async {
        let taps = PushTaps()
        var opened: [String] = []
        taps.open = { opened.append($0) }
        let result = await tap(taps, threadId: "t1")
        #expect(result.calls == 1)
        #expect(result.onMain)
        #expect(opened == ["t1"])
    }

    @Test func aPushWithNoThreadStillCallsBack() async {
        let taps = PushTaps()
        var opened: [String] = []
        taps.open = { opened.append($0) }
        let result = await tap(taps, threadId: nil)
        #expect(result.calls == 1)
        #expect(result.onMain)
        #expect(opened.isEmpty)
    }

    @Test func aTapBeforeTheModelIsThereOpensOnceItIs() async {
        let taps = PushTaps()
        let result = await tap(taps, threadId: "t2")
        #expect(result.calls == 1)
        var opened: [String] = []
        taps.open = { opened.append($0) }
        #expect(opened == ["t2"])
        // Handed over once, not again when the model is set a second time.
        taps.open = { opened.append($0) }
        #expect(opened == ["t2"])
    }
}
