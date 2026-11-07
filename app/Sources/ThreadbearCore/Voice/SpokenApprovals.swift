import Foundation

/// Which approval card a spoken yes or no answers in Voice mode. A voice yes
/// can let a tool run, so this errs towards not answering: the card stays on
/// screen, where it can always be answered.
///
/// A spoken answer only goes to a card that was read out whole, to the end,
/// and only if he started saying it after that and after the app stopped
/// talking, by when the words were captured, not when the recogniser handed
/// them over. The card must also still be open, unchanged and the newest
/// waiting. So a card that came in just before he answered the last can't
/// take his yes (the review that asked for this, 7 Nov), nor can one that
/// arrives while a slow recogniser is still working on that yes, and nor can
/// the agent approve itself by being heard saying "yes" from the speakers
/// (Codex's review of the first go at this). Anything that sounds like an
/// answer but isn't one of these answers nothing, and the card is read again.
public struct SpokenApprovals: Sendable, Equatable {
    /// Cards waiting, oldest first.
    public private(set) var open: [ApprovalRequest] = []
    /// The card read out to the end, which an answer may go to.
    public private(set) var heard: ApprovalRequest?
    /// When its reading finished, on the same clock as `take`'s times.
    private var heardAt = Double.infinity

    public init() {}

    public enum Outcome: Equatable, Sendable {
        /// Answer this card with this decision.
        case answer(ApprovalRequest, ApprovalDecision)
        /// It sounded like an answer, but not to a card he has heard: read
        /// this one (the newest) out again rather than guess.
        case readAgain(ApprovalRequest)
        /// It sounded like an answer, but the newest card can't be read out
        /// whole (`reading`): it's for the screen.
        case onScreen(ApprovalRequest)
        /// Not an answer, or no card waiting: his words go as a message.
        case message
    }

    /// The longest command read out: past this nobody's really following.
    static let longestReading = 160

    /// What a command read out may be made of: what can be said and heard
    /// for what it is. Not `;`, `|`, `$(...)` and the like, which a voice skips
    /// or a listener loses, nor anything outside ASCII, where an invisible or
    /// look-alike character makes it a different command that sounds the same.
    private static let sayable = Set("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 -_./=:,@")

    /// The words that say all of what approving this card would do, or nil
    /// if there aren't any: then Voice can't answer it, and it's for the
    /// screen. Only a plain one-line command is. A title alone isn't enough:
    /// a command's is its first line, so "echo checking" could hide an
    /// `rm -rf` on the line below, "Edit a.ts" says nothing of the edit, and
    /// "Read .env" not which folder's. Plans and another Mac asking for a
    /// thread have more on screen too. Read as it stands, not through
    /// SpokenText, which leaves code and links out.
    public static func reading(of card: ApprovalRequest) -> String? {
        let title = card.title
        guard !title.isEmpty, title.count <= longestReading,
              card.name == "Bash" || card.name == "PowerShell",
              card.input["command"]?.stringValue == title,
              title.allSatisfy({ sayable.contains($0) }) else { return nil }
        return title
    }

    /// A card came in (or came again, maybe changed). Nothing heard counts
    /// until this one, the newest, has been read out.
    public mutating func requested(_ card: ApprovalRequest) {
        open.removeAll { $0.approvalId == card.approvalId }
        open.append(card)
        unbind()
    }

    /// The card was settled, on screen, by voice or by the runner.
    public mutating func resolved(_ approvalId: String) {
        open.removeAll { $0.approvalId == approvalId }
        if heard?.approvalId == approvalId { unbind() }
    }

    /// The card's reading finished playing at `time`. It's what an answer
    /// goes to only if it's still the newest card open, exactly as it was read.
    public mutating func readOut(_ card: ApprovalRequest, at time: Double) {
        guard Self.reading(of: card) != nil, open.last == card else { return }
        heard = card
        heardAt = time
    }

    public mutating func clear() {
        open = []
        unbind()
    }

    private mutating func unbind() {
        heard = nil
        heardAt = .infinity
    }

    /// What `said` does. `spokenAt` is when he started saying it, and
    /// `quietSince` when the app last stopped talking (infinity while it's
    /// talking); an unknown time is -infinity, which never answers.
    public mutating func take(_ said: String, spokenAt: Double, quietSince: Double) -> Outcome {
        guard let newest = open.last else { return .message }
        if let card = heard, card == newest, spokenAt >= heardAt, spokenAt >= quietSince,
           let decision = SpokenAnswer.decision(said, options: card.options) {
            open.removeLast()
            unbind()
            return .answer(card, decision)
        }
        // Any answer at all, to any card: not sent as a message ("yes" in
        // the thread would decline the card), and not guessed at.
        guard SpokenAnswer.decision(said, options: [.allow, .allowAlways, .deny]) != nil else { return .message }
        guard Self.reading(of: newest) != nil else { return .onScreen(newest) }
        // It'll be read again, and only that reading can take an answer.
        unbind()
        return .readAgain(newest)
    }
}
