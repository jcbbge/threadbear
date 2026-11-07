import Foundation

/// A draft is saved separately from submission: closing a review must never
/// turn an unfinished choice or note into a message to the agent.
public struct ReviewDraft: Sendable, Hashable, Codable {
    /// Every option picked, in the review's order. Mike often wants two
    /// ("A + B's to-do list") or none of them (4 Nov).
    public var pickedIds: [String]
    public var notes: [String: String]
    /// His own words on the whole review.
    public var reply: String?
    /// None of them will do.
    public var none: Bool

    public init(pickedId: String? = nil, pickedIds: [String]? = nil, notes: [String: String] = [:], reply: String? = nil, none: Bool = false) {
        self.pickedIds = pickedIds ?? pickedId.map { [$0] } ?? []
        self.notes = notes
        self.reply = reply
        self.none = none
    }

    /// The first pick: all a runner from before several picks knows about.
    public var pickedId: String? {
        get { pickedIds.first }
        set { pickedIds = newValue.map { [$0] } ?? [] }
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let first = try c.decodeIfPresent(String.self, forKey: .pickedId)
        let all = (try? c.decodeIfPresent([String].self, forKey: .pickedIds)) ?? nil
        pickedIds = all ?? first.map { [$0] } ?? []
        notes = (try? c.decodeIfPresent([String: String].self, forKey: .notes)) ?? [:]
        reply = (try? c.decodeIfPresent(String.self, forKey: .reply)) ?? nil
        none = ((try? c.decodeIfPresent(Bool.self, forKey: .none)) ?? nil) ?? false
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encodeIfPresent(pickedId, forKey: .pickedId)
        if pickedIds.count > 1 { try c.encode(pickedIds, forKey: .pickedIds) }
        try c.encode(notes, forKey: .notes)
        try c.encodeIfPresent(reply, forKey: .reply)
        if none { try c.encode(true, forKey: .none) }
    }

    public var hasNotes: Bool {
        notes.values.contains { !$0.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
    }

    public var hasReply: Bool { !(reply ?? "").trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }

    /// The runner validates again. This only keeps the Send button from
    /// offering an empty reply or a pick that cannot be made.
    public func canSubmit(options: [ReviewOption]) -> Bool {
        let ids = Set(options.map(\.id))
        guard notes.allSatisfy({ ids.contains($0.key) && $0.value.utf16.count <= 4000 }) else { return false }
        guard (reply ?? "").utf16.count <= 8000, !(none && !pickedIds.isEmpty) else { return false }
        guard pickedIds.allSatisfy({ id in options.contains(where: { $0.id == id && !$0.reference }) }) else { return false }
        return !pickedIds.isEmpty || none || hasReply || hasNotes
    }

    public var jsonValue: JSONValue {
        var value: [String: JSONValue] = ["notes": .object(notes.mapValues(JSONValue.string))]
        if let pickedId { value["pickedId"] = .string(pickedId) }
        // Always the list, so a runner that knows it takes it over pickedId.
        value["pickedIds"] = .array(pickedIds.map(JSONValue.string))
        if let reply { value["reply"] = .string(reply) }
        if none { value["none"] = .bool(true) }
        return .object(value)
    }

    enum CodingKeys: String, CodingKey { case pickedId, pickedIds, notes, reply, none }
}

/// One picture of an option: its first, or another screen or state of it.
public struct ReviewShot: Sendable, Hashable, Codable {
    public var title: String?
    /// The picture, or a video's or page's still for thumbnails.
    public var image: ImageRef
    /// A video or an HTML page, shown in place of `image` on the stage.
    public var media: ImageRef?

    public init(title: String? = nil, image: ImageRef, media: ImageRef? = nil) {
        self.title = title
        self.image = image
        self.media = media
    }

    /// The video to play, when the shot is one.
    public var video: URL? {
        guard let media, media.mediaType.hasPrefix("video/") else { return nil }
        return URL(fileURLWithPath: media.path)
    }

    /// The page to show, when the shot is one.
    public var page: URL? {
        guard let media, media.mediaType == "text/html" else { return nil }
        return URL(fileURLWithPath: media.path)
    }
}

public struct ReviewOption: Sendable, Hashable, Codable, Identifiable {
    public var id: String
    public var title: String
    public var note: String?
    public var reference: Bool
    /// The first shot, all a runner from before shots sends.
    public var image: ImageRef
    /// Every shot in order, the first included, when there's more than one
    /// (or the one has a title).
    public var shots: [ReviewShot]
    /// Where it runs live, to try it.
    public var url: String?

    public init(id: String, title: String, note: String? = nil, reference: Bool = false, image: ImageRef, shots: [ReviewShot] = [], url: String? = nil) {
        self.id = id
        self.title = title
        self.note = note
        self.reference = reference
        self.image = image
        self.shots = shots
        self.url = url
    }

