import Foundation
import os

let protocolLog = Logger(subsystem: "com.mikerosoft.threadbear", category: "protocol")

public enum ToolKind: String, Sendable, Hashable, Codable {
    /// `image` is image generation (Codex). A kind this app doesn't know
    /// reads as `other`.
    case command, read, edit, write, search, web, mcp, task, todo, image, other

    public init(from decoder: Decoder) throws {
        let raw = try decoder.singleValueContainer().decode(String.self)
        self = ToolKind(rawValue: raw) ?? .other
    }
}

public struct ToolCall: Sendable, Hashable, Decodable {
    public var itemId: String
    public var name: String
    public var kind: ToolKind
    public var title: String
    public var input: JSONValue

    public init(itemId: String, name: String, kind: ToolKind, title: String, input: JSONValue = .object([:])) {
        self.itemId = itemId
        self.name = name
        self.kind = kind
        self.title = title
        self.input = input
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        itemId = (try? c.decodeIfPresent(String.self, forKey: .itemId)) ?? ""
        name = (try? c.decodeIfPresent(String.self, forKey: .name)) ?? "Tool"
        kind = (try? c.decodeIfPresent(ToolKind.self, forKey: .kind)) ?? .other
        title = (try? c.decodeIfPresent(String.self, forKey: .title)) ?? name
        input = (try? c.decodeIfPresent(JSONValue.self, forKey: .input)) ?? .object([:])
    }

    enum CodingKeys: String, CodingKey { case itemId, name, kind, title, input }
}

public struct ToolResult: Sendable, Hashable, Decodable {
    public var itemId: String
    public var ok: Bool
    public var text: String
    public var truncated: Bool
    public var blobPath: String?
    public var images: [ImageRef]
    /// Another runner's thread through Convex: the output is on that runner, and
    /// opening the tool asks for it by this row's seq (`threads.heldBody`).
    public var heldBackSeq: Int?

    public init(itemId: String, ok: Bool, text: String, truncated: Bool = false, blobPath: String? = nil, images: [ImageRef] = [], heldBackSeq: Int? = nil) {
        self.itemId = itemId
        self.ok = ok
        self.text = text
        self.truncated = truncated
        self.blobPath = blobPath
        self.images = images
        self.heldBackSeq = heldBackSeq
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        itemId = (try? c.decodeIfPresent(String.self, forKey: .itemId)) ?? ""
        ok = (try? c.decodeIfPresent(Bool.self, forKey: .ok)) ?? true
        text = (try? c.decodeIfPresent(String.self, forKey: .text)) ?? ""
        truncated = (try? c.decodeIfPresent(Bool.self, forKey: .truncated)) ?? false
        blobPath = try? c.decodeIfPresent(String.self, forKey: .blobPath)
        images = c.lossyArray(ImageRef.self, forKey: .images)
        heldBackSeq = (try? c.decodeIfPresent(HeldBack.self, forKey: .heldBack))?.seq
    }

    private struct HeldBack: Decodable { let seq: Int }

    enum CodingKeys: String, CodingKey { case itemId, ok, text, truncated, blobPath, images, heldBack }
}

public struct DiffHunk: Sendable, Hashable, Codable {
    public var oldStart: Int
    public var oldLines: Int
    public var newStart: Int
    public var newLines: Int
    public var lines: [String]

    public init(oldStart: Int, oldLines: Int, newStart: Int, newLines: Int, lines: [String]) {
        self.oldStart = oldStart
        self.oldLines = oldLines
        self.newStart = newStart
        self.newLines = newLines
        self.lines = lines
    }

    /// Missing counts default to what the lines say, so a hunk the runner
    /// sends in a slightly different shape still draws.
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        lines = c.lossyArray(String.self, forKey: .lines)
        oldStart = c.lenientInt(forKey: .oldStart) ?? 1
        newStart = c.lenientInt(forKey: .newStart) ?? oldStart
        oldLines = c.lenientInt(forKey: .oldLines) ?? lines.filter { !$0.hasPrefix("+") }.count
        newLines = c.lenientInt(forKey: .newLines) ?? lines.filter { !$0.hasPrefix("-") }.count
    }

    enum CodingKeys: String, CodingKey { case oldStart, oldLines, newStart, newLines, lines }
}

public struct EditDiff: Sendable, Hashable, Decodable {
    public var itemId: String
    public var path: String
    public var hunks: [DiffHunk]

