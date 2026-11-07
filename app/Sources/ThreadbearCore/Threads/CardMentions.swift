import Foundation

/// Notion cards and other threads mentioned in a message. A message always
/// holds a plain Markdown link (`ProjectTask.reference`,
/// `CardMentions.threadReference`), so the agent gets an address it can
/// read the card or thread from, and the phone, `read_thread` and the
/// archive get ordinary words. The composer and Mike's bubble draw these as
/// chips.
public enum CardMentions {
    public enum Kind: Sendable, Hashable {
        case card
        /// Another thread, as a `thread:<id>` link (WorkLinks), which the
        /// transcript already opens in the app.
        case thread
    }

    public struct Mention: Sendable, Hashable {
        /// The whole link in the text, UTF-16, for attributed strings.
        public var range: NSRange
        public var title: String
        public var url: String
        public var kind: Kind = .card
    }

    public static func find(in text: String) -> [Mention] {
        guard text.contains("notion.") || text.contains("](thread:") else { return [] }
        let ns = text as NSString
        return links(in: Array(text.utf16)).map { link in
            let title = ns.substring(with: link.title)
                .replacingOccurrences(of: "\\[", with: "[")
                .replacingOccurrences(of: "\\]", with: "]")
            let url = ns.substring(with: link.url)
            return Mention(range: link.whole, title: title, url: url, kind: url.hasPrefix("thread:") ? .thread : .card)
        }
    }

    // A forward scan, not a regex: `[` was allowed in a title, so with no
    // `](` after them every `[` started a match that ran to the end of the
    // line, and 32,000 of them took 16 seconds on a paste or a message
    // (Daybreak, 7 Nov 2026). It finds what the regex
    // `(?<!!)\[((?:[^\]\\\n]|\\.)+)\]\((https://(?:[A-Za-z0-9-]+\.)*notion\.(?:so|site|com)/[^\s)]*|thread:[A-Za-z0-9_-]+)\)`
    // found: a title with escaped brackets allowed in it, then an https
    // address on Notion's own domains or a thread: link. Nothing but a
    // link's end or a space ends the address, and the domain has to finish
    // where the path starts, so notion.so.example.com is no card. Each
    // character is looked at a few times at most.
    private static func links(in u: [UInt16]) -> [(whole: NSRange, title: NSRange, url: NSRange)] {
        let n = u.count
        var found: [(whole: NSRange, title: NSRange, url: NSRange)] = []
        // Where an address from each place would stop: at the next `)` or
        // space. An address can hold `[` and `](`, so the addresses of links
        // that fail overlap, and scanning each to its end again was
        // quadratic too.
        var stop = [Int](repeating: n, count: n + 1)
        if n > 0 {
            for k in stride(from: n - 1, through: 0, by: -1) {
                stop[k] = u[k] == shut || isSpace(u[k]) ? k : stop[k + 1]
            }
        }
        var i = 0
        while i < n {
            guard u[i] == bracket else { i += 1; continue }
            // Where a title from here ends: at the first `]` not escaped, or
            // nowhere if a line ends first. Every `[` before that end gives
            // the same one (a `[` isn't an escape), so they're all settled
            // by this one scan.
            var k = i + 1
            var end: Int?
            while k < n {
                let c = u[k]
                if c == close { end = k; break }
                if c == newline { break }
                if c == backslash {
                    // An escape takes any one character but a line break.
                    guard k + 1 < n, !lineBreaks.contains(u[k + 1]) else { break }
                    k += 2
                    continue
                }
                k += 1
            }
            guard let end else { i = max(k, i + 1); continue }
            // The first of those `[`s not after a `!` (a picture) with a
            // title left between it and the end.
            var start: Int?
            var j = i
            while j < end - 1 {
                if u[j] == bracket, j == 0 || u[j - 1] != bang { start = j; break }
                j += 1
            }
            if let start, let (url, after) = destination(in: u, from: end + 1, stop: stop) {
                found.append((NSRange(location: start, length: after - start),
                              NSRange(location: start + 1, length: end - start - 1), url))
                i = after
            } else {
                i = end + 1
            }
        }
        return found
    }

