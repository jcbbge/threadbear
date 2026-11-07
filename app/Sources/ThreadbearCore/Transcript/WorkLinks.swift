import Foundation

/// Links from a turn's summary (or any message) back into the thread
/// (docs/protocol.md, "Links into the thread"): `work:<words>` is a step in
/// the turn's own working, `thread:<id>` another thread. The agent can't
/// see its tool calls' ids, so a work link quotes the step: the command it
/// ran or its description, the file it edited, or a line it wrote.
/// `review:<id>` opens one of the thread's design reviews (show_options).
public enum WorkLinks {
    public static let workScheme = "work"
    public static let threadScheme = "thread"
    public static let reviewScheme = "review"

    /// The markdown with the spaces (and anything else a URL can't hold)
    /// in work: and thread: destinations escaped, as agents write
    /// `[tests pass](work:npm test)` and a destination with a space isn't a
    /// link to the markdown parser.
    public static func escapeDestinations(_ markdown: String) -> String {
        guard markdown.contains("](work:") || markdown.contains("](thread:") else { return markdown }
        let ns = markdown as NSString
        var out = ""
        var last = 0
        for match in destination.matches(in: markdown, range: NSRange(location: 0, length: ns.length)) {
            // No `)` to end it: not a link, and the rest of its line is used up.
            guard match.range(at: 3).location != NSNotFound else { continue }
            let body = match.range(at: 2)
            out += ns.substring(with: NSRange(location: last, length: body.location - last))
            let raw = ns.substring(with: body)
            out += (raw.removingPercentEncoding ?? raw).addingPercentEncoding(withAllowedCharacters: allowed) ?? raw
            last = body.location + body.length
        }
        return out + ns.substring(from: last)
    }