    public init(itemId: String, path: String, hunks: [DiffHunk]) {
        self.itemId = itemId
        self.path = path
        self.hunks = hunks
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        itemId = (try? c.decodeIfPresent(String.self, forKey: .itemId)) ?? ""
        path = (try? c.decodeIfPresent(String.self, forKey: .path)) ?? ""
        hunks = c.lossyArray(DiffHunk.self, forKey: .hunks)
    }

    enum CodingKeys: String, CodingKey { case itemId, path, hunks }
}

public enum ApprovalOption: String, Sendable, Hashable, Codable {
    case allow, allowAlways, deny
}

public struct ApprovalRequest: Sendable, Hashable, Decodable {
    public var approvalId: String
    public var itemId: String?
    public var name: String
    public var title: String
    public var input: JSONValue
    public var options: [ApprovalOption]

    public init(approvalId: String, itemId: String? = nil, name: String, title: String, input: JSONValue = .object([:]), options: [ApprovalOption] = [.allow, .allowAlways, .deny]) {
        self.approvalId = approvalId
        self.itemId = itemId
        self.name = name
        self.title = title
        self.input = input
        self.options = options
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        approvalId = (try? c.decodeIfPresent(String.self, forKey: .approvalId)) ?? ""
        itemId = try? c.decodeIfPresent(String.self, forKey: .itemId)
        name = (try? c.decodeIfPresent(String.self, forKey: .name)) ?? "Tool"
        title = (try? c.decodeIfPresent(String.self, forKey: .title)) ?? name
        input = (try? c.decodeIfPresent(JSONValue.self, forKey: .input)) ?? .object([:])
        // Unknown option strings are dropped rather than failing the event.
        let raw = (try? c.decodeIfPresent(LossyArray<String>.self, forKey: .options))??.elements ?? ["allow", "deny"]
        options = raw.compactMap(ApprovalOption.init(rawValue:))
    }

    enum CodingKeys: String, CodingKey { case approvalId, itemId, name, title, input, options }
}

public struct QuestionOption: Sendable, Hashable, Codable {
    public var label: String
    public var description: String?

    public init(label: String, description: String? = nil) {
        self.label = label
        self.description = description
    }

    public init(from decoder: Decoder) throws {
        // A bare string is taken as the label.
        if let bare = try? decoder.singleValueContainer().decode(String.self) {
            label = bare
            description = nil
        } else {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            label = (try? c.decodeIfPresent(String.self, forKey: .label)) ?? (try? c.decodeIfPresent(String.self, forKey: .value)) ?? ""
            description = try? c.decodeIfPresent(String.self, forKey: .description)
        }
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(label, forKey: .label)
        try c.encodeIfPresent(description, forKey: .description)
    }

    enum CodingKeys: String, CodingKey { case label, value, description }
}

public struct Question: Sendable, Hashable, Decodable {
    public var question: String
    public var header: String?
    public var multiSelect: Bool
    public var options: [QuestionOption]

    public init(question: String, header: String? = nil, multiSelect: Bool = false, options: [QuestionOption]) {
        self.question = question
        self.header = header
        self.multiSelect = multiSelect
        self.options = options
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        question = (try? c.decodeIfPresent(String.self, forKey: .question)) ?? ""
        header = try? c.decodeIfPresent(String.self, forKey: .header)
        multiSelect = (try? c.decodeIfPresent(Bool.self, forKey: .multiSelect)) ?? false
        options = c.lossyArray(QuestionOption.self, forKey: .options).filter { !$0.label.isEmpty }
    }

    enum CodingKeys: String, CodingKey { case question, header, multiSelect, options }
}

public struct QuestionRequest: Sendable, Hashable, Decodable {
    public var approvalId: String
    /// Absent for a background subagent's.
    public var itemId: String?
    public var questions: [Question]

    public init(approvalId: String, itemId: String? = nil, questions: [Question]) {
        self.approvalId = approvalId
        self.itemId = itemId
        self.questions = questions
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        approvalId = (try? c.decodeIfPresent(String.self, forKey: .approvalId)) ?? ""
        itemId = try? c.decodeIfPresent(String.self, forKey: .itemId)
        questions = c.lossyArray(Question.self, forKey: .questions)
    }

    enum CodingKeys: String, CodingKey { case approvalId, itemId, questions }
}

