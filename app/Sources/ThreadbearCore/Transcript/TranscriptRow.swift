import Foundation

/// One row in the transcript table.
public struct TranscriptRow: Sendable, Hashable, Identifiable {
    public let id: String
    /// Bumped every time the content changes, so caches keyed by (id, version)
    /// know when to re-render or re-measure.
    public var version: Int
    /// Seq of the event that created the row.
    public var seq: Int
    public var turnId: String?
    public var content: RowContent
    /// Shown inside an open work group (indented under its summary line).
    /// Set on display rows only; the same item renders differently there.
    public var inGroup: Bool

    public init(id: String, version: Int = 0, seq: Int, turnId: String? = nil, content: RowContent, inGroup: Bool = false) {
        self.id = id
        self.version = version
        self.seq = seq
        self.turnId = turnId
        self.content = content
        self.inGroup = inGroup
    }

    public var kind: RowKind { content.kind }
}

public enum RowKind: String, Sendable, Hashable, CaseIterable {
    case user, assistant, reasoning, tool, diff, images, approval, question, review, plan, footer, note, error
    /// An agent's `ask_secret` card (docs/protocol.md, "Secrets").
    case secret
    /// What a finished turn needs Mike to do, as a checklist.
    case asks
    /// Rows the model derives rather than reads from events: a folded run
    /// of work, the "Working for 12s" line, the "3 sub-agents working in
    /// the background" line, and the "Edited 3 files" card.
    case group, working, background, changes
    /// The time between a turn and the one the agent started by itself after it.
    case gap
    /// "Plan first": the agent's plan, to approve or send back, which then
    /// turns into its checklist.
    case planCard
}

public struct TextItem: Sendable, Hashable {
    public var itemId: String
    public var text: String
    /// Still receiving deltas.
    public var isStreaming: Bool
    /// The turn's summary from end_turn: the turn's reply, while its other
    /// messages fold into the work.
    public var isSummary: Bool
    /// A summary written with bullet replies off: any message of the turn
    /// is the reply over it, however short.
    public var givesWay: Bool
    /// Claude sent it as a narration block: its text is only the API's
    /// paraphrase of what the agent wrote, not the words.
    public var isNarration: Bool

    /// One reply's reply (`final` on its event): the turn's reply, whatever
    /// else the turn wrote (TranscriptReducer.reply(of:)).
    public var isFinal: Bool

    public init(itemId: String, text: String, isStreaming: Bool = false, isSummary: Bool = false, givesWay: Bool = false, isNarration: Bool = false, isFinal: Bool = false) {
        self.itemId = itemId
        self.text = text
        self.isStreaming = isStreaming
        self.isSummary = isSummary
        self.givesWay = givesWay
        self.isFinal = isFinal
        self.isNarration = isNarration
    }
}

public struct UserMessage: Sendable, Hashable {
    public var text: String
    public var images: [ImageRef]
    /// "runner" when the runner sent it by itself (the resume after a
    /// restart), "schedule" when a schedule did, nil when a person or a
    /// client did.
    public var origin: String?
    /// The asks it answered from the card (docs/protocol.md, "Needs you"):
    /// the bubble shows each question small and the answer as his words.
    public var answers: [AskAnswer]
    /// His answer to a review (Mike, 29 Oct): the bubble shows the pick
    /// and notes the same way, not the message the agent got.
    public var review: ReviewAnswer?
    /// The seq of the message this one replaced, when Mike edited one.
    public var editOf: Int?
    /// Mike can edit it and carry on from there (docs/protocol.md, "Editing
    /// a message"). Set by the reducer, which knows whether it started its
    /// own turn.
    public var editable: Bool
    /// Sent from this app and not shown by the runner yet
    /// (`PendingMessage`): drawn dimmed, with a spinner while it's on its
    /// way and a clock once the runner has queued it.
    public var pending: Pending?

    public enum Pending: Sendable, Hashable {
        case sending, queued
    }

    public init(text: String, images: [ImageRef] = [], origin: String? = nil, answers: [AskAnswer] = [], editOf: Int? = nil, review: ReviewAnswer? = nil, editable: Bool = false, pending: Pending? = nil) {
        self.text = text
        self.images = images
        self.origin = origin
        self.answers = answers
        self.review = review
        self.editOf = editOf
        self.editable = editable
        self.pending = pending
    }

