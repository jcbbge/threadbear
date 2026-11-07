import Foundation

/// Links from a message back into the thread (docs/protocol.md, "Links into
/// the thread"), as the Mac's WorkLinks reads them: `work:<words>` quotes a
/// step in the turn's working, `thread:<id>` is another thread and
/// `review:<id>` a design review, which only the Mac can open.
/// `button:<id>` is a reply button (ReplyButtons.swift).
public enum ThreadLinks {
    public enum Target: Equatable, Sendable {
        case step(quote: String)
        case thread(String)
        case review
        case button(String)
    }

    /// What a work: link opens: its turn's working, and the step if it was
    /// found. Often it isn't where the Mac would find it, as a command with a
    /// description comes to the phone as only the description, so the working
    /// opens anyway.
    public struct Hit: Equatable, Sendable, Hashable {
        public var turn: WorkedTurn
        public var step: Int?
    }

    /// The markdown with work: and thread: destinations escaped, as agents
    /// write `[tests pass](work:npm test)` and a destination with a space isn't
    /// a link to the parser: the phone showed the whole thing as raw text
    /// (Mike, 1 Nov). Code spans stay as written, as they're being talked about.
    public static func escapeDestinations(_ markdown: String) -> String {
        guard markdown.contains("](work:") || markdown.contains("](thread:") else { return markdown }
        var codeSpans = CodeSpans(markdown.ranges(of: /`+[^`\n]*`+/))
        var out = ""
        var from = markdown.startIndex
        // One level of brackets inside, for `work:npm test (unit)`.
        for match in markdown.matches(of: /\]\((work|thread):((?:[^()\n]|\([^()\n]*\))*)\)/) {
            if codeSpans.overlap(match.range) { continue }
            out += markdown[from..<match.output.2.startIndex]
            let raw = String(match.output.2)
            out += (raw.removingPercentEncoding ?? raw).addingPercentEncoding(withAllowedCharacters: allowed) ?? raw
            from = match.output.2.endIndex
        }
        return out + markdown[from...]
    }

    private static let allowed: CharacterSet = {
        var set = CharacterSet.urlPathAllowed
        set.remove(charactersIn: "%()")
        return set
    }()

    /// What a link means, or nil for anywhere else (a web page), which the
    /// system opens.
    public static func target(of url: URL) -> Target? {
        guard let scheme = url.scheme?.lowercased() else { return nil }
        let raw = String(url.absoluteString.dropFirst(scheme.count + 1))
        let words = (raw.removingPercentEncoding ?? raw).trimmingCharacters(in: .whitespaces)
        switch scheme {
        case "work": return words.isEmpty ? nil : .step(quote: words)
        case "thread": return words.isEmpty ? nil : .thread(words)
        case "review": return .review
        case "button": return words.isEmpty ? nil : .button(words)
        default: return nil
        }
    }

    /// Where a work: link in message `seq` (nil: the latest turn, for the card
    /// of asks) goes: the latest step of that message's turn with the words in
    /// it, as the Mac picks it. Nil when the turn has no working to show.
    public static func find(quote: String, from seq: Int?, in items: [ThreadItem]) -> Hit? {
        let q = normal(quote)
        guard !q.isEmpty, !items.isEmpty else { return nil }
        let last = seq.flatMap { seq in items.lastIndex { $0.holds(seq) } } ?? items.count - 1
        var first = last
        while first > 0, !items[first - 1].isFromMike { first -= 1 }
        let turn = items[first...last].filter { item in
            if case let .message(message) = item { return message.seq != seq && message.role != .user }
            return true
        }
        guard !turn.isEmpty else { return nil }
        let folds = turn.compactMap { item -> WorkedTurn? in
            if case let .worked(worked) = item { return worked }
            return nil
        }
        // A turn still going isn't folded, so its lines are the working.
        guard let latest = folds.last else {
            let working = WorkedTurn(items: Array(turn), duration: nil)
            return Hit(turn: working, step: step(in: .worked(working), q))
        }
        for fold in folds.reversed() {
            if let step = step(in: .worked(fold), q) { return Hit(turn: fold, step: step) }
        }
        return Hit(turn: latest, step: nil)
    }

    private static func step(in item: ThreadItem, _ q: String) -> Int? {
        switch item {
        case let .message(message): matches(message, q) ? message.seq : nil
        case let .tools(run): run.last { matches($0, q) }?.seq
        case let .worked(worked): worked.items.reversed().lazy.compactMap { step(in: $0, q) }.first
        case .gap: nil
        }
    }

    private static func matches(_ message: PhoneMessage, _ q: String) -> Bool {
        switch message.role {
        case .tool: normal(message.text).contains(q)
        // A line that links to a step isn't the step, nor is the summary.
        // One with no `)` uses up its line and stays: trying every `](work:`
        // after it again was quadratic.
        case .assistant: !message.summary && normal(message.text.replacing(/\]\(work:[^)\n]*(\))?/) { $0.1 == nil ? String($0.0) : "]" }).contains(q)
        case .user: false
        }
    }

    /// Lowercase, one space, and home as the runner's step lines write it, so
    /// `/Users/mike/a.md` finds "Edited ~/a.md".
    private static func normal(_ text: String) -> String {
        text.replacing(/\/Users\/[^\/\s]+/, with: "~")
            .lowercased()
            .split(whereSeparator: \.isWhitespace)
            .joined(separator: " ")
    }
}

private extension ThreadItem {
    var isFromMike: Bool {
        if case let .message(message) = self { return message.role == .user }
        return false
    }

    func holds(_ seq: Int) -> Bool {
        switch self {
        case let .message(message): message.seq == seq
        case let .tools(run): run.contains { $0.seq == seq }
        case let .worked(worked): worked.items.contains { $0.holds(seq) }
        case .gap: false
        }
    }
}
