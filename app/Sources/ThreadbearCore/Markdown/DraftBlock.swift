import Foundation

/// A ```slack, ```email or ```draft block in a reply: text the agent has
/// written for Mike to send somewhere else. It's shown the way it'll go
/// out, every line where the agent put it (a reply's own Markdown joins
/// lines up, which ran a Slack draft's "•" lines into one paragraph, 6 Nov),
/// in a box with a Copy button. A ```slack one also draws Slack's own
/// formatting: *bold*, _italic_, ~strike~, `code` and <url|label> links.
///
/// The phone (ios/ThreadbearKit, DraftBlock.swift) and the website
/// (web/src/draft.ts) parse it the same way; keep the three together.
public struct DraftBlock: Hashable, Sendable {
    public enum Kind: String, Sendable { case slack, email, draft }

    public let kind: Kind
    public let source: String

    public init(kind: Kind, source: String) {
        self.kind = kind
        self.source = source
    }

    /// Past this a fence stays plain code: a draft that size isn't a
    /// message, and the box shouldn't be what makes a reply slow.
    public static let maxSource = 20_000

    /// The draft for a fence's info string (only the first word counts),
    /// or nil for any other fence.
    public static func from(language: String?, code: String) -> DraftBlock? {
        guard let word = language?.split(whereSeparator: { $0 == " " || $0 == "\t" || $0 == "{" }).first?.lowercased(),
              let kind = Kind(rawValue: word) else { return nil }
        var source = code.replacingOccurrences(of: "\r\n", with: "\n")
        while source.hasSuffix("\n") { source.removeLast() }
        guard !source.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty, source.count <= maxSource else { return nil }
        return DraftBlock(kind: kind, source: source)
    }

    /// Whether a block of a reply's text could hold one, so only those
    /// are checked for a closed fence.
    public static func mayHold(_ text: String) -> Bool {
        guard text.contains("```") || text.contains("~~~") else { return false }
        let lowered = text.lowercased()
        return lowered.contains("slack") || lowered.contains("email") || lowered.contains("draft")
    }

    /// What the box's header calls it.
    public var label: String {
        switch kind {
        case .slack: return "Slack draft"
        case .email: return "Email draft"
        case .draft: return "Draft"
        }
    }

    /// A run of a line with one look.
    public struct Span: Hashable, Sendable {
        public var text: String
        public var bold = false
        public var italic = false
        public var strike = false
        public var code = false
        /// http(s) or mailto only.
        public var link: URL?

        public init(_ text: String, bold: Bool = false, italic: Bool = false, strike: Bool = false, code: Bool = false, link: URL? = nil) {
            self.text = text
            self.bold = bold
            self.italic = italic
            self.strike = strike
            self.code = code
            self.link = link
        }
    }

    public struct Line: Hashable, Sendable {
        public var spans: [Span]
        /// A Slack "> " line, drawn with a bar.
        public var quote = false
    }

    /// The draft's lines as they're shown. An email or plain draft is its
    /// text as it is (bare addresses are linked when it's drawn); a Slack
    /// one has its formatting and <...> tokens worked out.
    public var lines: [Line] {
        source.split(separator: "\n", omittingEmptySubsequences: false).map { raw in
            let line = String(raw)
            guard kind == .slack else { return Line(spans: [Span(line)]) }
            if line.hasPrefix("> ") || line == ">" || line.hasPrefix("&gt; ") {
                let rest = line.hasPrefix("&gt; ") ? String(line.dropFirst(5)) : String(line.dropFirst(min(2, line.count)))
                return Line(spans: Self.slackSpans(rest), quote: true)
            }
            return Line(spans: Self.slackSpans(line))
        }
    }

