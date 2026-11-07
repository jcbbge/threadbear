import Foundation

/// Turns transcript rows back into Markdown for "Copy message" and
/// "Copy transcript as Markdown" (selection can't span table rows). A
/// transcript export takes the model's `items`, so nothing folded in a
/// group is left out.
public enum MarkdownExport {
    public static func transcript(title: String, rows: [TranscriptRow]) -> String {
        var parts: [String] = []
        if !title.isEmpty { parts.append("# \(title)") }
        for row in rows {
            if let text = section(for: row) { parts.append(text) }
        }
        return parts.joined(separator: "\n\n") + "\n"
    }

    /// The row as it reads in a transcript export (with a speaker heading
    /// for messages).
    public static func section(for row: TranscriptRow) -> String? {
        switch row.content {
        case .user(let message):
            // The resume after a restart, or a schedule's message, wasn't
            // Mike talking.
            let speaker = message.isFromRunner ? "Runner" : message.isFromSchedule ? "Schedule" : "You"
            var text = "## \(speaker)\n\n" + message.text
            for image in message.images { text += "\n\n![image](\(image.path))" }
            return text
        case .assistant(let item):
            return "## Claude\n\n" + item.text
        default:
            return message(for: row)
        }
    }

    /// The row's own content, for "Copy message".
    public static func message(for row: TranscriptRow) -> String? {
        switch row.content {
        case .user(let message):
            return ([message.text] + message.images.map { "![image](\($0.path))" }).joined(separator: "\n\n")
        case .assistant(let item):
            return item.text
        case .reasoning(let item):
            return item.text.split(separator: "\n", omittingEmptySubsequences: false).map { "> " + $0 }.joined(separator: "\n")
        case .tool(let tool):
            var text = "**\(tool.name)**: `\(tool.title.replacingOccurrences(of: "`", with: "'"))`"
            let diffs = tool.effectiveDiffs.filter { !$0.hunks.isEmpty }
            if !diffs.isEmpty {
                for diff in diffs {
                    let body = diff.hunks.map { hunk in
                        (["@@ -\(hunk.oldStart),\(hunk.oldLines) +\(hunk.newStart),\(hunk.newLines) @@"] + hunk.lines).joined(separator: "\n")
                    }.joined(separator: "\n")
                    // Each file's name, when there are several.
                    let header = diffs.count > 1 && !diff.path.isEmpty ? "--- \(diff.path)\n" : ""
                    text += "\n\n```diff\n\(header)\(body)\n```"
                }
            } else if let result = tool.result, !result.text.isEmpty {
                text += "\n\n" + fenced(result.text)
            }
            return text
        case .images(_, let images, _):
            return images.map { "![image](\($0.path))" }.joined(separator: "\n")
        case .approval(let item):
            let decision = item.resolution.map { " (\(label(for: $0.decision)))" } ?? ""
            return "**Approval**: \(item.request.title)\(decision)"
        case .question(let item):
            return item.request.questions.map { "**Question**: \($0.question)" }.joined(separator: "\n")
        case .secret(let item):
            // The card's text only: the app never has the value.
            return "**Asked for a secret**: " + (item.resolvedText ?? item.request.label)
        case .review(let review):
            var lines = ["**Design review**: \(review.title) (\(review.status))"]
            if let note = review.note { lines.append(note) }
            let response = review.response ?? review.draft
            for option in review.options {
                var line = "- \(option.id). \(option.title)"
                if response.pickedIds.contains(option.id) { line += " (picked)" }
                if option.reference { line += " (reference)" }
                if option.allShots.count > 1 { line += " (\(option.allShots.count) shots)" }
                if let note = response.notes[option.id], !note.isEmpty { line += ": " + note }
                lines.append(line)
            }
            if response.none { lines.append("None of them") }
            if let reply = response.reply, !reply.isEmpty { lines.append(reply) }
            return lines.joined(separator: "\n")
        case .planCard(let card):
            let state = switch card.state { case .waiting: ""; case .approved: " (approved)"; case .sentBack: " (sent back)" }
            return "**Plan**\(state)\n\n" + card.text
        case .plan(let entries):
            return entries.map { entry in
                let box = entry.status == .completed ? "[x]" : "[ ]"
                return "- \(box) \(entry.text)"
            }.joined(separator: "\n")
        case .asks(let card):
            if card.isDone {
                let next = card.next.map { "\n- Could do next: \($0)" }.joined()
                return "**What I need from you**\n\nNothing needed from you." + (next.isEmpty ? "" : "\n" + next)
            }
            return "**What I need from you**\n\n" + card.asks.enumerated().map { index, ask in
                "- [\(card.ticked.contains(index) ? "x" : " ")] \(Decisions.continued(Decisions.paragraph(ask), under: "- [ ] "))" + (ask.where_.map { " (\($0))" } ?? "")
            }.joined(separator: "\n")
        case .footer(let completion):
            var text = "_\(RelativeTime.duration(milliseconds: completion.durationMs))"
            if let cost = CostText.format(completion.costUsd) { text += ", " + cost }
            if completion.outcome != .completed { text += ", \(completion.outcome.rawValue)" }
            return text + "_"
        case .note(let text):
            return "_\(text)_"
        case .error(let message, _):
            return "**Error**: \(message)"
        case .group(let group):
            return "_\(group.summary)_"
        case .working, .background:
            return nil
        case .changes(let card):
            let files = card.files.map { "- `\($0.path)` +\($0.added) −\($0.removed)" }
            return ([card.title + ":"] + files).joined(separator: "\n")
        case .gap(let gap):
            return "_\(gap.label)_"
        }
    }

    static func fenced(_ text: String) -> String {
        // Use a fence longer than any backtick run inside the text.
        var longest = 0, run = 0
        for character in text {
            if character == "`" { run += 1; longest = max(longest, run) } else { run = 0 }
        }
        let fence = String(repeating: "`", count: max(3, longest + 1))
        return "\(fence)\n\(text)\n\(fence)"
    }

    static func label(for decision: ApprovalDecision) -> String {
        switch decision {
        case .allow: return "allowed"
        case .allowAlways: return "always allowed"
        case .deny: return "denied"
        case .answered: return "answered"
        case .expired: return "expired"
        }
    }
}