    // The `)` is optional so that a link with none uses up the rest of its
    // line: each `](work:` after it would fail the same way, and trying
    // them all was quadratic, 2 s on a 32,000-character reply (Daybreak's
    // findings of 7 Nov 2026 led to the sweep that found it).
    nonisolated(unsafe) private static let destination = try! NSRegularExpression(pattern: #"\]\((work|thread):([^)\n]*)(\))?"#)
    private static let allowed: CharacterSet = {
        var set = CharacterSet.urlPathAllowed
        set.remove(charactersIn: "%")
        return set
    }()

    /// The words a work: link quotes.
    public static func quote(of url: URL) -> String? {
        guard url.scheme?.lowercased() == workScheme else { return nil }
        let raw = url.absoluteString.dropFirst(workScheme.count + 1)
        let words = (String(raw).removingPercentEncoding ?? String(raw)).trimmingCharacters(in: .whitespaces)
        return words.isEmpty ? nil : words
    }

    /// The thread a thread: link names (an id or an id prefix).
    public static func threadId(of url: URL) -> String? {
        guard url.scheme?.lowercased() == threadScheme else { return nil }
        let id = url.absoluteString.dropFirst(threadScheme.count + 1).trimmingCharacters(in: .whitespaces)
        return id.isEmpty ? nil : id
    }

    /// The review a review: link names (an id or an id prefix).
    public static func reviewId(of url: URL) -> String? {
        guard url.scheme?.lowercased() == reviewScheme else { return nil }
        let id = url.absoluteString.dropFirst(reviewScheme.count + 1).trimmingCharacters(in: .whitespaces)
        return id.isEmpty ? nil : id
    }

    /// The thread's review with that id, or the only one it's a prefix of.
    public static func review(_ id: String, in rows: some Sequence<TranscriptRow>) -> DesignReview? {
        let id = id.lowercased()
        let reviews = rows.compactMap { row -> DesignReview? in
            if case .review(let review) = row.content { return review }
            return nil
        }
        if let exact = reviews.last(where: { $0.id.lowercased() == id }) { return exact }
        let matches = reviews.filter { $0.id.lowercased().hasPrefix(id) }
        return Set(matches.map(\.id)).count == 1 ? matches.last : nil
    }

    /// The item a quote means among a turn's items: the last whose command
    /// (or one of its `&&` parts) starts with the words, else the last whose
    /// command, description, path, pattern, title or text mentions them, else
    /// the last whose output does, else the last thought that does. Models
    /// quoted all three in the tests that settled this (docs/end-turn-design),
    /// and the latest is the one a summary is about ("tests pass" means the
    /// run after the fix).
    public static func step(for quote: String, in items: some Sequence<TranscriptRow>) -> TranscriptRow? {
        let q = normal(quote)
        guard !q.isEmpty else { return nil }
        var best: (score: Int, row: TranscriptRow)?
        for row in items {
            let s = score(row, q)
            if s > 0, s >= (best?.score ?? 0) { best = (s, row) }
        }
        return best?.row
    }

    static func score(_ row: TranscriptRow, _ q: String) -> Int {
        switch row.content {
        case .tool(let tool):
            let input = tool.call?.input
            let command: String? = input?["command"].flatMap { value in
                value.stringValue ?? value.arrayValue?.compactMap(\.stringValue).joined(separator: " ")
            }
            if let command {
                // Not inside quotes: `git commit -m "...; npm test passes"`
                // isn't a test run.
                let bare = command.replacingOccurrences(of: #"'[^']*'|"[^"]*""#, with: "", options: .regularExpression)
                let parts = normal(bare).components(separatedBy: CharacterSet(charactersIn: "&;|"))
                if parts.contains(where: { trimCd($0).hasPrefix(q) }) { return 4 }
            }
            // The input's title is the step's own name where a tool takes
            // one: Codex's computer-use calls are all "cua_repl: js" as
            // rows, and "Reconnect to Chrome desktop" only there.
            let named = [command, input?["description"]?.stringValue, input?["file_path"]?.stringValue, input?["path"]?.stringValue,
                         input?["pattern"]?.stringValue, input?["url"]?.stringValue, input?["query"]?.stringValue,
                         input?["title"]?.stringValue, tool.call?.title]
            if named.contains(where: { $0.map { normal($0).contains(q) } ?? false }) { return 3 }
            if let output = tool.result?.text, normal(output).contains(q) { return 2 }
            return 0
        case .assistant(let text) where !text.isSummary:
            return mentions(text.text, q) ? 3 : 0
        case .reasoning(let text):
            // Last of all: an agent drafts its summary in its thinking just
            // before end_turn, quoting the words its links quote, and as the
            // latest mention the thought took the links from their steps.
            return mentions(text.text, q) ? 1 : 0
        case .note(let text):
            return normal(text).contains(q) ? 3 : 0
        default:
            return 0
        }
    }

    /// Whether the agent's own text mentions the words outside its work:
    /// links: a line that links to a step isn't the step.
    private static func mentions(_ text: String, _ q: String) -> Bool {
        // As `destination`: one with no `)` uses up its line and stays.
        normal(text.replacing(/\]\(work:[^)\n]*(\))?/) { $0.1 == nil ? String($0.0) : "]" }).contains(q)
    }

    /// "cd app && npm test" starts with "npm test" too.
    private static func trimCd(_ part: String) -> String {
        let t = part.trimmingCharacters(in: .whitespaces)
        guard t.hasPrefix("cd "), let space = t.dropFirst(3).firstIndex(of: " ") else { return t }
        return String(t[space...]).trimmingCharacters(in: .whitespaces)
    }

    /// Lowercased, quotes and backticks gone, runs of space as one.
    static func normal(_ s: String) -> String {
        s.lowercased()
            .replacingOccurrences(of: "[`\"'*]", with: "", options: .regularExpression)
            .replacingOccurrences(of: "\\s+", with: " ", options: .regularExpression)
            .trimmingCharacters(in: .whitespaces)
    }
}
