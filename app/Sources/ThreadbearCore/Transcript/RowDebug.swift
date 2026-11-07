import Foundation

/// What an agent needs to find a transcript row again: the row's own words
/// for dumps, and "Copy debug info" (the thread, the row, the events it was
/// built from and the runner), so Mike can point at a row and an agent can
/// pull up the same events with `tb events --from --to` or a fixture
/// export (line N of its events.ndjson is seq N).
public enum RowDebug {
    /// The row's text on one line, cut to `limit` characters.
    public static func excerpt(_ row: TranscriptRow, limit: Int = 100) -> String {
        oneLine(text(row), limit: limit)
    }

    /// The row's words, whatever kind it is.
    public static func text(_ row: TranscriptRow) -> String {
        switch row.content {
        case .user(let message):
            // One on its way says so, as its spinner or clock does.
            if let pending = message.pending {
                var plain = message
                plain.pending = nil
                return "(\(pending == .sending ? "sending" : "queued")) " + text(TranscriptRow(id: "", seq: 0, content: .user(plain)))
            }
            if message.text.isEmpty { return message.images.count == 1 ? "1 image" : "\(message.images.count) images" }
            // A dump should say it wasn't Mike, as the transcript does.
            if message.isFromRunner { return "(sent by the runner) " + message.text }
            if message.isFromSchedule { return "(sent by a schedule) " + message.text }
            return message.text
        case .assistant(let item), .reasoning(let item):
            return item.text
        case .tool(let tool):
            return tool.failed ? tool.title + " (failed)" : tool.title
        case .images(_, let images, _):
            return images.count == 1 ? "1 image" : "\(images.count) images"
        case .approval(let item):
            guard let resolution = item.resolution else { return item.request.title }
            return "\(item.request.title) (\(resolution.decision.rawValue))"
        case .question(let item):
            return item.request.questions.map(\.question).joined(separator: " / ")
        case .secret(let item):
            return item.resolvedText ?? item.request.label
        case .review(let review):
            return "\(review.title) · \(review.options.count) images · \(review.status)"
        case .plan(let entries):
            return entries.map(\.text).joined(separator: "; ")
        case .planCard(let card):
            let state = switch card.state { case .waiting: "waiting"; case .approved: "approved"; case .sentBack: "sent back" }
            return "plan (\(state))" + (card.entries.isEmpty ? ": " + PlanCardText.summary(card.text) : ", " + card.entries.map(\.text).joined(separator: "; "))
        case .asks(let card):
            if card.isDone {
                let loose = card.looseEnds.map { $0.isEmpty ? ", loose ends: none" : ", loose ends: " + $0.map(\.text).joined(separator: "; ") } ?? ""
                return "\(card.isOpen ? "open" : "closed"), nothing needed" + loose + (card.next.isEmpty ? "" : ", next: " + card.next.enumerated().map { (card.pickedNext.contains($0.offset) ? "[x] " : "") + $0.element }.joined(separator: "; "))
            }
            return "\(card.isOpen ? "open" : "closed"), \(card.tickedCount) of \(card.asks.count) ticked: " + card.asks.map(\.action).joined(separator: "; ")
        case .footer(let completion):
            var text = RelativeTime.duration(milliseconds: completion.durationMs)
            if let cost = CostText.format(completion.costUsd) { text += ", " + cost }
            if completion.outcome != .completed { text += ", " + completion.outcome.rawValue }
            // Codex's footer shows only the time; its tokens are here.
            if let tokens = TokenText.line(completion.usage) { text += ", " + tokens }
            return text
        case .note(let text), .error(let text, _):
            return text
        case .group(let group):
            return group.summary
        case .working:
            return "Working"
        case .background(let status):
            return BackgroundWork.lineWithDetail(status.tasks)
        case .changes(let card):
            return card.title
        case .gap(let gap):
            return gap.label
        }
    }

    static func oneLine(_ text: String, limit: Int) -> String {
        let words = text.split(whereSeparator: \.isWhitespace).joined(separator: " ")
        guard words.count > limit else { return words }
        return String(words.prefix(max(0, limit - 1))) + "…"
    }

    /// Where an agent finds a row's events. A bare `tb` reaches the runner
    /// a thread runs on (the installed one), so an app on a dev runner names
    /// that runner's own `<home>/tb`, and under the mock they're lines of the
    /// fixture's events.ndjson (a `tb events` there would ask the live
    /// runner for a thread it doesn't have).
    public enum EventsSource: Equatable, Sendable {
        /// The tb to run, as it would be typed: `tb`, a path, or with
        /// `THREADBEAR_HOME=...` in front.
        case tb(String)
        case fixture
    }

    /// "Copy debug info": one `key: value` per line, so it reads well
    /// pasted into a message and an agent can pick it apart.
    public static func info(threadId: String, row: TranscriptRow, seqs: [Int], runnerVersion: String, source: EventsSource = .tb("tb")) -> String {
        var lines = [
            "thread: \(threadId)",
            "row: \(row.id)",
            "kind: \(row.kind.rawValue)",
        ]
        if let turn = row.turnId, !turn.isEmpty { lines.append("turn: \(turn)") }
        // The footer shows only the time (and Claude's cost); the turn's
        // tokens are here.
        if case .footer(let completion) = row.content {
            if let tokens = TokenText.line(completion.usage) { lines.append("tokens: \(tokens)") }
            if let kind = completion.errorKind { lines.append("error kind: \(kind.rawValue)") }
        }
        lines.append("events: " + (seqs.isEmpty ? "none loaded" : seqRanges(seqs)))
        lines.append("runner: \(runnerVersion.isEmpty ? "unknown" : runnerVersion)")
        // The command that prints those events, ready to run.
        if let first = seqs.min(), let last = seqs.max() {
            switch source {
            case .tb(let tb):
                lines.append("see: \(tb) events \(threadId) --from \(first) --to \(last)")
            case .fixture:
                let range = first == last ? "line \(first)" : "lines \(first)-\(last)"
                lines.append("see: \(range) of events.ndjson in the thread's fixture folder (line N is seq N)")
            }
        }
        return lines.joined(separator: "\n") + "\n"
    }