    /// What the window steps through: the shots, or the one image.
    public var allShots: [ReviewShot] { shots.isEmpty ? [ReviewShot(image: image)] : shots }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        title = try c.decodeIfPresent(String.self, forKey: .title) ?? id
        note = try c.decodeIfPresent(String.self, forKey: .note)
        reference = (try? c.decodeIfPresent(Bool.self, forKey: .reference)) ?? false
        image = try c.decode(ImageRef.self, forKey: .image)
        shots = c.lossyArray(ReviewShot.self, forKey: .shots)
        // Only a web page: a runner (maybe another Mac's) sends this, and
        // Open live hands it to the system. Anything else is no url at all.
        url = LinkPolicy.web((try? c.decodeIfPresent(String.self, forKey: .url)) ?? nil)?.absoluteString
    }

    enum CodingKeys: String, CodingKey { case id, title, note, reference, image, shots, url }
}

/// The latest persisted snapshot of a review. Status stays a string so a
/// newer runner can add a terminal state without making the card disappear.
/// Only the exact status "pending" can be edited by this client.
public struct DesignReview: Sendable, Hashable, Codable, Identifiable {
    public var id: String
    public var title: String
    public var note: String?
    /// The option id the agent would pick, marked "my pick" as on an asks card.
    public var recommended: String?
    public var options: [ReviewOption]
    public var status: String
    public var revision: Int
    public var createdAt: String
    public var updatedAt: String
    public var draft: ReviewDraft
    public var response: ReviewDraft?
    public var replyTurnId: String?

    public init(id: String, title: String, note: String? = nil, recommended: String? = nil, options: [ReviewOption], status: String = "pending",
                revision: Int = 1, createdAt: String = "", updatedAt: String = "", draft: ReviewDraft = ReviewDraft(),
                response: ReviewDraft? = nil, replyTurnId: String? = nil) {
        self.id = id
        self.title = title
        self.note = note
        self.recommended = recommended
        self.options = options
        self.status = status
        self.revision = revision
        self.createdAt = createdAt
        self.updatedAt = updatedAt
        self.draft = draft
        self.response = response
        self.replyTurnId = replyTurnId
    }

    public var isPending: Bool { status == "pending" }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        title = try c.decodeIfPresent(String.self, forKey: .title) ?? "Design options"
        note = try c.decodeIfPresent(String.self, forKey: .note)
        recommended = (try? c.decodeIfPresent(String.self, forKey: .recommended)) ?? nil
        options = c.lossyArray(ReviewOption.self, forKey: .options)
        status = try c.decodeIfPresent(String.self, forKey: .status) ?? "unknown"
        revision = c.lenientInt(forKey: .revision) ?? 0
        createdAt = try c.decodeIfPresent(String.self, forKey: .createdAt) ?? ""
        updatedAt = try c.decodeIfPresent(String.self, forKey: .updatedAt) ?? createdAt
        draft = try c.decodeIfPresent(ReviewDraft.self, forKey: .draft) ?? ReviewDraft()
        response = try c.decodeIfPresent(ReviewDraft.self, forKey: .response)
        replyTurnId = try c.decodeIfPresent(String.self, forKey: .replyTurnId)
    }

    enum CodingKeys: String, CodingKey { case id, title, note, recommended, options, status, revision, createdAt, updatedAt, draft, response, replyTurnId }
}

/// Creation takes source paths; the runner replaces these with imported
/// ImageRefs before it publishes a review.
public struct ReviewOptionInput: Sendable, Hashable, Codable {
    public var id: String
    public var title: String
    public var path: String
    public var note: String?
    public var reference: Bool

    public init(id: String, title: String, path: String, note: String? = nil, reference: Bool = false) {
        self.id = id
        self.title = title
        self.path = path
        self.note = note
        self.reference = reference
    }

    public var jsonValue: JSONValue {
        var fields: [String: JSONValue] = ["id": .string(id), "title": .string(title), "path": .string(path)]
        if let note { fields["note"] = .string(note) }
        if reference { fields["reference"] = .bool(true) }
        return .object(fields)
    }
}

public struct ReviewReply: Sendable, Hashable, Decodable {
    public var review: DesignReview
    public var turnId: String?

    public init(review: DesignReview, turnId: String? = nil) {
        self.review = review
        self.turnId = turnId
    }
}

/// Mike's answer to a review, read back out of the message the runner sent
/// for it (`reviewReply` in runner/src/reviews.ts), so his bubble can say
/// what he picked instead of showing the review's id and the agent-facing
/// wording (Mike, 29 Oct). The runner only puts the review's id and his
/// draft on the event, not the option titles, hence reading the text.
public struct ReviewAnswer: Sendable, Hashable {
    public struct Line: Sendable, Hashable {
        /// Small and quiet, over the line: what it's about.
        public var label: String
        /// In his own words' style: what he picked or wrote.
        public var text: String
    }

    public var lines: [Line]