    /// What Copy puts on the clipboard as plain text. A Slack draft keeps
    /// its *bold* and _italic_ (Slack's message box formats those as it
    /// sends) but its <url|label> links become "label (url)", which pasted
    /// as plain text would otherwise stay as typed.
    public var plainText: String {
        guard kind == .slack else { return source }
        return source.split(separator: "\n", omittingEmptySubsequences: false).map { line in
            let (marked, tokens) = Self.marked(String(line))
            guard let tokens else { return Self.decode(String(line)) }
            // A token in `code` is copied as typed, as it's shown.
            let code = Self.codeSpans(Array(marked))
            var out = ""
            for (offset, c) in marked.enumerated() {
                // By scalar: a combining mark after a token joins its Character.
                for scalar in c.unicodeScalars {
                    guard let index = Self.placeholderIndex(scalar), index < tokens.count else {
                        out.unicodeScalars.append(scalar)
                        continue
                    }
                    if code.contains(where: { $0.contains(offset) }) {
                        out += tokens[index].raw
                        continue
                    }
                    switch tokens[index].token {
                    case let .link(url, label): out += label == url.absoluteString || label.isEmpty ? url.absoluteString : "\(label) (\(url.absoluteString))"
                    case let .mention(text): out += text
                    }
                }
            }
            return Self.decode(out)
        }.joined(separator: "\n")
    }

    /// The same as HTML, put on the clipboard beside the plain text, so
    /// pasting into Slack or Mail keeps the bold and the links.
    public var html: String {
        let body = lines.map { line -> String in
            var afterSpace = true
            let inner = line.spans.map { span -> String in
                defer { afterSpace = span.text.last == " " }
                return Self.html(span, afterSpace: afterSpace)
            }.joined()
            return line.quote ? "<blockquote>\(inner)</blockquote>" : inner
        }
        // Quotes are blocks of their own, so no <br> beside one.
        var out = ""
        for (index, part) in body.enumerated() {
            out += part
            if index < body.count - 1, !part.hasPrefix("<blockquote>"), !body[index + 1].hasPrefix("<blockquote>") { out += "<br>" }
        }
        return "<meta charset=\"utf-8\"><div>\(out)</div>"
    }

    private static func html(_ span: Span, afterSpace: Bool) -> String {
        var text = keepSpaces(escape(span.text), afterSpace: afterSpace)
        if span.code { text = "<code>\(text)</code>" }
        if span.strike { text = "<s>\(text)</s>" }
        if span.italic { text = "<i>\(text)</i>" }
        if span.bold { text = "<b>\(text)</b>" }
        if let link = span.link { text = "<a href=\"\(escape(link.absoluteString))\">\(text)</a>" }
        return text
    }

    /// HTML folds runs of spaces into one, so a line's indent and any
    /// spaces lined up in it would go in a paste: each space at the start
    /// of a line or after another is a no-break space.
    private static func keepSpaces(_ text: String, afterSpace: Bool) -> String {
        var out = ""
        var previousSpace = afterSpace
        for c in text {
            if c == " " {
                out += previousSpace ? "&nbsp;" : " "
                previousSpace = true
            } else if c == "\t" {
                out += "&nbsp;&nbsp;&nbsp;&nbsp;"
                previousSpace = true
            } else {
                out.append(c)
                previousSpace = false
            }
        }
        return out
    }

    private static func escape(_ text: String) -> String {
        text.replacingOccurrences(of: "&", with: "&amp;").replacingOccurrences(of: "<", with: "&lt;")
            .replacingOccurrences(of: ">", with: "&gt;").replacingOccurrences(of: "\"", with: "&quot;")
    }

    // MARK: Slack's formatting

    enum Token: Equatable {
        case link(URL, String)
        /// <@U123>, <#C123|general>, <!here>: shown as their words.
        case mention(String)
    }

