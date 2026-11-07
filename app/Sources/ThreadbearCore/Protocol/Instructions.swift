import Foundation

/// His standing instructions for every session (docs/protocol.md, "Standing
/// instructions").
public struct StandingInstructions: Sendable, Decodable, Equatable {
    public var text: String
    /// The file isn't what Settings last saved, so no agent is given it.
    public var outside: Bool?

    public init(text: String, outside: Bool? = nil) {
        self.text = text
        self.outside = outside
    }
}

public struct StandingInstructionsResult: Sendable, Decodable {
    public var instructions: StandingInstructions
}

public extension RPCClient {
    func standingInstructionsGet() async throws -> StandingInstructions {
        try await call("instructions.get", .object([:]), as: StandingInstructionsResult.self).instructions
    }

    func standingInstructionsSet(_ text: String) async throws -> StandingInstructions {
        try await call("instructions.set", .object(["text": .string(text)]), as: StandingInstructionsResult.self).instructions
    }
}
