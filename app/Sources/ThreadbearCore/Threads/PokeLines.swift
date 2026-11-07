import Foundation

/// The lines a bear picture says when poked (`HomePage`). Each poke gets the
/// next one, so it's a different line each time, and a fifth in a row gets
/// the bear giving up. A run ends when the line has faded.
public struct PokeLines: Sendable, Equatable {
    public static let librarian = [
        "Shh.",
        "Filed under B, for bear.",
        "Haiku, mostly. It's cheaper.",
        "I've read all your threads. No comment.",
    ]
    public static let scheduled = [
        "Not yet.",
        "Five more minutes.",
        "I'll remind you. It's the one thing I'm good at.",
    ]
    static let fifth = "Alright, alright."

    private let lines: [String]
    private var next = 0
    private var inARow = 0

    public init(_ lines: [String]) { self.lines = lines }

    public mutating func poke() -> String? {
        guard !lines.isEmpty else { return nil }
        inARow += 1
        if inARow == 5 { return Self.fifth }
        defer { next = (next + 1) % lines.count }
        return lines[next]
    }

    public mutating func endRun() { inARow = 0 }
}