    /// A <...> token: a link to a web page or a mail address, or a mention.
    /// Anything else between angle brackets is left as written.
    static func token(_ inside: String) -> Token? {
        let parts = inside.split(separator: "|", maxSplits: 1, omittingEmptySubsequences: false).map(String.init)
        let target = parts[0]
        let label = parts.count > 1 ? parts[1] : nil
        if let first = target.first, first == "@" || first == "#" || first == "!" {
            let name = target.dropFirst()
            guard !name.isEmpty, !name.contains(" ") else { return nil }
            if let label, !label.isEmpty { return .mention(first == "#" && !label.hasPrefix("#") ? "#\(label)" : label) }
            if first == "!" {
                // <!subteam^S123> and <!date^...> carry a label or nothing useful.
                return .mention("@\(name.split(separator: "^").first ?? name)")
            }
            return .mention("\(first)\(name)")
        }
        guard !target.contains(" "), let url = URL(string: target), let scheme = url.scheme?.lowercased(),
              ["http", "https", "mailto"].contains(scheme) else { return nil }
        let shown = label.map(decode) ?? (scheme == "mailto" ? String(target.dropFirst("mailto:".count)) : target)
        return .link(url, shown)
    }

    enum Piece: Equatable {
        case text(String)
        /// The token, and the <...> it was written as.
        case token(Token, String)
    }

    /// Walks a line once, handing over its words and its <...> tokens in
    /// order. A "<" that doesn't start a token is a word like any other.
    /// The next ">" is looked for once and kept until it's passed, so a
    /// line of many "<" (or one with no ">") takes one pass, not one per
    /// "<" (cross-lab review, 6 Nov).
    static func scanTokens(_ line: String, _ visit: (Piece) -> Void) {
        let chars = Array(line)
        var plain = ""
        var close: Int? = -1
        var i = 0
        while i < chars.count {
            if chars[i] == "<" {
                if let known = close, known <= i { close = chars[(i + 1)...].firstIndex(of: ">") }
                // A token never holds a "<", so with another before the ">"
                // this one isn't a token, and what's between isn't read.
                let next = close.flatMap { end in chars[(i + 1)..<end].firstIndex(of: "<") }
                if let end = close, next == nil, let token = token(String(chars[(i + 1)..<end])) {
                    if !plain.isEmpty { visit(.text(plain)); plain = "" }
                    visit(.token(token, String(chars[i...end])))
                    i = end + 1
                    continue
                }
            }
            plain.append(chars[i])
            i += 1
        }
        if !plain.isEmpty { visit(.text(plain)) }
    }

    static func decode(_ text: String) -> String {
        text.replacingOccurrences(of: "&lt;", with: "<").replacingOccurrences(of: "&gt;", with: ">").replacingOccurrences(of: "&amp;", with: "&")
    }

    /// Past this many characters a line is shown as written, so a huge
    /// line can't keep the formatting busy.
    public static let maxFormattedLine = 2_000
    /// Where the placeholders for a line's tokens start (Unicode's private
    /// use area).
    private static let placeholderBase: UInt32 = 0xE000

    /// The line with each <...> token as one placeholder character, and
    /// the tokens; no tokens for a line that's too long, or that has
    /// placeholder characters of its own, which is shown as written.
    static func marked(_ line: String) -> (String, [(token: Token, raw: String)]?) {
        guard line.count <= maxFormattedLine,
              !line.unicodeScalars.contains(where: { (0xE000...0xF8FF).contains($0.value) }) else { return (line, nil) }
        var marked = ""
        var tokens: [(token: Token, raw: String)] = []
        scanTokens(line) { piece in
            switch piece {
            case let .text(text): marked += text
            case let .token(token, raw):
                marked.unicodeScalars.append(Unicode.Scalar(placeholderBase + UInt32(tokens.count))!)
                tokens.append((token, raw))
            }
        }
        return (marked, tokens)
    }

    static func placeholderIndex(_ scalar: Unicode.Scalar) -> Int? {
        let index = Int(scalar.value) - Int(placeholderBase)
        return index >= 0 && index <= 0xF8FF - 0xE000 ? index : nil
    }