/// An agent's `ask_secret` (docs/protocol.md, "Secrets"): a card asking
/// Mike for a password, key or token. It's answered with `secrets.answer`,
/// never `approvals.respond`, and closed by `approval.resolved` like any
/// other approval. Nothing here, or in what the app keeps, is the value.
public struct SecretRequest: Sendable, Hashable, Decodable {
    public var approvalId: String
    /// The `ask_secret` tool call's, when the runner knows it.
    public var itemId: String?
    /// The card's title: "Mac administrator password".
    public var label: String
    /// What it's for and where to find it.
    public var reason: String
    public var placeholder: String?

    public init(approvalId: String, itemId: String? = nil, label: String, reason: String = "", placeholder: String? = nil) {
        self.approvalId = approvalId
        self.itemId = itemId
        self.label = label
        self.reason = reason
        self.placeholder = placeholder
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        approvalId = (try? c.decodeIfPresent(String.self, forKey: .approvalId)) ?? ""
        itemId = (try? c.decodeIfPresent(String.self, forKey: .itemId)).flatMap { $0?.isEmpty == false ? $0 : nil }
        let label = ((try? c.decodeIfPresent(String.self, forKey: .label)) ?? nil)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        self.label = label.isEmpty ? "A secret" : label
        reason = ((try? c.decodeIfPresent(String.self, forKey: .reason)) ?? nil)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        let placeholder = ((try? c.decodeIfPresent(String.self, forKey: .placeholder)) ?? nil)?.trimmingCharacters(in: .whitespacesAndNewlines)
        self.placeholder = placeholder?.isEmpty == false ? placeholder : nil
    }

    enum CodingKeys: String, CodingKey { case approvalId, itemId, label, reason, placeholder }
}

public enum ApprovalDecision: String, Sendable, Hashable, Codable {
    case allow, allowAlways, deny, answered, expired

    public init(from decoder: Decoder) throws {
        let raw = try decoder.singleValueContainer().decode(String.self)
        self = ApprovalDecision(rawValue: raw) ?? .expired
    }
}

public struct ApprovalResolution: Sendable, Hashable, Decodable {
    public var approvalId: String
    public var decision: ApprovalDecision
    public var message: String?

    public init(approvalId: String, decision: ApprovalDecision, message: String? = nil) {
        self.approvalId = approvalId
        self.decision = decision
        self.message = message
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        approvalId = (try? c.decodeIfPresent(String.self, forKey: .approvalId)) ?? ""
        decision = (try? c.decodeIfPresent(ApprovalDecision.self, forKey: .decision)) ?? .expired
        message = try? c.decodeIfPresent(String.self, forKey: .message)
    }

    enum CodingKeys: String, CodingKey { case approvalId, decision, message }
}

public enum PlanStatus: String, Sendable, Hashable, Codable {
    case pending, in_progress, completed

    public init(from decoder: Decoder) throws {
        let raw = try decoder.singleValueContainer().decode(String.self)
        self = PlanStatus(rawValue: raw) ?? .pending
    }
}

public struct PlanEntry: Sendable, Hashable, Codable {
    public var text: String
    public var status: PlanStatus

    public init(text: String, status: PlanStatus) {
        self.text = text
        self.status = status
    }

    /// Claude's TodoWrite calls the text `content`; either is accepted.
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        text = (try? c.decodeIfPresent(String.self, forKey: .text)) ?? (try? c.decodeIfPresent(String.self, forKey: .content)) ?? ""
        status = (try? c.decodeIfPresent(PlanStatus.self, forKey: .status)) ?? .pending
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(text, forKey: .text)
        try c.encode(status, forKey: .status)
    }

    enum CodingKeys: String, CodingKey { case text, content, status }
}

public enum TurnOutcome: String, Sendable, Hashable, Codable {
    case completed, interrupted, failed

    public init(from decoder: Decoder) throws {
        let raw = try decoder.singleValueContainer().decode(String.self)
        self = TurnOutcome(rawValue: raw) ?? .completed
    }
}

/// Why a failed turn failed, when the runner knows, so the app can offer
/// the fix without reading the message.
public enum TurnErrorKind: String, Sendable, Hashable, Codable {
    /// `network`: the API couldn't be reached (the internet went); the
    /// runner carries the turn on by itself once it can.
    case usageLimit, contextWindow, auth, network
}