    /// Nil when the text isn't the runner's wording for this review and
    /// draft, so the bubble shows it as it is.
    public static func parse(_ text: String, reviewId: String?, response: ReviewDraft?) -> ReviewAnswer? {
        guard let reviewId, let response else { return nil }
        var rest = Substring(text)
        // "Review: <title> (<id>)"
        let head = " (\(reviewId))"
        guard rest.hasPrefix("Review: "), let close = rest.range(of: head) else { return nil }
        let title = String(rest[rest.index(rest.startIndex, offsetBy: 8)..<close.lowerBound])
        rest = rest[close.upperBound...]
        var lines: [Line] = []
        // "Picked <id>. <option title>.", or "Picked A + D. <title> + <title>."
        let picks = response.pickedIds
        if !picks.isEmpty {
            let lead = "\n\nPicked \(picks.joined(separator: " + ")). "
            guard rest.hasPrefix(lead) else { return nil }
            rest = rest.dropFirst(lead.count)
            let end = rest.range(of: "\n\n")?.lowerBound ?? rest.endIndex
            var option = rest[..<end]
            if option.hasSuffix(".") { option = option.dropLast() }
            let what = picks.count == 1 ? Self.bare(option, id: picks[0]) : option
            lines.append(Line(label: title, text: "Picked \(picks.joined(separator: " + ")): \(what)"))
            rest = rest[end...]
        }
        if response.none {
            guard rest.hasPrefix("\n\nPicked none of them.") else { return nil }
            rest = rest.dropFirst("\n\nPicked none of them.".count)
            lines.append(Line(label: title, text: "None of them"))
        }
        // His reply, as he wrote it, under the pick or on its own.
        if let reply = response.reply, !reply.isEmpty {
            guard rest.hasPrefix("\n\n" + reply) else { return nil }
            rest = rest.dropFirst(2 + reply.count)
            lines.append(Line(label: lines.isEmpty ? title : "", text: reply))
        }
        // "Notes on <id> (<option title>): <note>", in the review's option
        // order, which the draft doesn't keep, so whichever comes next.
        var notes = response.notes.filter { !$0.value.isEmpty }
        while !notes.isEmpty {
            guard let (id, note) = notes.first(where: { rest.hasPrefix("\n\nNotes on \($0.key) (") }) else { return nil }
            rest = rest.dropFirst("\n\nNotes on \(id) (".count)
            guard let tail = rest.range(of: "): " + note) else { return nil }
            let option = rest[..<tail.lowerBound]
            // With nothing picked, the review's title goes over the first one.
            lines.append(Line(label: (lines.isEmpty ? title + "\n" : "") + "Notes on \(id): \(Self.bare(option, id: id))", text: note))
            rest = rest[tail.upperBound...]
            notes[id] = nil
        }
        return rest.isEmpty && !lines.isEmpty ? ReviewAnswer(lines: lines) : nil
    }

    /// Agents often title options "A: Summary first", which would read
    /// "Picked A: A: Summary first".
    static func bare(_ option: Substring, id: String) -> Substring {
        for sep in [": ", ". ", " - ", ") "] where option.hasPrefix(id + sep) && option.count > id.count + sep.count {
            return option.dropFirst(id.count + sep.count)
        }
        return option
    }
}

/// How a review's images share the stage: same-sized cells, as many columns
/// as make the images biggest. Three phones want one row and four wide
/// mockups want two; a fixed two columns left phones tiny in wide slots with
/// a quarter of the window empty (Mike, 1 Nov).
public struct ReviewGalleryLayout: Sendable, Hashable {
    public var columns: Int
    public var rows: Int
    public var cellWidth: Double
    public var cellHeight: Double

    /// `aspects` is each image's width over height. `chromeWidth` and
    /// `chromeHeight` are what a cell spends on anything but its image.
    public static func best(aspects: [Double], width: Double, height: Double, spacing: Double,
                            chromeWidth: Double = 0, chromeHeight: Double = 0) -> ReviewGalleryLayout {
        let count = max(1, aspects.count)
        var best: ReviewGalleryLayout?
        var bestArea = -1.0
        for columns in 1...count {
            let rows = (count + columns - 1) / columns
            let cellWidth = max(0, (width - spacing * Double(columns - 1)) / Double(columns))
            let cellHeight = max(0, (height - spacing * Double(rows - 1)) / Double(rows))
            let room = (max(0, cellWidth - chromeWidth), max(0, cellHeight - chromeHeight))
            let area = aspects.reduce(0.0) { total, aspect in
                let image = fit(aspect: aspect, width: room.0, height: room.1)
                return total + image.width * image.height
            }
            // Ties keep the fewer columns, for the wider cells.
            if area > bestArea {
                bestArea = area
                best = ReviewGalleryLayout(columns: columns, rows: rows, cellWidth: cellWidth, cellHeight: cellHeight)
            }
        }
        return best ?? ReviewGalleryLayout(columns: 1, rows: 1, cellWidth: 0, cellHeight: 0)
    }

    /// The biggest size of that shape inside the room given.
    public static func fit(aspect: Double, width: Double, height: Double) -> (width: Double, height: Double) {
        guard aspect > 0, width > 0, height > 0 else { return (max(0, width), max(0, height)) }
        return width / aspect <= height ? (width, width / aspect) : (height * aspect, height)
    }
}