    /// Where a line's `code` is, by Character offset, found the way
    /// `emphasis` finds it.
    static func codeSpans(_ chars: [Character]) -> [Range<Int>] {
        var spans: [Range<Int>] = []
        var i = 0
        while i < chars.count {
            if chars[i] == "`", opens(chars, i), let end = closing(chars, from: i, marker: "`") {
                spans.append(i..<(end + 1))
                i = end + 1
            } else {
                i += 1
            }
        }
        return spans
    }

    /// A Slack line's spans: *bold*, _italic_, ~strike~, `code`, links and
    /// mentions. Each <...> token stands in the line as one placeholder
    /// character while the emphasis is worked out, so a link can be bold
    /// (*see <url|docs>*) and a token inside `code` stays as written.
    static func slackSpans(_ line: String) -> [Span] {
        let (marked, found) = marked(line)
        guard let tokens = found else { return [Span(decode(line))] }
        var spans: [Span] = []
        for span in emphasis(marked) {
            var words = ""
            func flush() {
                guard !words.isEmpty else { return }
                var piece = span
                piece.text = words
                spans.append(piece)
                words = ""
            }
            for scalar in span.text.unicodeScalars {
                guard let index = placeholderIndex(scalar), index < tokens.count else { words.unicodeScalars.append(scalar); continue }
                if span.code {
                    // Code shows what was typed.
                    words += tokens[index].raw
                    continue
                }
                flush()
                var piece = span
                switch tokens[index].token {
                case let .link(url, label):
                    piece.text = label.isEmpty ? url.absoluteString : label
                    piece.link = url
                case let .mention(text):
                    piece.text = text
                    piece.bold = true
                }
                spans.append(piece)
            }
            flush()
        }
        return merge(spans)
    }

    /// Joins neighbouring spans that look the same (a "<" that wasn't a
    /// token leaves the words around it in pieces).
    private static func merge(_ spans: [Span]) -> [Span] {
        var out: [Span] = []
        for span in spans where !span.text.isEmpty {
            if var last = out.last, last.bold == span.bold, last.italic == span.italic, last.strike == span.strike,
               last.code == span.code, last.link == span.link {
                last.text += span.text
                out[out.count - 1] = last
            } else {
                out.append(span)
            }
        }
        return out
    }

    /// Slack's emphasis: a marker counts when it opens at the start or
    /// after a space or punctuation, is followed by a non-space, and closes
    /// on the same line before a space, punctuation or the end. So
    /// "2*3*4" and "snake_case_name" stay as written.
    static func emphasis(_ text: String, _ base: Span = Span("")) -> [Span] {
        let chars = Array(text)
        var spans: [Span] = []
        var plain = ""
        var i = 0
        func flush() {
            guard !plain.isEmpty else { return }
            var span = base
            span.text = decode(plain)
            spans.append(span)
            plain = ""
        }
        while i < chars.count {
            let c = chars[i]
            if "*_~`".contains(c), opens(chars, i), let end = closing(chars, from: i, marker: c) {
                flush()
                let inner = String(chars[(i + 1)..<end])
                var span = base
                switch c {
                case "`":
                    span.code = true
                    span.text = decode(inner)
                    spans.append(span)
                default:
                    if c == "*" { span.bold = true } else if c == "_" { span.italic = true } else { span.strike = true }
                    spans += emphasis(inner, span)
                }
                i = end + 1
                continue
            }
            plain.append(c)
            i += 1
        }
        flush()
        return spans
    }

    private static func isWordy(_ c: Character) -> Bool { c.isLetter || c.isNumber }

    private static func opens(_ chars: [Character], _ i: Int) -> Bool {
        guard i + 1 < chars.count, !chars[i + 1].isWhitespace, chars[i + 1] != chars[i] else { return false }
        return i == 0 || !isWordy(chars[i - 1])
    }

    private static func closing(_ chars: [Character], from start: Int, marker: Character) -> Int? {
        var j = start + 2
        while j < chars.count {
            if chars[j] == marker, !chars[j - 1].isWhitespace, j + 1 == chars.count || !isWordy(chars[j + 1]) { return j }
            j += 1
        }
        return nil
    }
}