    /// `(https://…notion.so/…)` or `(thread:<id>)` from `at`: the address's
    /// range and where the link ends, just past its `)`.
    private static func destination(in u: [UInt16], from at: Int, stop: [Int]) -> (NSRange, Int)? {
        let n = u.count
        guard at < n, u[at] == open else { return nil }
        let begin = at + 1
        func has(_ word: [UInt16], at index: Int) -> Bool {
            index + word.count <= n && Array(u[index..<(index + word.count)]) == word
        }
        var k: Int
        if has(threadScheme, at: begin) {
            k = begin + threadScheme.count
            let idStart = k
            while k < n, isIdCharacter(u[k]) { k += 1 }
            guard k > idStart else { return nil }
        } else if has(https, at: begin) {
            let host = begin + https.count
            k = host
            while k < n, isHostCharacter(u[k]) { k += 1 }
            guard k < n, u[k] == slash, isNotionHost(Array(u[host..<k])) else { return nil }
            k = stop[k]
        } else {
            return nil
        }
        guard k < n, u[k] == shut else { return nil }
        return (NSRange(location: begin, length: k - begin), k + 1)
    }

    /// `(?:[A-Za-z0-9-]+\.)*notion\.(?:so|site|com)`, exactly.
    private static func isNotionHost(_ host: [UInt16]) -> Bool {
        for top in notionHosts where host.count >= top.count && Array(host.suffix(top.count)) == top {
            let labels = host.dropLast(top.count)
            if labels.isEmpty { return true }
            guard labels.last == dot else { continue }
            // Each label before it has a character at least, and no dots.
            var length = 0
            var ok = true
            for c in labels {
                if c == dot {
                    if length == 0 { ok = false; break }
                    length = 0
                } else {
                    length += 1
                }
            }
            if ok { return true }
        }
        return false
    }

    private static func isIdCharacter(_ c: UInt16) -> Bool {
        isAlphanumeric(c) || c == 0x5F || c == 0x2D
    }

    private static func isHostCharacter(_ c: UInt16) -> Bool {
        isAlphanumeric(c) || c == 0x2D || c == dot
    }

    private static func isAlphanumeric(_ c: UInt16) -> Bool {
        (0x30...0x39).contains(c) || (0x41...0x5A).contains(c) || (0x61...0x7A).contains(c)
    }

    /// What the regex's `\s` matched (ICU's White_Space), so an address
    /// ends where it did.
    private static func isSpace(_ c: UInt16) -> Bool {
        (0x09...0x0D).contains(c) || c == 0x20 || c == 0x85 || c == 0xA0 || c == 0x1680
            || (0x2000...0x200A).contains(c) || c == 0x2028 || c == 0x2029 || c == 0x202F || c == 0x205F || c == 0x3000
    }

    private static let bracket: UInt16 = 0x5B, close: UInt16 = 0x5D, open: UInt16 = 0x28, shut: UInt16 = 0x29
    private static let backslash: UInt16 = 0x5C, bang: UInt16 = 0x21, newline: UInt16 = 0x0A, slash: UInt16 = 0x2F, dot: UInt16 = 0x2E
    /// What `.` doesn't match after a backslash.
    private static let lineBreaks: Set<UInt16> = [0x0A, 0x0B, 0x0C, 0x0D, 0x85, 0x2028, 0x2029]
    private static let https = Array("https://".utf16), threadScheme = Array("thread:".utf16)
    private static let notionHosts = ["notion.so", "notion.site", "notion.com"].map { Array($0.utf16) }

    /// How a pasted thread id goes into a message: a link the agent can read
    /// the id from and the app draws as a chip with the thread's title.
    public static func threadReference(id: String, title: String) -> String {
        let words = title.split(whereSeparator: \.isNewline).joined(separator: " ").trimmingCharacters(in: .whitespaces)
        let name = (words.isEmpty ? "Thread" : words)
            .replacingOccurrences(of: "[", with: "\\[").replacingOccurrences(of: "]", with: "\\]")
        return "[\(name)](thread:\(id))"
    }

    /// The thread a paste names on its own: a bare id ("Copy thread id"),
    /// `thread:<id>` or `threadbear://thread/<id>`. Only ids of known
    /// threads count, so any other UUID pasted stays words.
    public static func pastedThreadId(_ pasted: String, known: (String) -> Bool) -> String? {
        var text = pasted.trimmingCharacters(in: .whitespacesAndNewlines)
        for prefix in ["threadbear://thread/", "thread:"] where text.lowercased().hasPrefix(prefix) {
            text = String(text.dropFirst(prefix.count))
        }
        guard !text.isEmpty, text.count <= 64,
              text.allSatisfy({ $0.isASCII && ($0.isLetter || $0.isNumber || $0 == "-" || $0 == "_") }) else { return nil }
        if known(text) { return text }
        return known(text.lowercased()) ? text.lowercased() : nil
    }
}