    /// Mike wrote it, in the app or on the phone: not the runner, a
    /// schedule or an agent.
    public var isMike: Bool { (origin == nil || origin == "phone") && agentHeader == nil }

    /// Sent by the runner, not by Mike: shown as a quiet centred line, not
    /// a bubble of his own.
    public var isFromRunner: Bool { origin == "runner" }

    /// Sent by a schedule (docs/protocol.md, "Schedules"): also a note, with
    /// the schedule's name in place of the header line its text starts with.
    public var isFromSchedule: Bool { origin == "schedule" }

    /// Drawn as a centred note rather than Mike's bubble.
    public var showsAsNote: Bool { isFromRunner || isFromSchedule }

    /// The schedule's title and time from the message's first line, for
    /// one a schedule sent.
    public var scheduledHeader: ScheduledHeader? { isFromSchedule ? ScheduledHeader(text) : nil }

    /// Sent by another thread's agent (its `send_message` or
    /// `create_thread`), or by this thread's own agent as the `then` of a
    /// `move_thread`: drawn as a card, not Mike's bubble. The runner gives
    /// these no origin, so the header line is what says so.
    public var agentHeader: AgentHeader? { origin == nil ? AgentHeader(text) : nil }
}

/// The line the runner starts a message from another thread's agent with,
/// `[Sent by the agent in the thread "<title>" (<id8>)]`, or the `then` of
/// a thread's own move, `[Sent by the agent before moving to <folder>]`
/// (docs/protocol.md, "Threadbear tools").
public struct AgentHeader: Sendable, Hashable {
    /// The sending thread's title and id (its first 8 characters); empty
    /// for a move's `then`, which this thread's agent sent.
    public var title: String
    public var threadId: String
    /// For a move's `then`: the folder the thread moved to.
    public var movedTo: String?
    /// The message without the header line.
    public var body: String

    public init?(_ text: String) {
        let lines = text.split(separator: "\n", maxSplits: 1, omittingEmptySubsequences: false)
        guard let first = lines.first?.trimmingCharacters(in: .whitespaces) else { return nil }
        let thread = "[Sent by the agent in the thread \""
        let move = "[Sent by the agent before moving to "
        if first.hasPrefix(thread), first.hasSuffix(")]") {
            let inner = first.dropFirst(thread.count).dropLast(2)
            // The title may hold quotes and brackets; the id never holds `" (`.
            guard let split = inner.range(of: "\" (", options: .backwards) else { return nil }
            title = String(inner[..<split.lowerBound])
            threadId = String(inner[split.upperBound...])
        } else if first.hasPrefix(move), first.hasSuffix("]"), first.count > move.count + 1 {
            title = ""
            threadId = ""
            movedTo = String(first.dropFirst(move.count).dropLast())
        } else {
            return nil
        }
        body = lines.count > 1 ? String(lines[1]).trimmingCharacters(in: .newlines) : ""
    }
}

public struct ToolItem: Sendable, Hashable {
    public var itemId: String
    public var call: ToolCall?
    public var result: ToolResult?
    /// Live output from `tool.output.delta`, dropped once the result lands.
    public var liveOutput: String
    /// The runner's `edit.diff`s for this item, one per path, in the order
    /// the paths first came. A Codex patch can touch several files.
    public var diffs: [EditDiff]
    /// The thread's working folder, so a file row names its folder from
    /// there ("scripts", not "photo-sync/scripts").
    public var root: String?

    public init(itemId: String, call: ToolCall? = nil, result: ToolResult? = nil, liveOutput: String = "", diffs: [EditDiff] = [], root: String? = nil) {
        self.itemId = itemId
        self.call = call
        self.result = result
        self.liveOutput = liveOutput
        self.diffs = diffs
        self.root = root
    }

    /// Adds an `edit.diff`: one for a path already here replaces that
    /// path's diff (Codex sends a patch again as it changes), a new path
    /// adds one.
    public mutating func add(_ diff: EditDiff) {
        if let index = diffs.firstIndex(where: { $0.path == diff.path }) {
            diffs[index] = diff
        } else {
            diffs.append(diff)
        }
    }

    public var name: String { call?.name ?? "Tool" }
    public var title: String { call?.title ?? name }
    public var toolKind: ToolKind { call?.kind ?? .other }
    public var isFinished: Bool { result != nil }
    public var failed: Bool { result.map { !$0.ok } ?? false }