public struct TurnCompletion: Sendable, Hashable, Decodable {
    public var turnId: String
    public var outcome: TurnOutcome
    public var durationMs: Double
    /// Nil for Codex turns, which report no cost.
    public var costUsd: Double?
    /// Token counts by name. Claude: inputTokens, outputTokens,
    /// cacheReadTokens, cacheWriteTokens. Codex: inputTokens,
    /// cachedInputTokens, cacheWriteTokens, outputTokens, reasoningTokens.
    public var usage: JSONValue?
    public var error: String?
    /// Nil when unknown, including a kind this app doesn't know yet.
    public var errorKind: TurnErrorKind?
    /// What the turn said it needs from Mike: "you" (with `asks`),
    /// "nothing", or nil when it said neither.
    public var needs: String?
    public var asks: [Ask]
    /// With needs "nothing": follow-ups the agent suggested, each the
    /// message that would start it, as buttons on the done card.
    public var next: [String]

    public init(
        turnId: String, outcome: TurnOutcome, durationMs: Double, costUsd: Double? = nil, usage: JSONValue? = nil, error: String? = nil,
        errorKind: TurnErrorKind? = nil, needs: String? = nil, asks: [Ask] = [], next: [String] = []
    ) {
        self.needs = needs
        self.asks = asks
        self.next = next
        self.turnId = turnId
        self.outcome = outcome
        self.durationMs = durationMs
        self.costUsd = costUsd
        self.usage = usage
        self.error = error
        self.errorKind = errorKind
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        turnId = (try? c.decodeIfPresent(String.self, forKey: .turnId)) ?? ""
        outcome = (try? c.decodeIfPresent(TurnOutcome.self, forKey: .outcome)) ?? .completed
        durationMs = (try? c.decodeIfPresent(Double.self, forKey: .durationMs)) ?? 0
        costUsd = try? c.decodeIfPresent(Double.self, forKey: .costUsd)
        usage = try? c.decodeIfPresent(JSONValue.self, forKey: .usage)
        errorKind = ((try? c.decodeIfPresent(String.self, forKey: .errorKind)) ?? nil).flatMap(TurnErrorKind.init(rawValue:))
        needs = (try? c.decodeIfPresent(String.self, forKey: .needs)) ?? nil
        asks = c.lossyArray(Ask.self, forKey: .asks)
        next = c.lossyArray(String.self, forKey: .next)
        // `error` may be a string or an object depending on the runner version.
        if let text = try? c.decodeIfPresent(String.self, forKey: .error) {
            error = text
        } else if let value = try? c.decodeIfPresent(JSONValue.self, forKey: .error) {
            error = value["message"]?.stringValue ?? value.compactText
        } else {
            error = nil
        }
    }

    enum CodingKeys: String, CodingKey { case turnId, outcome, durationMs, costUsd, usage, error, errorKind, needs, asks, next }
}

/// A command action that ran (`action.run`): what it printed, outside any
/// turn. Shown as a tool row.
public struct ActionRun: Sendable, Hashable, Decodable {
    public var actionId: String
    public var patch: String
    public var title: String
    public var command: String
    public var ok: Bool
    public var exitCode: Int?
    public var text: String
    public var truncated: Bool
    public var durationMs: Double
    /// "turn.end" when a hook ran it; nil for a chip or tb.
    public var trigger: String?

    public init(actionId: String, patch: String = "", title: String, command: String = "", ok: Bool = true, exitCode: Int? = nil, text: String = "", truncated: Bool = false, durationMs: Double = 0, trigger: String? = nil) {
        self.actionId = actionId
        self.patch = patch
        self.title = title
        self.command = command
        self.ok = ok
        self.exitCode = exitCode
        self.text = text
        self.truncated = truncated
        self.durationMs = durationMs
        self.trigger = trigger
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        actionId = (try? c.decodeIfPresent(String.self, forKey: .actionId)) ?? ""
        patch = (try? c.decodeIfPresent(String.self, forKey: .patch)) ?? ""
        title = (try? c.decodeIfPresent(String.self, forKey: .title)) ?? actionId
        command = (try? c.decodeIfPresent(String.self, forKey: .command)) ?? ""
        ok = (try? c.decodeIfPresent(Bool.self, forKey: .ok)) ?? true
        exitCode = c.lenientInt(forKey: .exitCode)
        text = (try? c.decodeIfPresent(String.self, forKey: .text)) ?? ""
        truncated = (try? c.decodeIfPresent(Bool.self, forKey: .truncated)) ?? false
        durationMs = (try? c.decodeIfPresent(Double.self, forKey: .durationMs)) ?? 0
        trigger = try? c.decodeIfPresent(String.self, forKey: .trigger)
    }

