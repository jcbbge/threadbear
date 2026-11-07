import Foundation

/// A reply as Voice mode says it: the markdown taken out, code and tables
/// left for the screen, and the rest cut into sentences so the first one
/// can be spoken while the next is still being made.
public enum SpokenText {
    /// What's said in place of a code block or a table.
    public static let codeLine = "There's some code on screen."
    public static let tableLine = "There's a table on screen."

    /// The reply's words, ready to speak, one entry per sentence (long
    /// sentences split at a comma or a space so none is too long to start
    /// quickly). Empty when there's nothing worth saying.
    public static func sentences(_ markdown: String, maxLength: Int = 220) -> [String] {
        split(plain(markdown)).flatMap { cut($0, maxLength: maxLength) }
    }

    /// The reply as plain spoken text, sentences joined by spaces.
    public static func plain(_ markdown: String) -> String {
        var lines: [String] = []
        var inCode = false
        var saidCode = false
        var saidTable = false
        for raw in markdown.components(separatedBy: "\n") {
            let line = raw.trimmingCharacters(in: .whitespaces)
            if line.hasPrefix("```") || line.hasPrefix("~~~") {
                if !inCode, !saidCode { lines.append(codeLine); saidCode = true }
                inCode.toggle()
                continue
            }
            if inCode { continue }
            if line.hasPrefix("|") {
                if !saidTable { lines.append(tableLine); saidTable = true }
                continue
            }
            saidTable = false
            if line.isEmpty || line.allSatisfy({ "-*_=".contains($0) }) { lines.append(""); continue }
            var text = line
            // Headings, quotes and list markers.
            text = text.replacingOccurrences(of: #"^#{1,6}\s+"#, with: "", options: .regularExpression)
            text = text.replacingOccurrences(of: #"^>\s?"#, with: "", options: .regularExpression)
            text = text.replacingOccurrences(of: #"^([-*+]|\d+[.)])\s+(\[[ xX]\]\s+)?"#, with: "", options: .regularExpression)
            text = inline(text)
            guard !text.isEmpty else { continue }
            // A heading or list item with no stop of its own still ends a sentence.
            if let last = text.last, !".!?:;".contains(last) { text += "." }
            lines.append(text)
        }
        return lines.filter { !$0.isEmpty }.joined(separator: " ")
            .replacingOccurrences(of: #"\s+"#, with: " ", options: .regularExpression)
            .trimmingCharacters(in: .whitespaces)
    }

    /// Links, emphasis, inline code and bare urls, as they'd be read.
    static func inline(_ text: String) -> String {
        var t = text
        // Pictures go; links keep their words.
        t = t.replacingOccurrences(of: #"!\[[^\]]*\]\([^)]*\)"#, with: "", options: .regularExpression)
        t = t.replacingOccurrences(of: #"\[([^\]]+)\]\([^)]*\)"#, with: "$1", options: .regularExpression)
        t = t.replacingOccurrences(of: #"https?://[^\s)]+"#, with: "a link", options: .regularExpression)
        t = t.replacingOccurrences(of: #"`([^`]*)`"#, with: "$1", options: .regularExpression)
        t = t.replacingOccurrences(of: #"(\*\*|__|\*|_|~~)(?=\S)(.+?)(?<=\S)\1"#, with: "$2", options: .regularExpression)
        t = t.replacingOccurrences(of: "**", with: "")
        return t.trimmingCharacters(in: .whitespaces)
    }

    /// Sentences, at a stop followed by a space.
    static func split(_ text: String) -> [String] {
        guard !text.isEmpty else { return [] }
        var out: [String] = []
        var current = ""
        let chars = Array(text)
        for (i, c) in chars.enumerated() {
            current.append(c)
            let next = i + 1 < chars.count ? chars[i + 1] : " "
            if ".!?".contains(c), next == " " || next == "\n" {
                let s = current.trimmingCharacters(in: .whitespaces)
                if !s.isEmpty { out.append(s) }
                current = ""
            }
        }
        let rest = current.trimmingCharacters(in: .whitespaces)
        if !rest.isEmpty { out.append(rest) }
        return out
    }

    /// A sentence too long to start speaking quickly, cut at commas, or
    /// failing that at spaces.
    static func cut(_ sentence: String, maxLength: Int) -> [String] {
        guard sentence.count > maxLength else { return [sentence] }
        var out: [String] = []
        var current = ""
        for word in sentence.split(separator: " ") {
            let candidate = current.isEmpty ? String(word) : current + " " + word
            if candidate.count > maxLength, !current.isEmpty {
                out.append(current)
                current = String(word)
            } else {
                current = candidate
                if current.hasSuffix(","), current.count > maxLength / 2 {
                    out.append(current)
                    current = ""
                }
            }
        }
        if !current.isEmpty { out.append(current) }
        return out
    }
}
