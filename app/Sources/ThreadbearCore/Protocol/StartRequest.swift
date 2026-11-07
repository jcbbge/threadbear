import Foundation

/// Another runner asking for a new thread (docs/protocol.md, "Asking
/// another runner"). Its card is an `approval.requested` named
/// `cardName`; what it asks for is read from this Mac's own runner
/// (`requests.get`), as it was filed in the backend, never from the card.
public struct StartRequest: Sendable, Hashable, Decodable {
    public static let cardName = "threadbear.start_thread"

    public struct Filed: Sendable, Hashable, Decodable {
        public var runnerName: String
        public var threadId: String
        public var target: String
        public var text: String
        public var title: String?
        public var cwd: String?
        public var model: String?
        public var effort: String?
        public var permissionMode: String?
        public var why: String?
    }

    public struct Runner: Sendable, Hashable, Decodable {
        public var id: String
        public var name: String
        /// This Mac's own runner (`self` in the JSON).
        public var isSelf: Bool

        enum CodingKeys: String, CodingKey {
            case id, name
            case isSelf = "self"
        }
    }

    public var request: Filed
    /// The machine it named, if this runner knows one by that name.
    public var target: Runner?
    public var runners: [Runner]
    /// The runner's hash of the request as read, sent back with Start it.
    public var fingerprint: String?
    /// Set by the app when it couldn't read the request.
    public var error: String?

    public init(request: Filed, target: Runner?, runners: [Runner], fingerprint: String? = nil, error: String? = nil) {
        self.request = request
        self.target = target
        self.runners = runners
        self.fingerprint = fingerprint
        self.error = error
    }

    /// Where Start it starts it: the machine it named, or this Mac when it
    /// named one this Mac doesn't know.
    public var startsOn: Runner? { target ?? runners.first(where: \.isSelf) }

    /// A card for a request that couldn't be read: no buttons, the reason.
    public static func failed(_ message: String) -> StartRequest {
        StartRequest(request: Filed(runnerName: "", threadId: "", target: "", text: ""), target: nil, runners: [], error: message)
    }
}
