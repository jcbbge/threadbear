import Foundation

/// Turns the speech recogniser's stream of results into things Mike said.
/// The recogniser sends volatile guesses that it later replaces with final
/// text, each for a stretch of the audio (seconds from the start). Once
/// he's paused for `pause` seconds whatever he's said since the last send
/// goes, and anything the recogniser finalises later for audio that was
/// already sent is dropped, so nothing goes twice.
public struct UtteranceTracker: Sendable {
    public struct Result: Sendable, Equatable {
        public var text: String
        /// The stretch of audio it covers, in seconds.
        public var start: Double
        public var end: Double
        public var isFinal: Bool

        public init(text: String, start: Double, end: Double, isFinal: Bool) {
            self.text = text
            self.start = start
            self.end = end
            self.isFinal = isFinal
        }
    }

    /// How long a pause ends what he's saying.
    public var pause: Double
    /// Final text not yet sent, oldest first.
    private var finals: [Result] = []
    /// The newest guess at what comes after them.
    private var volatile: Result?
    /// Audio up to here has been sent.
    private(set) public var sentThrough: Double = -1
    /// When (clock time) the last result with words came in.
    private var lastHeard: Double?

    public init(pause: Double = 1.0) {
        self.pause = pause
    }

    /// What he's said so far that hasn't gone, for the live caption.
    public var pending: String {
        Self.join((finals + [volatile].compactMap { $0 }).map(\.text))
    }

    /// Where in the audio what's waiting starts (seconds), to tell when he
    /// said it: results can reach us well after the words.
    public var pendingStart: Double? {
        (finals + [volatile].compactMap { $0 }).map(\.start).min()
    }

    /// Whether anything is waiting to go.
    public var hasWords: Bool { !pending.isEmpty }

    /// Takes a result from the recogniser. True when it had new words in
    /// it (so whatever is speaking should stop: he's talking).
    @discardableResult
    public mutating func add(_ result: Result, now: Double) -> Bool {
        // Audio already sent: the recogniser finalising what went.
        guard result.end > sentThrough + 0.001 else { return false }
        let words = !result.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        if result.isFinal {
            if words { finals.append(result) }
            if let v = volatile, v.end <= result.end + 0.001 { volatile = nil }
        } else {
            volatile = words ? result : nil
        }
        if words { lastHeard = now }
        return words
    }

    /// What to send now, if he's paused long enough after saying something.
    public mutating func take(now: Double) -> String? {
        guard let lastHeard, now - lastHeard >= pause, hasWords else { return nil }
        return flush()
    }

    /// Sends whatever there is now (voice mode turned off mid-sentence).
    public mutating func flush() -> String? {
        let text = pending
        let end = (finals.map(\.end) + [volatile?.end].compactMap { $0 }).max() ?? sentThrough
        finals = []
        volatile = nil
        lastHeard = nil
        sentThrough = max(sentThrough, end)
        return text.isEmpty ? nil : text
    }

    static func join(_ parts: [String]) -> String {
        parts.map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { !$0.isEmpty }
            .joined(separator: " ")
    }
}