    /// "3, 7-9, 12": runs of seqs written as ranges, so a big group's
    /// events stay one short line.
    public static func seqRanges(_ seqs: [Int]) -> String {
        let sorted = Array(Set(seqs)).sorted()
        var parts: [String] = []
        var index = 0
        while index < sorted.count {
            var end = index
            while end + 1 < sorted.count, sorted[end + 1] == sorted[end] + 1 { end += 1 }
            parts.append(end > index ? "\(sorted[index])-\(sorted[end])" : "\(sorted[index])")
            index = end + 1
        }
        return parts.joined(separator: ", ")
    }
}

extension TranscriptModel {
    /// The seqs of the loaded events a row was built from, oldest first: a
    /// tool's call, result and diff; an approval's request and its answer; a
    /// group's members; a changes card's edits; the turn's start for the
    /// working line.
    public func sourceSeqs(of rowId: String) -> [Int] {
        var wanted: Set<String> = [rowId]
        switch (row(id: rowId) ?? item(id: rowId))?.content {
        case .group(let group)?:
            wanted = Set(group.memberIds)
        case .changes(let card)?:
            wanted = Set(items.filter { $0.turnId == card.turnId && $0.kind == .diff }.map(\.id))
        default:
            break
        }
        var planRows: [String: String] = [:]
        return events.compactMap { event in
            Self.rowIds(for: event, planRows: &planRows).contains(where: wanted.contains) ? event.seq : nil
        }
    }

    /// The item and derived rows an event feeds, with the same ids the
    /// reducer gives them. `planRows` carries each turn's plan row along,
    /// since every update of a turn's plan goes to its first one.
    static func rowIds(for event: Event, planRows: inout [String: String]) -> [String] {
        let seq = event.seq
        switch event.payload {
        case .userMessage: return ["u:\(seq)"]
        case .assistantText(let itemId, _, _, _, _, _): return ["a:" + itemId]
        case .reasoning(let itemId, _): return ["r:" + itemId]
        case .toolCall(let call): return ["t:" + call.itemId]
        case .toolResult(let result): return ["t:" + result.itemId] + (result.images.isEmpty ? [] : ["i:" + result.itemId])
        case .editDiff(let diff): return ["t:" + diff.itemId]
        case .approvalRequested(let request): return ["ap:" + request.approvalId]
        case .questionRequested(let request): return ["q:" + request.approvalId]
        case .secretRequested(let request): return ["s:" + request.approvalId]
        case .reviewUpdated(let review): return ["review:" + review.id]
        case .approvalResolved(let resolution): return ["ap:" + resolution.approvalId, "q:" + resolution.approvalId, "s:" + resolution.approvalId]
        case .planProposed(let itemId, _), .planResolved(let itemId, _): return ["pl:" + itemId]
        case .planUpdated:
            let key = event.turnId ?? "seq\(seq)"
            let id = planRows[key] ?? "p:\(seq)"
            planRows[key] = id
            return [id]
        case .turnStarted: return ["w:" + (event.turnId ?? "")]
        case .turnCompleted(let completion):
            return ["f:" + (completion.turnId.isEmpty ? (event.turnId ?? "seq\(seq)") : completion.turnId)]
        case .systemNote: return ["n:\(seq)"]
        case .threadRewound: return ["rw:\(seq)"]
        case .error: return ["e:\(seq)"]
        case .actionRun(let run): return ["t:" + run.itemId(seq: seq)]
        default: return []
        }
    }
}

/// A turn's token counts in words, for "Copy debug info" (the footer
/// itself shows only the time, and Claude's cost).
public enum TokenText {
    /// "24,177 in (12,032 cached), 310 out, 120 reasoning", from either
    /// provider's `usage` (Claude's cache reads count as cached). Nil with
    /// no counts.
    public static func line(_ usage: JSONValue?) -> String? {
        guard let usage else { return nil }
        func count(_ key: String) -> Int? { usage[key]?.doubleValue.flatMap { $0.wholeCount() } }
        var parts: [String] = []
        if let input = count("inputTokens") {
            var part = format(input) + " in"
            if let cached = count("cachedInputTokens") ?? count("cacheReadTokens"), cached > 0 { part += " (\(format(cached)) cached)" }
            parts.append(part)
        }
        if let written = count("cacheWriteTokens"), written > 0 { parts.append(format(written) + " cache written") }
        if let output = count("outputTokens") { parts.append(format(output) + " out") }
        if let reasoning = count("reasoningTokens"), reasoning > 0 { parts.append(format(reasoning) + " reasoning") }
        return parts.isEmpty ? nil : parts.joined(separator: ", ")
    }

    static func format(_ n: Int) -> String {
        let digits = String(abs(n))
        var out = ""
        for (i, c) in digits.reversed().enumerated() {
            if i > 0 && i % 3 == 0 { out.append(",") }
            out.append(c)
        }
        return (n < 0 ? "-" : "") + String(out.reversed())
    }
}
