import Foundation

/// A reply button as a message row carries it (backend API 59, docs/protocol.md
/// "Reply buttons"): what it says and where it goes, never the brief or
/// message behind it, which stay on the Mac.
public struct MessageButton: Codable, Sendable, Hashable, Identifiable {
    public enum Kind: String, Codable, Sendable { case start, send }
    public var id: String
    public var title: String
    public var kind: Kind
    /// The new thread's folder name, or the title of the thread it messages.
    public var target: String?
    /// The thread it started or messaged, once pressed (anywhere).
    public var pressedThreadId: String?
    /// The last press's error, when it failed. It can be pressed again.
    public var failed: String?

    public init(id: String, title: String, kind: Kind, target: String? = nil, pressedThreadId: String? = nil, failed: String? = nil) {
        self.id = id
        self.title = title
        self.kind = kind
        self.target = target
        self.pressedThreadId = pressedThreadId
        self.failed = failed
    }
}

/// An agent's `[title](button:<id>)` links drawn as buttons: blue starts a
/// thread, purple sends a message, green with a tick once pressed. The web
/// page's reply-buttons.ts says the same; keep the two alike.
public enum ReplyButtons {
    public struct Link: Equatable, Sendable {
        public var id: String
        public var title: String
    }

    /// A line's button links at its end, peeled off so they can be drawn as
    /// real buttons after its words ("- Pebble form due. [Fill it in](button:x)").
    /// A link with words after it stays in the text, where it's drawn as a link.
    public static func trailing(in text: String) -> (text: String, links: [Link]) {
        var rest = Substring(text)
        var links: [Link] = []
        while let match = rest.wholeMatch(of: /(?s)(.*?)[\s,;·|]*\[([^\]\n]+)\]\(button:([a-z0-9]{8})\)[\s.,;·|]*/) {
            links.insert(Link(id: String(match.output.3), title: String(match.output.2)), at: 0)
            rest = match.output.1
        }
        return (String(rest).trimmingCharacters(in: .whitespaces), links)
    }

    /// The text with every button link whose id isn't in `known` as just its
    /// title: an older runner's row, or a button the thread no longer keeps.
    public static func unlinking(_ text: String, except known: Set<String>) -> String {
        guard text.contains("](button:") else { return text }
        return text.replacing(/\[([^\]\n]+)\]\(button:([^)\s]*)\)/) { match in
            known.contains(String(match.output.2)) ? String(match.output.0) : String(match.output.1)
        }
    }

    public enum Look: Equatable, Sendable {
        case ready
        case pressing
        case pressed(threadId: String?)
        case failed(String)
    }

    /// What a button shows: the row's state, with this phone's own press on
    /// top until the row catches up. `asking`: a press is on its way to the
    /// backend, or its command hasn't finished.
    public static func look(_ button: MessageButton, status: CommandStatus?, asking: Bool) -> Look {
        if let id = button.pressedThreadId { return .pressed(threadId: id) }
        if status?.state == .done { return .pressed(threadId: status?.threadId) }
        if asking || status?.state == .pending || status?.state == .taken { return .pressing }
        if status?.state == .failed { return .failed(status?.note ?? "The runner couldn't press it.") }
        if let failed = button.failed { return .failed(failed) }
        return .ready
    }

    /// What VoiceOver says, and where it goes.
    public static func hint(_ button: MessageButton) -> String {
        switch button.kind {
        case .start: button.target.map { "Starts a thread in \($0)" } ?? "Starts a thread"
        case .send: button.target.map { "Sends a message to \($0)" } ?? "Sends a message"
        }
    }
}