    enum CodingKeys: String, CodingKey { case actionId, patch, title, command, ok, exitCode, text, truncated, durationMs, trigger }

    /// The row's item id: one per run.
    public func itemId(seq: Int) -> String { "action:\(seq)" }

    /// The run as the tool call and result the transcript draws.
    public var asToolCall: (ToolCall, ToolResult) {
        var title = ok ? self.title : "\(self.title) failed" + (exitCode.map { " (exit \($0))" } ?? "")
        // A hook's run says when it ran, as the design's patch line does.
        if trigger == "turn.end" { title += " · after the turn" }
        let call = ToolCall(itemId: "", name: "action", kind: .command, title: title,
                            input: .object(["command": .string(command), "patch": .string(patch), "actionId": .string(actionId)]))
        return (call, ToolResult(itemId: "", ok: ok, text: text, truncated: truncated))
    }
}

public enum EventPayload: Sendable, Hashable {
    /// `origin` is "runner" for a message the runner sent by itself (the
    /// resume after a restart); nil for anything a person or client sent.
    /// `editOf` is the seq of the message this one replaced (Editing a
    /// message). `review` is Mike's answer to a review, when the runner
    /// sent it for one.
    case userMessage(text: String, images: [ImageRef], origin: String? = nil, answers: [AskAnswer] = [], editOf: Int? = nil, review: ReviewAnswer? = nil)
    /// `summary`: the turn's summary, written by the runner from end_turn
    /// (docs/protocol.md, "The summary").
    /// `givesWay`: on a summary, with bullet replies off: any message of the
    /// turn is the reply over it, however short.
    /// `final`: one reply's reply, the agent's message after end_turn (docs/
    /// protocol.md, "One reply"): the turn's reply whatever else it wrote.
    case assistantText(itemId: String, text: String, summary: Bool = false, narration: Bool = false, givesWay: Bool = false, final: Bool = false)
    case reasoning(itemId: String, text: String)
    case toolCall(ToolCall)
    case toolResult(ToolResult)
    case editDiff(EditDiff)
    case approvalRequested(ApprovalRequest)
    case questionRequested(QuestionRequest)
    case secretRequested(SecretRequest)
    case reviewUpdated(DesignReview)
    /// A reply button made, pressed or failed (docs/protocol.md, "Reply
    /// buttons"): the whole button each time.
    case buttonUpdated(ReplyButton)
    case approvalResolved(ApprovalResolution)
    case planUpdated([PlanEntry])
    /// "Plan first": the agent's plan, waiting for Mike, and what became of
    /// it (`go` approved, `revise` sent back).
    case planProposed(itemId: String, text: String)
    case planResolved(itemId: String, go: Bool)
    /// `wokeBy`: what finished and started a turn the agent began by itself.
    case turnStarted(wokeBy: [BackgroundTask] = [])
    case turnCompleted(TurnCompletion)
    case systemNote(String)
    case error(String)
    case actionRun(ActionRun)
    /// The ticks on the card of asks that came with the turn.completed at
    /// `asksSeq`: the whole set each time.
    case asksTicked(asksSeq: Int, ticked: [Int])
    /// Mike edited the message at `fromSeq`: every event from there to
    /// `toSeq` is gone from the conversation (docs/protocol.md, "Editing a
    /// message").
    case threadRewound(ThreadRewind)
    case assistantTextDelta(itemId: String, text: String)
    case reasoningDelta(itemId: String, text: String)
    case toolOutputDelta(itemId: String, text: String)
    /// Everything streamed so far for an item, from a subscribe reply's
    /// `inProgress`. Replaces the row's streaming text (deltas append). Made
    /// by the app, never sent by the runner as an event.
    case streamingText(itemId: String, isReasoning: Bool, text: String)
    /// An event type this app doesn't know yet. Ignored by the reducer.
    case unknown
}

public struct Event: Sendable, Hashable, Decodable {
    public var seq: Int
    public var ts: String
    public var threadId: String
    public var turnId: String?
    public var type: String
    public var payload: EventPayload

    public init(seq: Int, ts: String = "", threadId: String, turnId: String? = nil, type: String, payload: EventPayload) {
        self.seq = seq
        self.ts = ts
        self.threadId = threadId
        self.turnId = turnId
        self.type = type
        self.payload = payload
    }

    static let transientTypes: Set<String> = ["assistant.text.delta", "reasoning.delta", "tool.output.delta"]

