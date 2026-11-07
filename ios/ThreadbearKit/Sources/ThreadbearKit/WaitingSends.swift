import Foundation

/// phone:waiting (backend API 57): a message sent from the phone that the
/// thread's runner hasn't applied yet. With the Mac asleep they wait in
/// Convex, several of them if Mike keeps going, and each can be cancelled
/// until the runner takes it.
public struct WaitingSend: Codable, Sendable, Hashable, Identifiable {
    public var id: String { commandId }
    public var commandId: String
    /// `pending` (can still be cancelled) or `taken` (on its way).
    public var state: CommandState
    public var text: String
    public var photos: Int
    /// Milliseconds since 1970, as Convex has it.
    public var createdAt: Double

    public init(commandId: String, state: CommandState, text: String, photos: Int = 0, createdAt: Double) {
        self.commandId = commandId
        self.state = state
        self.text = text
        self.photos = photos
        self.createdAt = createdAt
    }

    public var canCancel: Bool { state == .pending }
}

public enum WaitingSends {
    /// The ones to show under the transcript, oldest first. A taken one
    /// stays until its message is in the transcript, then drops out, so it
    /// neither vanishes for a moment in between nor shows twice. Its copy is
    /// a message from the phone with exactly its words (as the mirror writes
    /// them) recorded no earlier than it was sent, so an earlier "yes" never
    /// hides a new one, whatever order things load in. Each message stands
    /// for one send, the oldest first. A copy the mirror changed (cut short,
    /// a secret scrubbed) never matches; the caller drops a finished one
    /// after a while for that.
    public static func shown(_ waiting: [WaitingSend], messages: [PhoneMessage]) -> [WaitingSend] {
        var arrived = messages.filter { $0.role == .user && $0.origin == "phone" }
        return waiting.sorted { $0.createdAt < $1.createdAt }.filter { send in
            guard send.state == .taken else { return true }
            // A few seconds' slack for the runner's clock against Convex's.
            let sentAt = Date(timeIntervalSince1970: send.createdAt / 1000).addingTimeInterval(-5)
            let words = mirrored(send)
            guard let i = arrived.firstIndex(where: { $0.at >= sentAt && $0.text == words }) else { return true }
            arrived.remove(at: i)
            return false
        }
    }

    /// The send's words as the transcript will have them: photos its
    /// [Picture N] markers don't place become a line (sync.ts toMessageDoc).
    public static func mirrored(_ send: WaitingSend) -> String {
        let count = InlinePictures.unplaced(send.text, count: send.photos)
        guard count > 0 else { return send.text }
        let note = count == 1 ? "[1 picture]" : "[\(count) pictures]"
        return send.text.isEmpty ? note : "\(send.text)\n\n\(note)"
    }

    /// The grey line under a waiting message.
    public static func note(_ send: WaitingSend, offlineRunner: String?) -> String {
        if send.state == .pending, let offlineRunner { return "\(offlineRunner) is offline, sends when it's back" }
        return "Sending…"
    }

    /// The thread's runner by name while it's offline, nil while it's up (or
    /// unknown, which says nothing either way).
    public static func offlineRunner(_ runnerId: String, in runners: [PhoneRunner], at now: Date) -> String? {
        guard let runner = runners.first(where: { $0.runnerId == runnerId }), !runner.isOnline(at: now) else { return nil }
        return runner.name
    }
}
