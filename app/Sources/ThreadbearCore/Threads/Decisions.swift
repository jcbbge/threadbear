import Foundation

/// The open card's asks as decisions (docs/protocol.md, "Needs you",
/// Answering): what Mike can pick on each, and the one message his picks
/// and his own words go out as.
public enum Decisions {
    /// What Mike can pick from: the agent's options, or for a plain ask the
    /// reply it wants back ("done"). Either way he can write his own.
    public static func choices(for ask: Ask) -> [String] {
        if !ask.options.isEmpty { return ask.options }
        if let reply = ask.reply?.trimmingCharacters(in: .whitespacesAndNewlines), !reply.isEmpty { return [reply] }
        return impliedChoices(ask.action)
    }

    /// An ask as the markdown the card shows: its action, then its why, as
    /// the agent would have written it under "What I need from you" in its
    /// message. Mike found a bold title over a small grey reason backwards
    /// (28 Oct): you explain, then ask, in the same voice. An action with
    /// no full stop gets one, so it doesn't run into the why. The action is
    /// a sentence, so its line breaks go; the why keeps its own, so a list
    /// of questions in it draws as a list rather than one run-on line
    /// (Mike, 29 Oct).
    public static func paragraph(_ ask: Ask) -> String {
        let action = oneLine(ask.action)
        let why = (ask.why ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        guard !why.isEmpty else { return action }
        return (endsSentence(action) ? action : action + ".") + " " + why
    }

    /// Text that will follow a list marker (`under`, like "2. " or
    /// "- [ ] "), with its later lines indented past the marker so a list
    /// or paragraph in it stays inside that item rather than ending it.
    public static func continued(_ text: String, under marker: String) -> String {
        let pad = String(repeating: " ", count: marker.count)
        return text.components(separatedBy: "\n").enumerated()
            .map { $0.offset == 0 || $0.element.isEmpty ? $0.element : pad + $0.element }
            .joined(separator: "\n")
    }

    private static func oneLine(_ text: String) -> String {
        // Split by hand: `\s*\n\s*` tried every space as a start, quadratic
        // on a long run of them.
        text.split(omittingEmptySubsequences: false, whereSeparator: { $0 == "\n" || $0 == "\r\n" })
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }.filter { !$0.isEmpty }.joined(separator: " ")
    }

    /// Whether the text ends a sentence, looking past closing quotes,
    /// brackets and markdown: 'Tell me "it locked."' does.
    private static func endsSentence(_ text: String) -> Bool {
        guard let last = text.last(where: { !"\"'”’)]*_`".contains($0) }) else { return false }
        return ".?!…:".contains(last)
    }

    /// The words an ask with no options still asks for: 'Reply "export"
    /// when…' or "Say go for Short 2, or name another". Threads started
    /// before end_turn had options, and agents that skip them, mostly
    /// write asks like that (60% offered a reply word in the 27 Oct
    /// survey), so the word becomes a button. A list of them ('Reply with
    /// "Land it", "Website, then land it", or…') is a button each: taking
    /// just the first left Mike one where he'd been offered two (28 Oct).
    static func impliedChoices(_ action: String) -> [String] {
        let ns = action as NSString
        let full = NSRange(location: 0, length: ns.length)
        if let m = quoted.firstMatch(in: action, range: full) {
            var choices = [ns.substring(with: m.range(at: 1))]
            var at = m.range.upperBound
            while choices.count < maxImplied,
                  let more = Self.more.firstMatch(in: action, options: .anchored, range: NSRange(location: at, length: ns.length - at)) {
                choices.append(ns.substring(with: more.range(at: 1)))
                at = more.range.upperBound
            }
            return choices
        }
        if let m = bare.firstMatch(in: action, range: full) {
            let word = ns.substring(with: m.range(at: 1))
            return [word.prefix(1).uppercased() + word.dropFirst()]
        }
        return []
    }