    /// Transient events stream between persisted ones and never consume a seq.
    /// Judged by type too, so a delta that couldn't be read stays transient.
    public var isTransient: Bool {
        switch payload {
        case .assistantTextDelta, .reasoningDelta, .toolOutputDelta, .streamingText: return true
        default: return Event.transientTypes.contains(type)
        }
    }

    private struct TextFields: Decodable {
        var itemId: String?
        var text: String?
        var images: [ImageRef]
        var message: String?
        var origin: String?
        var answers: [AskAnswer]
        var editOf: Int?
        var reviewId: String?
        var reviewResponse: ReviewDraft?
        var summary = false
        var narration = false
        var givesWay = false
        var final = false

        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            itemId = try? c.decodeIfPresent(String.self, forKey: .itemId)
            text = try? c.decodeIfPresent(String.self, forKey: .text)
            images = c.lossyArray(ImageRef.self, forKey: .images)
            message = try? c.decodeIfPresent(String.self, forKey: .message)
            origin = try? c.decodeIfPresent(String.self, forKey: .origin)
            answers = c.lossyArray(AskAnswer.self, forKey: .answers)
            editOf = c.lenientInt(forKey: .editOf)
            reviewId = try? c.decodeIfPresent(String.self, forKey: .reviewId)
            reviewResponse = try? c.decodeIfPresent(ReviewDraft.self, forKey: .reviewResponse)
            summary = (try? c.decodeIfPresent(Bool.self, forKey: .summary)) == true
            narration = (try? c.decodeIfPresent(Bool.self, forKey: .narration)) == true
            givesWay = (try? c.decodeIfPresent(Bool.self, forKey: .givesWay)) == true
            final = (try? c.decodeIfPresent(Bool.self, forKey: .final)) == true
        }

