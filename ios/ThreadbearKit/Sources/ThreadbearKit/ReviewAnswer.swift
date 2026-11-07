import Foundation

/// Mike's answer to a review (show_options on the Mac), read back out of the
/// message the runner sent for it (`reviewReply` in runner/src/reviews.ts),
/// so the bubble says what he picked rather than the review's id and the
/// wording the agent gets. The Mac does the same with the review's id and
/// draft from the event (`ReviewAnswer` in ThreadbearCore); the mirror only
/// has the text, so this goes by the runner's wording alone, and anything
/// that doesn't fit it is shown as it is.
public struct ReviewAnswer: Sendable, Hashable {
    public struct Line: Sendable, Hashable {
        /// Small and quiet, over the line: what it's about.
        public var label: String
        /// What he picked or wrote.
        public var text: String
    }

    /// The review's title.
    public var title: String
    public var lines: [Line]

    /// "Review: <title> (<uuid>)", then "Picked <id>. <option>." (or
    /// "Picked A + D. <option> + <option>.", or "Picked none of them."),
    /// then his reply as he wrote it, then "Notes on <id> (<option>): <note>"
    /// paragraphs (`reviewReply` in runner/src/reviews.ts).
    public static func parse(_ text: String) -> ReviewAnswer? {
        guard let head = text.firstMatch(of: /^Review: (.+?) \(([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\)(?:\n\n|$)/) else { return nil }
        let title = String(head.1)
        var paragraphs = text[head.range.upperBound...].components(separatedBy: "\n\n")[...]
        if paragraphs.last == "" { paragraphs = paragraphs.dropLast() }
        var lines: [Line] = []
        if let first = paragraphs.first {
            if first == "Picked none of them." {
                lines.append(Line(label: title, text: "None of them"))
                paragraphs = paragraphs.dropFirst()
            // The id can't run past the first ". " (and below, the first
            // " ("): the plain lazy `.+?` tried every one of them with all
            // that came after, quadratic on a long line. Same matches.
            } else if let picked = first.firstMatch(of: /^Picked (.(?:(?!\. ).)*?)\. (.+?)\.?$/) {
                let id = String(picked.1)
                lines.append(Line(label: title, text: "Picked \(id): \(bare(String(picked.2), id: id))"))
                paragraphs = paragraphs.dropFirst()
            }
        }
        // Everything up to the first note is his reply, paragraphs and all.
        let reply = paragraphs.prefix { !$0.hasPrefix("Notes on ") }
        if !reply.isEmpty {
            lines.append(Line(label: lines.isEmpty ? title : "", text: reply.joined(separator: "\n\n")))
            paragraphs = paragraphs.dropFirst(reply.count)
        }
        // Paragraphs of a note stay with it: a new one starts only at "Notes on ".
        var notes: [String] = []
        for paragraph in paragraphs {
            if paragraph.hasPrefix("Notes on ") || notes.isEmpty { notes.append(paragraph) } else { notes[notes.count - 1] += "\n\n" + paragraph }
        }
        for part in notes {
            guard let note = part.firstMatch(of: /^Notes on (.(?:(?! \().)*?) \((.+?)\): ([\s\S]+)$/) else { return nil }
            let id = String(note.1)
            // With nothing picked, the review's title goes over the first note.
            lines.append(Line(label: (lines.isEmpty ? title + "\n" : "") + "Notes on \(id): \(bare(String(note.2), id: id))", text: String(note.3)))
        }
        return lines.isEmpty ? nil : ReviewAnswer(title: title, lines: lines)
    }

    /// Agents often title options "A: Summary first", which would read
    /// "Picked A: A: Summary first".
    static func bare(_ option: String, id: String) -> String {
        for sep in [": ", ". ", " - ", ") "] where option.hasPrefix(id + sep) && option.count > id.count + sep.count {
            return String(option.dropFirst(id.count + sep.count))
        }
        return option
    }
}