    /// As many as end_turn's options take (runner/src/needs.ts).
    private static let maxImplied = 6
    private static let quoted = try! NSRegularExpression(pattern: #"\b(?:say|reply|type|send|answer)(?: with)?\s+[\"“']([^\"”']{1,40})[\"”']"#, options: .caseInsensitive)
    /// Each further quoted choice straight after the first.
    private static let more = try! NSRegularExpression(pattern: #"\s*(?:,\s*(?:or\s+)?|or\s+|/\s*)[\"“']([^\"”']{1,40})[\"”']"#, options: .caseInsensitive)
    private static let bare = try! NSRegularExpression(pattern: #"^(?:say|reply)\s+(go|yes|ok|okay|done|ship it|merge it|merge)\b"#, options: .caseInsensitive)

    /// The pick that means "Something else": a box opens under that ask,
    /// and what Mike writes (and pastes) there is its answer. Any number of
    /// asks can have one (Mike, 30 Oct: one box shared by them all meant a
    /// second Something else took the first's place).
    public static let ownAnswer = -1

    /// The picked asks as answers, in the card's order, each with its
    /// index on the card. A pick that isn't one of its ask's choices is
    /// left out, and so is "Something else" with nothing written or
    /// pasted. Pictures in the boxes are numbered across the card, in the
    /// order `images` sends them, each a [Picture N] marker where its chip
    /// is in the box, so the agent gets it right there (docs/protocol.md,
    /// "Pictures in a message"). One with no chip goes at the end.
    public static func answers(asks: [Ask], picks: [Int: Int], notes: [Int: AskNote] = [:]) -> [(index: Int, answer: AskAnswer)] {
        var picture = 0
        return asks.enumerated().compactMap { i, ask in
            guard let n = picks[i] else { return nil }
            if n == ownAnswer {
                let note = notes[i] ?? AskNote()
                let marked = InlinePictures.normalized(note.text, imageCount: note.images.count)
                let first = picture + 1
                picture += note.images.count
                let answer = InlinePictures.messageText(marked, first: first).trimmingCharacters(in: .whitespacesAndNewlines)
                guard !answer.isEmpty else { return nil }
                return (i, AskAnswer(action: ask.action, answer: answer))
            }
            let options = choices(for: ask)
            guard options.indices.contains(n) else { return nil }
            return (i, AskAnswer(action: ask.action, answer: options[n]))
        }
    }

    /// The next ask after `index` (wrapping round) with nothing picked, or
    /// nil when every other ask has a pick. Return in a Something else box
    /// goes there instead of sending while one's left, so an early Return
    /// can't send the card half answered (Mike, 7 Nov). `orThis` counts ask
    /// `index` too, last (the empty composer's Return, from the ask shown).
    /// The picks that will send something: Something else with nothing
    /// written or pasted in its box is left out of the message (`answers`),
    /// so it doesn't count as an answer either.
    public static func filled(picks: [Int: Int], notes: [Int: AskNote]) -> [Int: Int] {
        picks.filter { index, n in
            guard n == ownAnswer, let note = notes[index] else { return n != ownAnswer }
            return !note.images.isEmpty || !note.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        }
    }

    public static func nextUnanswered(after index: Int, count: Int, picks: [Int: Int], orThis: Bool = false) -> Int? {
        guard count > 0 else { return nil }
        let others = count > 1 ? (1..<count).map { (index + $0) % count } : []
        return (others + (orThis ? [index] : [])).first { picks[$0] == nil }
    }

    /// The pictures from the answered asks' boxes, in the card's order,
    /// numbered as `answers` says. The composer's own go after them.
    public static func images(asks: [Ask], picks: [Int: Int], notes: [Int: AskNote]) -> [ImageRef] {
        asks.indices.flatMap { i in picks[i] == ownAnswer ? notes[i]?.images ?? [] : [] }
    }

    /// One ordinary message: each picked ask's question then its answer,
    /// numbered as on the card (the agent wrote them in that order, and
    /// unpicked ones keep their numbers out of it, so it can tell which
    /// were answered), then whatever Mike wrote in the composer.
    public static func message(asks: [Ask], picks: [Int: Int], notes: [Int: AskNote] = [:], extra: String = "") -> String {
        let parts = answers(asks: asks, picks: picks, notes: notes).map { i, answer in
            block(answer, number: asks.count == 1 ? nil : i + 1)
        }
        var body = parts.joined(separator: "\n\n")
        let more = extra.trimmingCharacters(in: .whitespacesAndNewlines)
        if !more.isEmpty { body += (body.isEmpty ? "" : "\n\n") + more }
        return body
    }

    /// The message for follow-ups ticked on a done card: the one on its
    /// own, or several as a list, then anything he typed.
    public static func followUpMessage(_ followUps: [String], explain: [String] = [], extra: String = "") -> String {
        var body = followUps.count == 1 ? followUps[0] : followUps.map { "- \($0)" }.joined(separator: "\n")
        // The ones with their "?" on: one asked about on its own, several
        // as one question over a list.
        if !explain.isEmpty {
            let question = explain.count == 1
                ? explainMessage(explain[0])
                : "What do you mean by these? Please explain.\n" + explain.map { "- \($0)" }.joined(separator: "\n")
            body += (body.isEmpty ? "" : "\n\n") + question
        }
        let more = extra.trimmingCharacters(in: .whitespacesAndNewlines)
        if !more.isEmpty { body += (body.isEmpty ? "" : "\n\n") + more }
        return body
    }

    /// The message the "?" on a done card's follow-up sends: Mike asking
    /// what the agent meant by it, as one sounded out of nowhere on a
    /// thread about something else (31 Oct).
    public static func explainMessage(_ followUp: String) -> String {
        "What do you mean by \"\(followUp)\"? Please explain."
    }

    /// One ask's question then its answer. Numbered, the answer is
    /// indented under it, every line of it.
    static func block(_ answer: AskAnswer, number: Int?) -> String {
        guard let number else { return "\(answer.action)\n\(answer.answer)" }
        return "\(number). \(answer.action)\n   " + answer.answer.replacingOccurrences(of: "\n", with: "\n   ")
    }

    /// What Mike wrote himself in a message that answered asks: the text
    /// after the answers `message` put first, or nil when the text doesn't
    /// start with them (so the bubble shows it all as it is).
    public static func extra(in text: String, answers: [AskAnswer]) -> String? {
        guard !answers.isEmpty else { return nil }
        var rest = Substring(text)
        for answer in answers {
            // Numbered or not, as `message` wrote it.
            var number: Int?
            if let dot = rest.firstIndex(of: "."), let n = Int(rest[..<dot]), rest[rest.index(after: dot)...].hasPrefix(" ") { number = n }
            let expected = block(answer, number: number)
            guard rest.hasPrefix(expected) else { return nil }
            rest = rest.dropFirst(expected.count)
            if rest.hasPrefix("\n\n") { rest = rest.dropFirst(2) } else if !rest.isEmpty { return nil }
        }
        return rest.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    /// Whether the open card can be answered: the last completed turn said
    /// it needs Mike, with asks, and nothing running, or else a running
    /// turn whose transcript still has that card open (`card`, the
    /// session's TranscriptModel.openCard). A background job the agent
    /// left (a script waiting for his phone to unlock) wakes it with a
    /// runner message, which leaves the card open, and while that turn
    /// ran every click on it did nothing (Mike, 7 Nov); his answer now
    /// goes into the running turn like anything he sends mid-turn. The
    /// summary keeps its asks until the turn ends, even after his own
    /// reply (from the phone too) closed the card, so a running thread
    /// takes the card's word for it: an unsent pick on a card he'd
    /// already answered mustn't go with his next message.
    public static func isOpen(_ thread: ThreadSummary, card openCard: TranscriptRow? = nil) -> Bool {
        guard thread.needs == "you", let seq = thread.asksSeq, !thread.asks.isEmpty else { return false }
        guard thread.status.isBusy else { return true }
        guard case .asks(let card)? = openCard?.content else { return false }
        return card.isOpen && !card.isDone && card.seq == seq
    }

    /// The summary with the card the transcript has open, for a summary
    /// that comes without one: another runner's thread read through
    /// Convex, whose sidebar row leaves the asks out (AppModel.withRelayCard).
    /// The asks and their seq are the card's, so a pick on it matches.
    /// No open card with asks (answered, a done card, none yet) leaves
    /// none.
    public static func withCard(_ thread: ThreadSummary, _ openCard: TranscriptRow?) -> ThreadSummary {
        var out = thread
        if case .asks(let card)? = openCard?.content, card.isOpen, !card.isDone, !card.asks.isEmpty {
            out.needs = "you"
            // Ticks live on the card, not its asks (asks.ticked).
            out.asks = card.asks.enumerated().map { i, ask in var ask = ask; ask.ticked = card.ticked.contains(i); return ask }
            out.asksSeq = card.seq
        } else {
            out.needs = nil
            out.asks = []
            out.asksSeq = nil
        }
        return out
    }
}