        enum CodingKeys: String, CodingKey { case itemId, text, images, message, origin, answers, editOf, reviewId, reviewResponse, summary, narration, givesWay, final }
    }

    private struct PlanCardFields: Decodable {
        var itemId: String
        var text: String?
        var decision: String?
    }

    private struct PlanFields: Decodable {
        var entries: [PlanEntry]

        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            entries = c.lossyArray(PlanEntry.self, forKey: .entries)
        }

        enum CodingKeys: String, CodingKey { case entries }
    }

    enum CodingKeys: String, CodingKey { case seq, ts, threadId, turnId, type }

    /// Never fails for an object. A payload this app can't read becomes
    /// `.unknown` but keeps its seq: dropping the event would leave a hole
    /// in the seq order, and the feed would ask for it again forever.
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        seq = c.lenientInt(forKey: .seq) ?? 0
        ts = (try? c.decodeIfPresent(String.self, forKey: .ts)) ?? ""
        threadId = (try? c.decodeIfPresent(String.self, forKey: .threadId)) ?? ""
        turnId = try? c.decodeIfPresent(String.self, forKey: .turnId)
        type = (try? c.decodeIfPresent(String.self, forKey: .type)) ?? ""
        do {
            payload = try Event.decodePayload(type: type, decoder: decoder)
        } catch {
            payload = .unknown
            let (type, seq, reason) = (type, seq, String(describing: error))
            protocolLog.error("Couldn't read a \(type, privacy: .public) event (seq \(seq)): \(reason, privacy: .public)")
        }
    }

    private static func decodePayload(type: String, decoder: Decoder) throws -> EventPayload {
        func text() throws -> TextFields { try TextFields(from: decoder) }
        switch type {
        case "user.message":
            let fields = try text()
            let text = fields.text ?? ""
            return .userMessage(text: text, images: fields.images, origin: fields.origin, answers: fields.answers, editOf: fields.editOf,
                                review: ReviewAnswer.parse(text, reviewId: fields.reviewId, response: fields.reviewResponse))
        case "assistant.text":
            let fields = try text()
            return .assistantText(itemId: fields.itemId ?? "", text: fields.text ?? "", summary: fields.summary, narration: fields.narration, givesWay: fields.givesWay, final: fields.final)
        case "reasoning":
            let fields = try text()
            return .reasoning(itemId: fields.itemId ?? "", text: fields.text ?? "")
        case "tool.call":
            return .toolCall(try ToolCall(from: decoder))
        case "tool.result":
            return .toolResult(try ToolResult(from: decoder))
        case "edit.diff":
            return .editDiff(try EditDiff(from: decoder))
        case "approval.requested":
            return .approvalRequested(try ApprovalRequest(from: decoder))
        case "question.requested":
            return .questionRequested(try QuestionRequest(from: decoder))
        case "secret.requested":
            return .secretRequested(try SecretRequest(from: decoder))
        case "review.updated":
            let c = try decoder.container(keyedBy: ReviewFields.self)
            return .reviewUpdated(try c.decode(DesignReview.self, forKey: .review))
        case "button.updated":
            let c = try decoder.container(keyedBy: ButtonFields.self)
            return .buttonUpdated(try c.decode(ReplyButton.self, forKey: .button))
        case "approval.resolved":
            return .approvalResolved(try ApprovalResolution(from: decoder))
        case "plan.updated":
            return .planUpdated(try PlanFields(from: decoder).entries)
        case "plan.proposed":
            let fields = try PlanCardFields(from: decoder)
            return .planProposed(itemId: fields.itemId, text: fields.text ?? "")
        case "plan.resolved":
            let fields = try PlanCardFields(from: decoder)
            return .planResolved(itemId: fields.itemId, go: fields.decision == "go")
        case "turn.started":
            let c = try decoder.container(keyedBy: TurnStartedFields.self)
            return .turnStarted(wokeBy: (try? c.decodeIfPresent([BackgroundTask].self, forKey: .wokeBy)) ?? [])
        case "turn.completed":
            return .turnCompleted(try TurnCompletion(from: decoder))
        case "system.note":
            return .systemNote(try text().text ?? "")
        case "error":
            let fields = try text()
            return .error(fields.message ?? fields.text ?? "Something went wrong")
        case "action.run":
            return .actionRun(try ActionRun(from: decoder))
        case "thread.rewound":
            return .threadRewound(try ThreadRewind(from: decoder))
        case "asks.ticked":
            let fields = try AsksTickedFields(from: decoder)
            return .asksTicked(asksSeq: fields.asksSeq, ticked: fields.ticked ?? [])
        case "assistant.text.delta":
            let fields = try text()
            return .assistantTextDelta(itemId: fields.itemId ?? "", text: fields.text ?? "")
        case "reasoning.delta":
            let fields = try text()
            return .reasoningDelta(itemId: fields.itemId ?? "", text: fields.text ?? "")
        case "tool.output.delta":
            let fields = try text()
            return .toolOutputDelta(itemId: fields.itemId ?? "", text: fields.text ?? "")
        default:
            return .unknown
        }
    }

    private enum ReviewFields: String, CodingKey { case review }
    private enum ButtonFields: String, CodingKey { case button }
    private enum TurnStartedFields: String, CodingKey { case wokeBy }
}

/// Result of `threads.events`.
public struct EventsPage: Sendable, Decodable {
    public struct InProgress: Sendable, Hashable, Decodable {
        public var itemId: String
        public var type: String
        public var text: String

        public init(itemId: String, type: String, text: String) {
            self.itemId = itemId
            self.type = type
            self.text = text
        }
    }

    public var events: [Event]
    public var firstSeq: Int
    public var lastSeq: Int
    public var inProgress: [InProgress]
    /// Nothing comes before this page (`relay.atStart`, another runner's
    /// thread through Convex).
    public var atStart = false

    public init(events: [Event], firstSeq: Int, lastSeq: Int, inProgress: [InProgress] = []) {
        self.events = events
        self.firstSeq = firstSeq
        self.lastSeq = lastSeq
        self.inProgress = inProgress
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        events = c.lossyArray(Event.self, forKey: .events)
        firstSeq = c.lenientInt(forKey: .firstSeq) ?? (events.first?.seq ?? 0)
        lastSeq = c.lenientInt(forKey: .lastSeq) ?? (events.last?.seq ?? 0)
        inProgress = c.lossyArray(InProgress.self, forKey: .inProgress)
        struct Relay: Decodable { var atStart: Bool? }
        atStart = (try? c.decodeIfPresent(Relay.self, forKey: .relay))??.atStart ?? false
    }

    enum CodingKeys: String, CodingKey { case events, firstSeq, lastSeq, inProgress, relay }
}

/// Decodes an array, skipping elements that fail to decode instead of failing
/// the whole array. One malformed event shouldn't hide a whole transcript.
public struct LossyArray<Element: Decodable>: Decodable, Sendable where Element: Sendable {
    public var elements: [Element]

