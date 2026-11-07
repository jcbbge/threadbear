import Foundation

/// Where a tapped push's thread goes: the notification delegate hands it
/// here and this opens it, holding it if the tap launched the app before
/// its model was there to open it.
@MainActor
public final class PushTaps {
    public init() {}

    /// Opens a thread. Set once the app's model exists; a tap that came
    /// first is opened then.
    public var open: ((String) -> Void)? {
        didSet { handOver() }
    }

    private var waiting: String?

    /// From the notification delegate, on whatever thread it was called.
    /// `done` is UIKit's completion handler, so it's called on the main
    /// thread, once: a nonisolated async delegate method had Swift call it
    /// from a background thread, and UIKit's assertion crashed the app on
    /// a tapped push (THREADBEAR-12).
    nonisolated public func tapped(threadId: String?, done: @escaping @Sendable () -> Void) {
        Task { @MainActor in
            if let threadId {
                waiting = threadId
                handOver()
            }
            done()
        }
    }

    private func handOver() {
        guard let threadId = waiting, let open else { return }
        waiting = nil
        open(threadId)
    }
}