    /// The diffs to show: the runner's `edit.diff`s if it sent any,
    /// otherwise one built from the Edit/MultiEdit/Write input.
    public var effectiveDiffs: [EditDiff] {
        if !diffs.isEmpty { return diffs }
        guard let call, let built = DiffBuilder.diff(forTool: call) else { return [] }
        return [built]
    }

    /// The paths it changes, cheaply (no diff is built): the runner's
    /// diffs, else the input's file path, else Codex's `paths` list.
    public var editedPaths: [String] {
        if !diffs.isEmpty { return diffs.map(\.path) }
        let input = call?.input
        if let path = input?["file_path"]?.stringValue ?? input?["path"]?.stringValue { return [path] }
        return input?["paths"]?.arrayValue?.compactMap(\.stringValue) ?? []
    }
}

/// "Plan first" (docs/protocol.md): the plan the agent put to Mike. Waiting,
/// it offers Go ahead and Send back; approved, the steps it then works
/// through (plan.updated) show here as its checklist, the plan behind
/// "Show plan".
public struct PlanCard: Sendable, Hashable {
    public enum State: Sendable, Hashable { case waiting, approved, sentBack }
    public var itemId: String
    public var text: String
    public var state: State
    public var entries: [PlanEntry]

    public init(itemId: String, text: String, state: State = .waiting, entries: [PlanEntry] = []) {
        self.itemId = itemId
        self.text = text
        self.state = state
        self.entries = entries
    }
}

public struct ApprovalItem: Sendable, Hashable {
    public var request: ApprovalRequest
    public var resolution: ApprovalResolution?
    /// The thread's working folder, for the file's folder in the card.
    public var root: String?
    /// The tool call it asked about has a row of its own, which opens to
    /// the same command or file. Settled, this line then doesn't open:
    /// opened, "Allowed  Write release.sh" showed the file and the Write
    /// row right under it showed it again.
    public var toolShown: Bool
    /// Another runner asking for a thread: the request as it was filed,
    /// once this Mac's runner has read it (nil until then).
    public var startRequest: StartRequest?

    public init(request: ApprovalRequest, resolution: ApprovalResolution? = nil, root: String? = nil, toolShown: Bool = false, startRequest: StartRequest? = nil) {
        self.request = request
        self.resolution = resolution
        self.root = root
        self.toolShown = toolShown
        self.startRequest = startRequest
    }

    public var isStartRequest: Bool { request.name == StartRequest.cardName }

    /// It shows what it asked: always while it waits (a card then), and
    /// once settled only if its tool call has no row to show it.
    public var opens: Bool { resolution == nil || !toolShown }

    /// Mike let it happen: the request is now just a step of the work it
    /// allowed, so it folds into the run of work around it.
    public var isAllowed: Bool {
        resolution?.decision == .allow || resolution?.decision == .allowAlways
    }
}

public struct QuestionItem: Sendable, Hashable {
    public var request: QuestionRequest
    public var resolution: ApprovalResolution?

    public init(request: QuestionRequest, resolution: ApprovalResolution? = nil) {
        self.request = request
        self.resolution = resolution
    }
}

/// An agent asking for a secret, and how it ended. The value itself is
/// never in here: only the card's text from `secret.requested`.
public struct SecretItem: Sendable, Hashable {
    public var request: SecretRequest
    public var resolution: ApprovalResolution?

    public init(request: SecretRequest, resolution: ApprovalResolution? = nil) {
        self.request = request
        self.resolution = resolution
    }

    /// The settled card's one line: "Mac administrator password · Saved
    /// securely", "Declined", "Request ended".
    public var resolvedText: String? {
        guard let resolution else { return nil }
        switch resolution.decision {
        case .answered: return request.label + " · Saved securely"
        case .expired: return request.label + " · Request ended"
        default: return request.label + " · Declined"
        }
    }
}

public extension RowContent {
    /// The note a thread back from hibernating says so in. The runner words
    /// it (`wake` in runner/src/runner/hibernation.ts), and every way it says
    /// it starts like this. It's what Mike came to the thread to read, so it
    /// never folds into the work above it, and it gets the bear.
    var isWakeNote: Bool {
        if case .note(let text) = self { return text.hasPrefix("Woke up") }
        return false
    }
}