    public init(from decoder: Decoder) throws {
        var container = try decoder.unkeyedContainer()
        var elements: [Element] = []
        if let count = container.count { elements.reserveCapacity(count) }
        while !container.isAtEnd {
            if let element = try? container.decode(Element.self) {
                elements.append(element)
            } else if (try? container.decode(JSONValue.self)) == nil {
                break
            }
        }
        self.elements = elements
    }
}

extension KeyedDecodingContainer {
    /// An array where elements that don't decode are skipped, and a missing,
    /// null or non-array value is an empty array.
    func lossyArray<Element: Decodable & Sendable>(_ type: Element.Type, forKey key: Key) -> [Element] {
        ((try? decodeIfPresent(LossyArray<Element>.self, forKey: key)) ?? nil)?.elements ?? []
    }

    /// An integer sent as a whole number or a numeric string, within what
    /// JavaScript counts exactly (±2^53), as every number here comes from
    /// the runner or Convex. Past that it's nil: a seq of Int.max from
    /// another runner made `seq + 1` trap, as `Int(1e100)` would have.
    func lenientInt(forKey key: Key) -> Int? {
        let most = 9_007_199_254_740_991
        func held(_ value: Int?) -> Int? { value.flatMap { (-most...most).contains($0) ? $0 : nil } }
        if let value = try? decodeIfPresent(Int.self, forKey: key) { return held(value) }
        if let value = try? decodeIfPresent(Double.self, forKey: key) { return held(Int(checked: value)) }
        if let text = try? decodeIfPresent(String.self, forKey: key) { return held(Int(text)) }
        return nil
    }
}

/// A `thread.rewound` event: the range of seqs an edit cut, and what
/// happened to the files the agent had changed since.
public struct ThreadRewind: Sendable, Hashable, Decodable {
    public struct FailedFile: Sendable, Hashable, Decodable {
        public var path: String
        public var reason: String

        public init(path: String, reason: String) {
            self.path = path
            self.reason = reason
        }

        public init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            path = (try? c.decodeIfPresent(String.self, forKey: .path)) ?? ""
            reason = (try? c.decodeIfPresent(String.self, forKey: .reason)) ?? ""
        }

        enum CodingKeys: String, CodingKey { case path, reason }
    }

    public var fromSeq: Int
    public var toSeq: Int
    /// Files put back as they were.
    public var undone: [String]
    public var failed: [FailedFile]
    /// "checkpoint", "diffs" or "none".
    public var how: String

    public init(fromSeq: Int, toSeq: Int, undone: [String] = [], failed: [FailedFile] = [], how: String = "none") {
        self.fromSeq = fromSeq
        self.toSeq = toSeq
        self.undone = undone
        self.failed = failed
        self.how = how
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        fromSeq = c.lenientInt(forKey: .fromSeq) ?? 0
        toSeq = c.lenientInt(forKey: .toSeq) ?? 0
        let files = try? c.nestedContainer(keyedBy: FileKeys.self, forKey: .files)
        undone = files?.lossyArray(String.self, forKey: .undone) ?? []
        failed = files?.lossyArray(FailedFile.self, forKey: .failed) ?? []
        how = (try? files?.decodeIfPresent(String.self, forKey: .how)) ?? "none"
    }

    /// The seqs it hides; empty for a range that makes no sense.
    public var range: ClosedRange<Int>? { fromSeq > 0 && toSeq >= fromSeq ? fromSeq...toSeq : nil }

    enum CodingKeys: String, CodingKey { case fromSeq, toSeq, files }
    enum FileKeys: String, CodingKey { case undone, failed, how }
}

private struct AsksTickedFields: Decodable {
    var asksSeq: Int
    var ticked: [Int]?
}

extension ThreadRewind {
    /// The quiet line where the cut was: that a message was edited, and
    /// what happened to the files.
    public var summary: String {
        var parts = ["Edited a message, so the thread carries on from there."]
        if !undone.isEmpty {
            parts.append("Undid changes to \(undone.count == 1 ? "1 file" : "\(undone.count) files").")
        }
        if !failed.isEmpty {
            let named = failed.prefix(3).map { file in
                let name = (file.path as NSString).lastPathComponent
                return file.reason.isEmpty ? name : "\(name) (\(file.reason))"
            }
            let more = failed.count > 3 ? " and \(failed.count - 3) more" : ""
            parts.append("Couldn't undo \(named.joined(separator: ", "))\(more).")
        }
        return parts.joined(separator: " ")
    }
}
