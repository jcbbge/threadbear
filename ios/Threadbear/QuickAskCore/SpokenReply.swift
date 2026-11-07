import Foundation

/// An agent's reply, written for reading, made fit for saying out loud: what a follow-up asked by
/// voice in a quick ask thread gets spoken back. Markdown marks go, a link says its text, a bare
/// URL its host, code blocks are skipped (with a word that they're there), and a long reply stops
/// at a sentence once it's said enough, since the rest is on screen.
nonisolated enum SpokenReply {
    static func text(from markdown: String, limit: Int = 1200) -> String {
        var pieces: [String] = []
        var inCode = false
        for raw in markdown.components(separatedBy: .newlines) {
            var line = raw.trimmingCharacters(in: .whitespaces)
            if line.hasPrefix("```") {
                if !inCode { pieces.append("There's some code on screen.") }
                inCode.toggle()
                continue
            }
            if inCode || line.isEmpty { continue }
            line = line.replacing(/^(#{1,6}|>|[-*+]|\d+[.)])\s+/, with: "")
            // `[words](link)` is its words. Written so a `[` with no link
            // after it uses itself up rather than every `[` being tried to
            // the end of the line again, which was quadratic.
            line = line.replacing(/\[([^\]]+)(?:\](?:\([^)]+(\))?)?)?/) { $0.2 == nil ? String($0.0) : String($0.1) }
            line = line.replacing(/https?:\/\/[^\s)]+/) { match in
                URL(string: String(match.0).trimmingCharacters(in: CharacterSet(charactersIn: ".,;:")))?.host() ?? ""
            }
            line = line.replacing(/[*_`~]+/, with: "")
            line = line.trimmingCharacters(in: .whitespaces)
            guard !line.isEmpty else { continue }
            // A line without its own full stop (a heading, a list item) still ends a sentence.
            if let last = line.last, !".!?:;".contains(last) { line += "." }
            pieces.append(line)
        }
        var spoken = pieces.joined(separator: " ")
        if spoken.count > limit {
            let cut = spoken.prefix(limit)
            if let end = cut.lastIndex(where: { ".!?".contains($0) }) {
                spoken = String(spoken[...end]) + " The rest is on screen."
            } else {
                spoken = String(cut) + "… The rest is on screen."
            }
        }
        return spoken
    }
}