public enum RowContent: Sendable, Hashable {
    case user(UserMessage)
    case assistant(TextItem)
    case reasoning(TextItem)
    case tool(ToolItem)
    /// A tool's pictures, under its row. `generated` is an image the agent
    /// made (Codex's image generation), shown larger than a screenshot.
    case images(itemId: String, images: [ImageRef], generated: Bool = false)
    case approval(ApprovalItem)
    case question(QuestionItem)
    case secret(SecretItem)
    case review(DesignReview)
    case plan([PlanEntry])
    case planCard(PlanCard)
    case footer(TurnCompletion)
    /// The asks a finished turn left for Mike, under its footer.
    case asks(AsksCard)
    case note(String)
    /// A failed turn's message, and why it failed when the runner said
    /// (from the turn's `turn.completed`, which comes just after).
    case error(String, kind: TurnErrorKind? = nil)
    case group(WorkGroup)
    case working(WorkingStatus)
    case background(BackgroundStatus)
    case changes(ChangedFiles)
    /// "6 min later · Mine the repo finished" before a turn background work woke.
    case gap(TurnGap)

    public var kind: RowKind {
        switch self {
        case .user: return .user
        case .assistant: return .assistant
        case .reasoning: return .reasoning
        case .tool(let tool):
            if tool.call.map(DiffBuilder.isEditTool) == true || !tool.diffs.isEmpty { return .diff }
            return .tool
        case .images: return .images
        case .approval: return .approval
        case .question: return .question
        case .secret: return .secret
        case .review: return .review
        case .plan: return .plan
        case .planCard: return .planCard
        case .footer: return .footer
        case .asks: return .asks
        case .note: return .note
        case .error: return .error
        case .group: return .group
        case .working: return .working
        case .background: return .background
        case .changes: return .changes
        case .gap: return .gap
        }
    }
}

/// What Mike has put in an ask's own box (its Something else): his words
/// and any pictures he pasted or dropped there.
public struct AskNote: Sendable, Hashable {
    public var text: String
    public var images: [ImageRef]

    public init(text: String = "", images: [ImageRef] = []) {
        self.text = text
        self.images = images
    }

    public var isEmpty: Bool { text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && images.isEmpty }
}

/// A finished turn's asks (docs/protocol.md, "Needs you"). Only the card
/// of the thread's last finished turn is open: ticking it goes to the
/// runner, and its reply chips fill the composer. Older cards keep the
/// ticks they were left with.
public struct AsksCard: Sendable, Hashable {
    /// The seq of the turn.completed the asks came with.
    public var seq: Int
    public var asks: [Ask]
    public var ticked: Set<Int>
    public var isOpen: Bool
    /// The option picked on each ask (ask index to option index), waiting
    /// in the composer to be sent.
    public var picks: [Int: Int]
    /// The done card's follow-ups (end_turn's `next`): rows under
    /// "Or carry on" that Mike ticks, one or several, to go with his
    /// next message.
    public var next: [String]
    /// The follow-ups ticked, by index, waiting in the composer.
    public var pickedNext: Set<Int>
    /// The follow-ups whose "?" is on, by index: he'll ask what they mean
    /// with his next message, alongside any ticked ones.
    public var explainNext: Set<Int>
    /// What Mike has written and pasted in the boxes under the asks he
    /// picked Something else on, by ask index. The card makes room for
    /// each box from it; the box itself is a text view over that room.
    public var notes: [Int: AskNote]
    /// The done card's loose ends, as the runner checked them (protocol
    /// "Loose ends"): nil when it didn't, empty when nothing's left.
    public var looseEnds: [LooseEnd]?

    public init(seq: Int, asks: [Ask], ticked: Set<Int> = [], isOpen: Bool = true, picks: [Int: Int] = [:], next: [String] = [], notes: [Int: AskNote] = [:], pickedNext: Set<Int> = [], explainNext: Set<Int> = [], looseEnds: [LooseEnd]? = nil) {
        self.seq = seq
        self.looseEnds = looseEnds
        self.notes = notes
        self.pickedNext = pickedNext
        self.explainNext = explainNext
        self.asks = asks
        self.next = next
        self.ticked = ticked
        self.isOpen = isOpen
        self.picks = picks
    }

    public var tickedCount: Int { asks.indices.filter { ticked.contains($0) }.count }

    /// A turn that said it needs nothing gets a card too, with no asks:
    /// "Done" and an Archive button, where the raw end_turn call used to
    /// be all there was (Mike, 29 Oct), and any follow-ups the agent
    /// suggested (30 Oct). A turn that
    /// needs Mike only gets a card when it has asks, so no asks means this.
    public var isDone: Bool { asks.isEmpty }
}
