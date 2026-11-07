import AppKit
import Synchronization
import ThreadbearCore

/// Layout numbers shared by height measurement and the cell views, so the
/// two always agree. Every one follows `TextZoom` (`zoomed`), like a page
/// under a browser's zoom: paddings, radii and image sizes as well as the
/// heights that hold a line of text.
enum RowMetrics {
    static var rowTop: CGFloat { zoomed(6) }
    static var rowBottom: CGFloat { zoomed(6) }
    /// Space above a user message, which starts a turn: the biggest gap in
    /// the transcript, so turns read apart.
    static var userTop: CGFloat { zoomed(26) }
    /// Space under the bubble before the turn's work. At 10 the message sat
    /// right on top of the reply, closer than the gaps inside a turn; T3
    /// and Codex leave a clear pause there.
    static var userBottom: CGFloat { zoomed(22) }
    /// One line of work: a group summary, a tool call, a thinking block.
    static var workHeight: CGFloat { zoomed(32) }
    static var workingHeight: CGFloat { zoomed(34) }
    /// The bear beside a "Woke up" note, and all the room it takes.
    static var wokenBearSide: CGFloat { zoomed(18) }
    static var wokenBearRoom: CGFloat { wokenBearSide + zoomed(6) }
    static var bubblePadH: CGFloat { zoomed(14) }
    static var bubblePadV: CGFloat { zoomed(10) }
    static var bubbleRadius: CGFloat { zoomed(18) }
    /// The widest a user bubble gets, as a share of the column.
    static let bubbleShare: CGFloat = 0.8
    static var boxPad: CGFloat { zoomed(10) }
    static var diffPadV: CGFloat { zoomed(6) }
    /// Where a work line's text starts, after its icon. Every work line
    /// (group, tool, thinking, the working line) has its icon or spinner in
    /// the slot before it, so their text shares one edge.
    static var titleIndent: CGFloat { zoomed(22) }
    /// An NSTextField label draws its text this far in from its frame;
    /// work line labels start this much left so their glyphs line up.
    /// AppKit's own inset, so it stays put at any zoom.
    static let labelInset: CGFloat = 2
    /// How far an open group's items sit in from its summary line.
    static var groupIndent: CGFloat { zoomed(18) }
    static var cardPad: CGFloat { zoomed(14) }
    static var cardRadius: CGFloat { zoomed(12) }
    static var accentBar: CGFloat { zoomed(3) }
    static var buttonHeight: CGFloat { zoomed(28) }
    static var optionHeight: CGFloat { zoomed(24) }
    static var optionDescription: CGFloat { zoomed(17) }
    /// The question card's "Something else" field.
    static var otherFieldHeight: CGFloat { zoomed(30) }
    /// An answered question: the space under each question, and the line
    /// with the answer.
    static var answeredGap: CGFloat { zoomed(6) }
    static var answerHeight: CGFloat { zoomed(20) }
    /// A secret card's last line: what happens to the value, and Decline.
    static var secretFooterHeight: CGFloat { zoomed(22) }
    static var userThumbHeight: CGFloat { zoomed(120) }
    static var gridMaxHeight: CGFloat { zoomed(240) }
    static var gridMaxWidth: CGFloat { zoomed(320) }
    static var imageGap: CGFloat { zoomed(8) }
    /// The most lines an opened diff shows in the flow once Mike asks for
    /// all of it (it opens at `DiffPreview.lines`).
    static let maxDiffLines = 1500
    static var footerHeight: CGFloat { zoomed(27) }
    /// A message the runner sent by itself after a restart: a centred note
    /// right under the restart's own note, with room before the work it
    /// starts.
    static var runnerTop: CGFloat { zoomed(4) }
    static var runnerBottom: CGFloat { zoomed(18) }
    static var changesHeader: CGFloat { zoomed(42) }
    static var changesFile: CGFloat { zoomed(34) }
    /// The "6 min later" divider before a turn the agent woke up for.
    static var gapHeight: CGFloat { zoomed(34) }

    /// The reading column for a given table width: (x, width).
    static func column(tableWidth: CGFloat) -> (x: CGFloat, width: CGFloat) {
        let width = max(zoomed(200), min(tableWidth - Theme.sideInset * 2, Theme.maxContentWidth))
        return (floor((tableWidth - width) / 2), floor(width))
    }

    /// The row's own column: an open group's items sit in from the edge.
    static func column(for row: TranscriptRow, tableWidth: CGFloat) -> (x: CGFloat, width: CGFloat) {
        let (x, width) = column(tableWidth: tableWidth)
        return row.inGroup ? (x + groupIndent, width - groupIndent) : (x, width)
    }
}

/// Everything a cell needs to draw one row at one width, plus its height.
/// Immutable once built, so it's shared across threads.
final class RowRender: @unchecked Sendable {
    let height: CGFloat
    let text: NSAttributedString?
    let textSize: NSSize
    let detail: NSAttributedString?
    let detailSize: NSSize
    /// Markdown blocks and where each starts in `text` (assistant rows), for
    /// in-place streaming updates.
    let blocks: [String]
    let blockStarts: [Int]
    /// Image frames relative to the image area's top-left.
    let imageFrames: [NSRect]
    let imageAreaHeight: CGFloat
    /// Measured heights of a question card's question texts.
    let lineHeights: [CGFloat]
    /// A changes card's files.
    let parts: [Part]

    /// One line of a card (a changed file) and what opens under it.
    struct Part {
        var leading: NSAttributedString
        var trailing: NSAttributedString?
        var body: NSAttributedString?
        var bodyHeight: CGFloat = 0
    }

    init(height: CGFloat, text: NSAttributedString? = nil, textSize: NSSize = .zero, detail: NSAttributedString? = nil, detailSize: NSSize = .zero,
         blocks: [String] = [], blockStarts: [Int] = [], imageFrames: [NSRect] = [], imageAreaHeight: CGFloat = 0, lineHeights: [CGFloat] = [], parts: [Part] = []) {
        self.height = height
        self.text = text
        self.textSize = textSize
        self.detail = detail
        self.detailSize = detailSize
        self.blocks = blocks
        self.blockStarts = blockStarts
        self.imageFrames = imageFrames
        self.imageAreaHeight = imageAreaHeight
        self.lineHeights = lineHeights
        self.parts = parts
    }
}

/// Caches renders by (row id, content version, expanded, in a group, width).
final class RenderCache: @unchecked Sendable {
    private let cache = NSCache<NSString, RowRender>()
    /// For rows that are still changing (streaming text, a running tool):
    /// the key of the one version kept. Each streaming flush is a new
    /// version, and keeping them all pushed every other thread's renders out
    /// of the cache within seconds of a long reply.
    private let liveKeys = Mutex<[String: NSString]>([:])

    init() {
        // The cost limit is the real bound; this just has to be above a
        // long thread's row count at two widths.
        cache.countLimit = 10_000
        // Rough bytes (see `cost`): enough for a few thousand typical rows
        // without letting a run of huge expanded outputs pile up.
        cache.totalCostLimit = 40 * 1024 * 1024
    }

    /// A rough size: attributed strings cost far more than their UTF-16.
    static func cost(_ render: RowRender) -> Int {
        let parts = render.parts.reduce(0) { $0 + $1.leading.length + ($1.body?.length ?? 0) }
        let characters = (render.text?.length ?? 0) + (render.detail?.length ?? 0) + parts
        return 512 + characters * 12 + render.blocks.reduce(0) { $0 + $1.utf8.count }
    }

    /// Groups and changes cards carry their open state in their content
    /// (and so in their version); the flag is only for item rows.
    static func effectiveExpanded(_ row: TranscriptRow, _ expanded: Bool) -> Bool {
        switch row.content {
        case .group(let group): return group.isExpanded
        case .changes, .working, .background, .gap: return false
        default: return expanded
        }
    }

    /// "Show all lines" only changes an opened diff row; for anything else
    /// it would just split the cache.
    static func effectiveShowAll(_ row: TranscriptRow, expanded: Bool, showAll: Bool) -> Bool {
        showAll && row.kind == .diff && effectiveExpanded(row, expanded)
    }

    /// 0 closed, 1 open, 2 open with every line of its diff.
    static func openLevel(_ row: TranscriptRow, expanded: Bool, showAll: Bool) -> Int {
        guard effectiveExpanded(row, expanded) else { return 0 }
        return effectiveShowAll(row, expanded: expanded, showAll: showAll) ? 2 : 1
    }

    /// Keyed by the reading column's width, which with the text zoom is all
    /// a render depends on: tables of different widths with the column at
    /// its widest share renders, so a sidebar drag or a scroller appearing
    /// costs nothing.
    static func key(_ row: TranscriptRow, expanded: Bool, showAll: Bool = false, width: CGFloat, localPictures: Bool = true) -> NSString {
        let open = openLevel(row, expanded: expanded, showAll: showAll)
        return "\(row.id)|\(row.version)|\(open)|\(row.inGroup ? 1 : 0)|\(Int(RowMetrics.column(tableWidth: width).width))|\(TypeScale.percent)|\(richStamp(row))|\(buttonStamp(row))\(localPictures ? "" : "|away")" as NSString
    }

    /// A reply with a ```mermaid or ```html box renders again when one is
    /// drawn or flipped to its source; every other row keys on -1.
    static func richStamp(_ row: TranscriptRow) -> Int {
        guard case .assistant(let item) = row.content, RichBlocks.mayHoldRich(item.text) else { return -1 }
        return RichBlocks.shared.generation
    }

    /// A reply that links a reply button renders again when a button
    /// changes (made, pressed, failed, a press on its way).
    static func buttonStamp(_ row: TranscriptRow) -> Int {
        guard case .assistant(let item) = row.content, ReplyButtons.mayHold(item.text) else { return -1 }
        return ReplyButtons.shared.generation
    }

    static func holdsButtons(_ row: TranscriptRow) -> Bool { buttonStamp(row) != -1 }

    /// Whether a row is drawn differently once its rich blocks change.
    static func holdsRich(_ row: TranscriptRow) -> Bool { richStamp(row) != -1 }

    /// `localPictures`: false for another Mac's thread (MarkdownRenderer.localPictures).
    func cached(_ row: TranscriptRow, expanded: Bool, showAll: Bool = false, width: CGFloat, localPictures: Bool = true) -> RowRender? {
        cache.object(forKey: Self.key(row, expanded: expanded, showAll: showAll, width: width, localPictures: localPictures))
    }

    func render(_ row: TranscriptRow, expanded: Bool, showAll: Bool = false, width: CGFloat, localPictures: Bool = true) -> RowRender {
        let key = Self.key(row, expanded: expanded, showAll: showAll, width: width, localPictures: localPictures)
        if let hit = cache.object(forKey: key) { return hit }
        let render = MarkdownRenderer.withLocalPictures(localPictures) {
            RowRenderer.render(row, expanded: Self.effectiveExpanded(row, expanded),
                               showAll: Self.effectiveShowAll(row, expanded: expanded, showAll: showAll),
                               tableWidth: width, measurer: .current)
        }
        store(render, key: key, row: row, open: Self.openLevel(row, expanded: expanded, showAll: showAll), width: width)
        return render
    }

    private func store(_ render: RowRender, key: NSString, row: TranscriptRow, open: Int, width: CGFloat) {
        cache.setObject(render, forKey: key, cost: Self.cost(render))
        let slot = "\(row.id)|\(open)|\(row.inGroup ? 1 : 0)|\(Int(RowMetrics.column(tableWidth: width).width))|\(TypeScale.percent)"
        let live = row.isLive
        let superseded: NSString? = liveKeys.withLock { keys in
            let old = keys[slot]
            keys[slot] = live ? key : nil
            return old == key ? nil : old
        }
        if let superseded { cache.removeObject(forKey: superseded) }
    }

    /// Renders rows across all cores. Used before showing a thread or
    /// paging in older rows, so the main thread only reads the cache.
    func prepare(_ rows: [TranscriptRow], expanded: Set<String>, width: CGFloat, localPictures: Bool = true) {
        func showAll(_ row: TranscriptRow) -> Bool { row.kind == .diff && expanded.contains(DiffPreview.allKey(row.id)) }
        let missing = rows.filter { cached($0, expanded: expanded.contains($0.id), showAll: showAll($0), width: width, localPictures: localPictures) == nil }
        guard !missing.isEmpty else { return }
        DispatchQueue.concurrentPerform(iterations: missing.count) { index in
            let row = missing[index]
            _ = render(row, expanded: expanded.contains(row.id), showAll: showAll(row), width: width, localPictures: localPictures)
        }
    }

    func removeAll() { cache.removeAllObjects() }
}

extension TranscriptRow {
    /// Still changing: streaming text, a tool that hasn't finished, or a
    /// group that's still growing.
    var isLive: Bool {
        switch content {
        case .assistant(let item), .reasoning(let item): return item.isStreaming
        case .tool(let tool): return !tool.isFinished
        case .group(let group): return group.isLive
        default: return false
        }
    }
}

/// Measures the streaming assistant message incrementally. It keeps the
/// last text it measured in its own TextKit 1 stack and replaces only the
/// blocks from the first one that changed, so TextKit lays out just the tail
/// (the cell does the same with `replaceTail`). Main thread only.
final class StreamingMeasurer {
    nonisolated(unsafe) static let main = StreamingMeasurer()

    private let storage = NSTextStorage()
    private let layoutManager = NSLayoutManager()
    private let container = NSTextContainer(size: NSSize(width: 100, height: CGFloat.greatestFiniteMagnitude))
    private var rowId = ""
    /// The zoom the kept text was rendered at: after a zoom change the
    /// blocks still match as strings but every line is a different height.
    private var zoom = 0
    private var blocks: [String] = []
    private var starts: [Int] = []

    init() {
        // The same set-up as TextMeasurer, so the heights match exactly.
        container.lineFragmentPadding = 0
        layoutManager.addTextContainer(container)
        layoutManager.allowsNonContiguousLayout = false
        storage.addLayoutManager(layoutManager)
    }

    func measure(rowId: String, _ rendered: MarkdownRenderer.Rendered, width: CGFloat) -> NSSize {
        let string = rendered.string
        guard string.length > 0 else { return .zero }
        let width = max(1, width)
        var replaced = false
        let zoom = TypeScale.percent
        if rowId == self.rowId, zoom == self.zoom, container.size.width == width, !blocks.isEmpty {
            var common = 0
            while common < min(blocks.count, rendered.blocks.count) - 1, blocks[common] == rendered.blocks[common] {
                common += 1
            }
            let start = rendered.starts.indices.contains(common) ? rendered.starts[common] : 0
            let oldStart = starts.indices.contains(common) ? starts[common] : 0
            if start == oldStart, start <= storage.length, start <= string.length {
                storage.beginEditing()
                storage.replaceCharacters(in: NSRange(location: start, length: storage.length - start),
                                          with: string.attributedSubstring(from: NSRange(location: start, length: string.length - start)))
                storage.endEditing()
                replaced = true
            }
        }
        if !replaced {
            container.size = NSSize(width: width, height: CGFloat.greatestFiniteMagnitude)
            storage.setAttributedString(string)
        }
        self.rowId = rowId
        self.zoom = zoom
        blocks = rendered.blocks
        starts = rendered.starts
        layoutManager.ensureLayout(for: container)
        let used = layoutManager.usedRect(for: container)
        return NSSize(width: ceil(used.width), height: ceil(used.height))
    }
}

enum RowRenderer {
    static func render(_ row: TranscriptRow, expanded: Bool, showAll: Bool = false, tableWidth: CGFloat, measurer: TextMeasurer) -> RowRender {
        let width = RowMetrics.column(for: row, tableWidth: tableWidth).width
        let vertical = RowMetrics.rowTop + RowMetrics.rowBottom
        switch row.content {
        case .user(let message) where message.showsAsNote:
            let text = message.isFromSchedule ? scheduledMessageText(message) : runnerMessageText(message.text)
            let size = measurer.measure(text, width: width)
            return RowRender(height: RowMetrics.runnerTop + size.height + RowMetrics.runnerBottom, text: text, textSize: size)

        case .user(let message) where message.agentHeader != nil:
            let text = agentMessageText(message.agentHeader!)
            let size = measurer.measure(text, width: width - RowMetrics.cardPad * 2)
            return RowRender(height: RowMetrics.userTop + size.height + RowMetrics.cardPad * 2 + RowMetrics.userBottom, text: text, textSize: size)

        case .user(let message):
            let maxText = floor(width * RowMetrics.bubbleShare) - RowMetrics.bubblePadH * 2
            let text = userText(message)
            let size = measurer.measure(text, width: maxText)
            let (frames, area) = imageFrames(message.images, maxWidth: floor(width * RowMetrics.bubbleShare),
                                             maxHeight: RowMetrics.userThumbHeight, alignRight: true)
            let showText = !message.text.isEmpty || message.images.isEmpty
            let imageBlock = message.images.isEmpty ? 0 : area + (showText ? RowMetrics.imageGap : 0)
            let bubble = showText ? size.height + RowMetrics.bubblePadV * 2 : 0
            return RowRender(height: RowMetrics.userTop + imageBlock + bubble + RowMetrics.userBottom,
                             text: showText ? text : nil, textSize: size, imageFrames: frames, imageAreaHeight: area)

        case .assistant(let item):
            let rendered = MarkdownRenderer.render(item.text)
            // While a reply streams, each flush measures only what changed
            // since the last one (the finished blocks keep their layout).
            // Measuring the whole message every flush was 61% of the main
            // thread in a long pinned stream, growing with the message.
            var size = item.isStreaming && Thread.isMainThread
                ? StreamingMeasurer.main.measure(rowId: row.id, rendered, width: width)
                : measurer.measure(rendered.string, width: width)
            size.height += rendered.trailingPad
            // Only a streaming row needs its blocks (for in-place updates);
            // a finished one would just hold a second copy of its markdown.
            return RowRender(height: RowMetrics.rowTop + size.height + zoomed(10), text: rendered.string, textSize: size,
                             blocks: item.isStreaming ? rendered.blocks : [], blockStarts: item.isStreaming ? rendered.starts : [])

        case .reasoning(let item):
            let header = headerText(title: item.isStreaming ? "Thinking" : "Thought", subtitle: WorkSummary.thought(item.text))
            let headerSize = header.size()
            guard expanded else { return RowRender(height: RowMetrics.workHeight, text: header, textSize: headerSize) }
            let body = NSAttributedString(string: item.text, attributes: Theme.text(Theme.workFont, color: Theme.quietText, line: TypeScale.scaled(21), spacing: zoomed(6)))
            let size = measurer.measure(body, width: width - RowMetrics.titleIndent)
            return RowRender(height: RowMetrics.workHeight + size.height + zoomed(12), text: header, textSize: headerSize, detail: body, detailSize: size)

        case .tool(let tool):
            let header = toolHeader(tool)
            let headerSize = header.size()
            // An edit is one line with its +N -M that opens on a click, like
            // every other tool: open groups used to pour out every diff at
            // 12 lines each, and the changes card shows them again anyway.
            guard expanded else { return RowRender(height: RowMetrics.workHeight, text: header, textSize: headerSize) }
            let diffs = row.kind == .diff ? tool.effectiveDiffs.filter { !$0.hunks.isEmpty } : []
            if !diffs.isEmpty {
                let body = showAll
                    ? diffWithNote(diffs, maxLines: RowMetrics.maxDiffLines, root: tool.root)
                    : diffWithNote(diffs, maxLines: previewLines(diffs), more: DiffPreview.allKey(row.id), root: tool.root)
                let size = measurer.measure(body, width: width - RowMetrics.titleIndent - 1)
                let box = size.height + RowMetrics.diffPadV * 2
                return RowRender(height: RowMetrics.workHeight + box + zoomed(10), text: header, textSize: headerSize, detail: body, detailSize: size)
            }
            let body = toolBody(tool)
            let size = measurer.measure(body, width: width - RowMetrics.titleIndent - RowMetrics.boxPad * 2)
            return RowRender(height: RowMetrics.workHeight + size.height + RowMetrics.boxPad * 2 + zoomed(10), text: header, textSize: headerSize, detail: body, detailSize: size)

        case .images(_, let images, let generated):
            // A picture the agent made is the point of the step, so it's
            // shown large; screenshots from tools stay thumbnails.
            let (frames, area) = generated
                ? imageFrames(images, maxWidth: width, maxHeight: zoomed(ImageLayout.generatedMaxSide), cellWidth: zoomed(ImageLayout.generatedMaxSide), alignRight: false)
                : imageFrames(images, maxWidth: width, maxHeight: RowMetrics.gridMaxHeight, alignRight: false)
            return RowRender(height: vertical + zoomed(2) + area, imageFrames: frames, imageAreaHeight: area)

        case .approval(let item):
            if let resolution = item.resolution {
                // Settled, it's one quiet work line ("Allowed  Write
                // release.sh") that opens to what was asked, like a tool
                // row. As a full card it was as loud as one still waiting,
                // and the write it allowed followed it straight away.
                let header = resolvedApprovalText(item.request, resolution)
                let headerSize = header.size()
                guard expanded, item.opens else { return RowRender(height: RowMetrics.workHeight, text: header, textSize: headerSize) }
                let body = approvalPayload(item.request)
                let size = measurer.measure(body, width: width - RowMetrics.titleIndent - RowMetrics.boxPad * 2)
                return RowRender(height: RowMetrics.workHeight + size.height + RowMetrics.boxPad * 2 + zoomed(10), text: header, textSize: headerSize,
                                 detail: body, detailSize: size)
            }
            let inner = width - RowMetrics.cardPad * 2 - RowMetrics.accentBar
            let title = approvalTitleText(item)
            let titleSize = measurer.measure(title, width: inner)
            let payload = item.isStartRequest ? startRequestPayload(item.startRequest) : approvalPayload(item.request)
            let payloadSize = measurer.measure(payload, width: inner - RowMetrics.boxPad * 2)
            let height = RowMetrics.cardPad * 2 + titleSize.height + zoomed(10) + payloadSize.height + RowMetrics.boxPad * 2 + zoomed(12) + RowMetrics.buttonHeight
            return RowRender(height: vertical + zoomed(4) + height, text: title, textSize: titleSize, detail: payload, detailSize: payloadSize)

        case .question(let item):
            let inner = width - RowMetrics.cardPad * 2 - RowMetrics.accentBar
            var total = RowMetrics.cardPad * 2
            var textHeights: [CGFloat] = []
            let answered = item.resolution != nil
            for question in item.request.questions {
                let textHeight = measurer.measure(questionText(question.question, answered: answered), width: inner).height
                textHeights.append(textHeight)
                total += answered ? textHeight + RowMetrics.answeredGap : questionHeight(question, textHeight: textHeight)
            }
            guard let resolution = item.resolution else {
                total += RowMetrics.otherFieldHeight + zoomed(2) + zoomed(12) + RowMetrics.buttonHeight
                return RowRender(height: vertical + zoomed(4) + total, lineHeights: textHeights)
            }
            // Answered: the question and the answer, not every option
            // greyed out with none of them ticked.
            total += RowMetrics.answerHeight
            return RowRender(height: vertical + zoomed(4) + total, text: answerText(resolution), lineHeights: textHeights)

        case .secret(let item):
            // Settled, it's one quiet line ("Mac administrator password ·
            // Saved securely"), as an answered approval is; it opens to
            // nothing, since there's nothing more to show.
            if item.resolution != nil {
                let header = secretResolvedText(item)
                return RowRender(height: RowMetrics.workHeight, text: header, textSize: header.size())
            }
            let inner = width - RowMetrics.cardPad * 2 - RowMetrics.accentBar
            let text = secretCardText(item.request)
            let size = measurer.measure(text, width: inner)
            let note = secretNoteText(SecretRowCell.promise, color: Theme.faintText)
            let noteHeight = measurer.measure(note, width: secretNoteWidth(inner: inner)).height
            let footer = max(RowMetrics.secretFooterHeight, noteHeight + zoomed(6))
            let height = RowMetrics.cardPad * 2 + size.height + zoomed(12) + RowMetrics.otherFieldHeight + zoomed(10) + footer
            return RowRender(height: vertical + zoomed(4) + height, text: text, textSize: size, lineHeights: [footer])

        case .asks(let card):
            // The open card is drawn at the top of the composer instead
            // (ComposerCard), joined to the box it's answered in. Mike
            // picked that from mockups (30 Oct). Once closed it's left out
            // of the rows altogether.
            if card.isOpen { return RowRender(height: 0) }
            let text = asksText(card, width: width - RowMetrics.cardPad * 2)
            let size = measurer.measure(text, width: width - RowMetrics.cardPad * 2)
            return RowRender(height: vertical + zoomed(4) + size.height + RowMetrics.cardPad * 2 - zoomed(4), text: text, textSize: size)
        case .review:
            return RowRender(height: vertical + RowMetrics.cardPad * 2 + zoomed(22 + 4 + 20 + 10) + RowMetrics.buttonHeight)

        case .planCard(let card):
            let inner = width - RowMetrics.cardPad * 2
            let title = planCardTitle(card)
            // Room left for the ⓘ and "Waiting for you" beside it.
            let titleSize = measurer.measure(title, width: inner - zoomed(150))
            let body = planCardBody(card, expanded: expanded)
            let bodySize = measurer.measure(body, width: inner)
            var height = RowMetrics.cardPad * 2 + titleSize.height + zoomed(8) + bodySize.height
            if PlanCardLayout.hasFooter(card) { height += zoomed(12) + RowMetrics.buttonHeight }
            return RowRender(height: vertical + zoomed(4) + height, text: title, textSize: titleSize, detail: body, detailSize: bodySize)

        case .plan(let entries):
            let text = planText(entries)
            let size = measurer.measure(text, width: width - RowMetrics.cardPad * 2)
            return RowRender(height: vertical + zoomed(4) + size.height + RowMetrics.cardPad * 2 - zoomed(4), text: text, textSize: size)

        case .footer(let completion):
            return RowRender(height: RowMetrics.footerHeight, text: footerText(completion))

        case .note(let note):
            if row.inGroup {
                let header = headerText(title: firstLine(note), subtitle: "")
                return RowRender(height: RowMetrics.workHeight, text: header, textSize: header.size())
            }
            let text = NSAttributedString(string: note, attributes: Theme.text(Theme.smallFont, color: Theme.quietText, line: TypeScale.scaled(17), alignment: .center))
            // A wake note's bear sits left of the words, and they stay
            // centred, so they leave its room on both sides.
            let woke = row.content.isWakeNote
            let size = measurer.measure(text, width: woke ? width - 2 * RowMetrics.wokenBearRoom : width)
            return RowRender(height: vertical + (woke ? max(size.height, RowMetrics.wokenBearSide) : size.height), text: text, textSize: size)

        case .error(let message, let kind):
            let text = NSMutableAttributedString(string: message, attributes: Theme.text(color: .systemRed))
            // What to do about it, when the runner knows why. The limit's
            // fix (another account) is a button in the line above the
            // transcript, which knows the accounts.
            if let advice = errorAdvice(kind) {
                text.append(NSAttributedString(string: "\n" + advice, attributes: Theme.text(Theme.detailFont, color: Theme.quietText, line: TypeScale.scaled(19))))
            }
            let size = measurer.measure(text, width: width - RowMetrics.boxPad * 2)
            return RowRender(height: vertical + size.height + RowMetrics.boxPad * 2, text: text, textSize: size)

        case .group(let group):
            let text = groupText(group)
            return RowRender(height: RowMetrics.workHeight, text: text, textSize: text.size())

        case .working, .background:
            return RowRender(height: RowMetrics.workingHeight)

        case .gap:
            return RowRender(height: RowMetrics.gapHeight)

        case .changes(let card):
            return changesRender(card, width: width, measurer: measurer)
        }
    }

    /// The resume the runner sends after a restart, as a note rather than a
    /// bubble: it wasn't Mike talking. The first line says where it came
    /// from; the message itself is under it, since the agent acts on it.
    static func runnerMessageText(_ message: String) -> NSAttributedString {
        let text = NSMutableAttributedString(string: "Sent by the runner after it restarted",
                                             attributes: Theme.text(Theme.smallFont, color: Theme.faintText, line: TypeScale.scaled(17), alignment: .center))
        let body = message.trimmingCharacters(in: .whitespacesAndNewlines)
        if !body.isEmpty {
            text.append(NSAttributedString(string: "\n" + body, attributes: Theme.text(Theme.labelFont, color: Theme.quietText, line: TypeScale.scaled(19), alignment: .center)))
        }
        return text
    }

    /// A schedule's message, the same kind of note: a clock and the
    /// schedule's name and time (from the header line the runner puts on
    /// it, which isn't repeated), then the message.
    static func scheduledMessageText(_ message: UserMessage) -> NSAttributedString {
        let header = message.scheduledHeader
        let attributes = Theme.text(Theme.smallFont, color: Theme.faintText, line: TypeScale.scaled(17), alignment: .center)
        let text = NSMutableAttributedString(attributedString: symbol("clock", label: "Scheduled", font: Theme.smallFont, attributes: attributes))
        let label = header.map { "Scheduled: \($0.title) · \($0.whenText)" } ?? "Sent by a schedule"
        text.append(NSAttributedString(string: " " + label, attributes: attributes))
        let body = (header?.body ?? message.text).trimmingCharacters(in: .whitespacesAndNewlines)
        if !body.isEmpty {
            text.append(NSAttributedString(string: "\n" + body, attributes: Theme.text(Theme.labelFont, color: Theme.quietText, line: TypeScale.scaled(19), alignment: .center)))
        }
        return text
    }

    /// A message another thread's agent sent: a card, left-aligned so it
    /// can't pass for Mike's bubble, headed by the thread it came from. The
    /// thread's name is a chip (when the thread still exists), so a click
    /// opens it. The header line itself isn't repeated. A move's `then` is
    /// the same card, from this thread's own agent: as Mike's bubble, he
    /// asked why a message he never wrote was there.
    static func agentMessageText(_ header: AgentHeader) -> NSAttributedString {
        let attributes = Theme.text(Theme.smallFont, color: Theme.faintText, line: TypeScale.scaled(17), spacing: zoomed(8))
        let text: NSMutableAttributedString
        if let folder = header.movedTo {
            text = NSMutableAttributedString(attributedString: symbol("folder", label: "After a move", font: Theme.smallFont, attributes: attributes))
            text.append(NSAttributedString(string: " Left by this thread's agent when it moved to \((folder as NSString).abbreviatingWithTildeInPath)", attributes: attributes))
        } else {
            text = NSMutableAttributedString(attributedString: symbol("arrow.turn.down.right", label: "From another thread", font: Theme.smallFont, attributes: attributes))
            text.append(NSAttributedString(string: " From the agent in ", attributes: attributes))
            var name = attributes
            name[.tbThreadRef] = header.threadId
            text.append(NSAttributedString(string: header.title.isEmpty ? header.threadId : header.title, attributes: name))
        }
        let body = header.body.trimmingCharacters(in: .whitespacesAndNewlines)
        if !body.isEmpty {
            text.append(NSAttributedString(string: "\n", attributes: attributes))
            text.append(MarkdownRenderer.render(body).string)
        }
        return text
    }

    /// An SF Symbol as a text attachment, in the label's faint colour.
    /// Drawn through a handler so the colour follows light and dark at draw
    /// time, like the text beside it.
    private static func symbol(_ name: String, label: String, font: NSFont, attributes: [NSAttributedString.Key: Any], color: NSColor = Theme.faintText) -> NSAttributedString {
        let config = NSImage.SymbolConfiguration(pointSize: font.pointSize, weight: .regular)
        guard let symbol = NSImage(systemSymbolName: name, accessibilityDescription: label)?.withSymbolConfiguration(config) else {
            return NSAttributedString()
        }
        let size = symbol.size
        let image = NSImage(size: size, flipped: false) { rect in
            // The colour, cut to the symbol's shape: drawn over the black
            // symbol instead, a translucent grey stayed nearly black.
            color.set()
            rect.fill(using: .copy)
            symbol.draw(in: rect, from: .zero, operation: .destinationIn, fraction: 1)
            return true
        }
        let attachment = NSTextAttachment()
        attachment.image = image
        // Centred on the capitals beside it.
        attachment.bounds = NSRect(x: 0, y: ((font.capHeight - size.height) / 2).rounded(), width: size.width, height: size.height)
        var withAttachment = attributes
        withAttachment[.attachment] = attachment
        return NSAttributedString(string: "\u{FFFC}", attributes: withAttachment)
    }

    // MARK: Work lines

    static func firstLine(_ text: String) -> String {
        let line = text.split(whereSeparator: \.isNewline).first.map(String.init) ?? ""
        return line.count > 200 ? String(line.prefix(200)) : line
    }

    static func clampLines(_ text: String, _ count: Int) -> String {
        let lines = text.split(separator: "\n", omittingEmptySubsequences: false)
        guard lines.count > count else { return text }
        return lines.prefix(count).joined(separator: "\n") + "\n…"
    }

    static var truncating: NSParagraphStyle {
        let style = NSMutableParagraphStyle()
        style.lineBreakMode = .byTruncatingTail
        return style
    }

    static func headerText(title: String, subtitle: String) -> NSAttributedString {
        let style = truncating
        let output = NSMutableAttributedString(string: title, attributes: [
            .font: Theme.workFont, .foregroundColor: Theme.quietText, .paragraphStyle: style,
        ])
        if !subtitle.isEmpty {
            output.append(NSAttributedString(string: "  " + subtitle, attributes: [
                .font: Theme.workFont, .foregroundColor: Theme.faintText, .paragraphStyle: style,
            ]))
        }
        return output
    }

    static func groupText(_ group: ThreadbearCore.WorkGroup) -> NSAttributedString {
        let style = truncating
        let output = NSMutableAttributedString(string: group.summary, attributes: [
            .font: Theme.workFont, .foregroundColor: Theme.quietText, .paragraphStyle: style,
        ])
        if group.failedCount > 0 {
            // Only the count is red; the comma belongs to the quiet summary.
            output.append(NSAttributedString(string: ", ", attributes: [
                .font: Theme.workFont, .foregroundColor: Theme.quietText, .paragraphStyle: style,
            ]))
            output.append(NSAttributedString(string: "\(group.failedCount) failed", attributes: [
                .font: Theme.workFont, .foregroundColor: Theme.failed, .paragraphStyle: style,
            ]))
        }
        if group.isLive, let action = group.currentAction {
            // What's happening now is what Mike watches while a turn runs,
            // so it's the brightest work text on screen: the summary before
            // it stays quiet and the dot faint, as Codex and T3 do.
            output.append(NSAttributedString(string: "  ·  ", attributes: [
                .font: Theme.workFont, .foregroundColor: Theme.faintText, .paragraphStyle: style,
            ]))
            output.append(NSAttributedString(string: ToolPresentation.shortTitle(action, limit: 90), attributes: [
                .font: Theme.workFont, .foregroundColor: NSColor.labelColor, .paragraphStyle: style,
            ]))
        }
        return output
    }

    /// "Allowed  Write release.sh": the decision, then what it was for.
    static func resolvedApprovalText(_ request: ApprovalRequest, _ resolution: ApprovalResolution) -> NSAttributedString {
        let style = truncating
        let output = NSMutableAttributedString(string: ApprovalText.decision(resolution.decision), attributes: [
            .font: Theme.workFont, .foregroundColor: Theme.faintText, .paragraphStyle: style,
        ])
        if resolution.decision != .expired {
            output.append(NSAttributedString(string: "  " + ApprovalText.target(request), attributes: [
                .font: Theme.workFont, .foregroundColor: Theme.quietText, .paragraphStyle: style,
            ]))
        }
        return output
    }

    static func toolHeader(_ tool: ToolItem) -> NSAttributedString {
        let style = truncating
        // A failure is marked once, by the red icon; the title stays in the
        // work line colour rather than the row turning red all over.
        let color = Theme.quietText
        let output: NSMutableAttributedString
        if let file = ToolPresentation.fileTitle(tool) {
            // "Read UploadTask.swift  Sources/Upload": the file, then its
            // folder dimmed, as in the changes card. The whole path is the
            // row's tooltip.
            output = NSMutableAttributedString(string: file.verb + " " + file.name, attributes: [
                .font: Theme.workFont, .foregroundColor: color, .paragraphStyle: style,
            ])
            if !file.folder.isEmpty {
                output.append(NSAttributedString(string: "  " + file.folder, attributes: [
                    .font: Theme.detailFont, .foregroundColor: Theme.faintText, .paragraphStyle: style,
                ]))
            }
        } else {
            output = NSMutableAttributedString(string: ToolPresentation.shortTitle(tool.title), attributes: [
                .font: Theme.workFont, .foregroundColor: color, .paragraphStyle: style,
            ])
        }
        let diffs = tool.effectiveDiffs.filter { !$0.hunks.isEmpty }
        if !diffs.isEmpty {
            let stats = diffs.map(DiffBuilder.stats).reduce((added: 0, removed: 0)) { ($0.added + $1.added, $0.removed + $1.removed) }
            output.append(statsText(added: stats.added, removed: stats.removed, leading: "  "))
        }
        return output
    }

    static func statsText(added: Int, removed: Int, leading: String = "") -> NSAttributedString {
        let output = NSMutableAttributedString(string: leading + "+\(added)", attributes: [.font: Theme.statsFont, .foregroundColor: Theme.addedText])
        output.append(NSAttributedString(string: " −\(removed)", attributes: [.font: Theme.statsFont, .foregroundColor: Theme.removedText]))
        return output
    }

    // MARK: Expanded tools

    static var monoFont: NSFont { Theme.outputFont }

    static func mono(_ text: String, _ color: NSColor) -> NSAttributedString {
        let (style, offset) = Theme.lines(TypeScale.outputLine, font: monoFont)
        style.lineBreakMode = .byCharWrapping
        return NSAttributedString(string: text, attributes: [.font: monoFont, .foregroundColor: color, .paragraphStyle: style, .baselineOffset: offset])
    }

    /// An empty line `height` tall, for a little space between parts.
    static func gap(_ height: CGFloat) -> NSAttributedString {
        let font = NSFont.systemFont(ofSize: 2)
        let (style, _) = Theme.lines(height, font: font)
        return NSAttributedString(string: "\n", attributes: [.font: font, .paragraphStyle: style])
    }

    /// What an expanded tool shows: a command and its output, a file with
    /// line numbers, a search and its matches, or the input as fields.
    static func toolBody(_ tool: ToolItem) -> NSAttributedString {
        // A generated image's revised prompt is prose: the reading font,
        // wrapped at words (in the output font it broke mid-word).
        if tool.toolKind == .image, let text = tool.result?.text, !text.isEmpty {
            return NSAttributedString(string: text, attributes: Theme.text(Theme.workFont, color: tool.failed ? Theme.failed : Theme.quietText, line: TypeScale.scaled(21)))
        }
        let output = NSMutableAttributedString()
        // Output is ordinary text even when the tool failed: in red it read
        // as removed code and was the loudest thing in the window. Only the
        // lines that say what went wrong are marked.
        let outputColor = Theme.quietText
        var hasOutput = false
        func appendOutput(_ text: String) {
            guard !text.isEmpty else { return }
            hasOutput = true
            if output.length > 0 {
                output.append(mono("\n", outputColor))
                output.append(gap(zoomed(8)))
            }
            guard tool.failed else { return output.append(mono(text, outputColor)) }
            // Runs of lines in one colour, so long output stays a few runs.
            var run: [Substring] = []
            var runIsError = false
            func flush() {
                guard !run.isEmpty else { return }
                output.append(mono(run.joined(separator: "\n"), runIsError ? Theme.failed : outputColor))
                run = []
            }
            for line in text.split(separator: "\n", omittingEmptySubsequences: false) {
                let isError = ToolPresentation.isErrorLine(line)
                if !run.isEmpty, isError != runIsError {
                    flush()
                    output.append(mono("\n", outputColor))
                }
                runIsError = isError
                run.append(line)
            }
            flush()
        }
        switch ToolPresentation.detail(tool) {
        case .command(let command, let result):
            output.append(mono("$ ", Theme.faintText))
            output.append(mono(clampLines(command, 40), .labelColor))
            appendOutput(result)
        case .file(_, let lines):
            // Just the lines: the row's title already names the file (and
            // its tooltip has the whole path).
            if !lines.isEmpty {
                hasOutput = true
                output.append(numbered(lines))
            }
        case .search(let query, let scope, let result):
            output.append(mono(query, .labelColor))
            if let scope { output.append(mono("  in " + scope, Theme.faintText)) }
            appendOutput(result)
        case .fields(let fields, let result):
            output.append(fieldsText(fields))
            appendOutput(result)
        }
        if tool.result?.truncated == true {
            output.append(mono("\n", .labelColor))
            output.append(gap(zoomed(6)))
            let note = Theme.text(Theme.smallFont, color: Theme.faintText, line: TypeScale.scaled(17))
            output.append(NSAttributedString(string: "Output shortened", attributes: note))
            // The whole of it is kept in a file (blobPath): a file link, so
            // it opens like any other, fetched first in another runner's
            // thread.
            if let blob = tool.result?.blobPath, !blob.isEmpty {
                output.append(NSAttributedString(string: " · ", attributes: note))
                var link = note
                link[.link] = URL(fileURLWithPath: blob)
                output.append(NSAttributedString(string: "Show all", attributes: link))
            }
        } else if !hasOutput {
            if output.length > 0 { output.append(mono("\n", .labelColor)) }
            output.append(mono(tool.isFinished ? "No output" : "Running…", Theme.faintText))
        }
        return output
    }

    /// Tool input as "key:  value" lines with the values in one column (a
    /// tab stop past the widest key, up to a cap) and long values wrapping
    /// under their value rather than back under the key.
    static func fieldsText(_ fields: [ToolPresentation.Field]) -> NSAttributedString {
        let keyWidth = ToolPresentation.keyWidth(fields)
        let column = CGFloat(keyWidth + 2) * Theme.digitWidth(monoFont)
        let (style, offset) = Theme.lines(TypeScale.outputLine, font: monoFont, head: column, first: 0)
        style.tabStops = [NSTextTab(textAlignment: .left, location: column)]
        style.lineBreakMode = .byCharWrapping
        let key: [NSAttributedString.Key: Any] = [.font: monoFont, .foregroundColor: Theme.faintText, .paragraphStyle: style, .baselineOffset: offset]
        var value = key
        value[.foregroundColor] = NSColor.labelColor
        let output = NSMutableAttributedString()
        for (index, field) in fields.enumerated() {
            if index > 0 { output.append(NSAttributedString(string: "\n", attributes: value)) }
            // A key past the cap runs on into its value instead.
            let label = field.key + ":"
            output.append(NSAttributedString(string: label + (label.count > keyWidth ? " " : "\t"), attributes: key))
            output.append(NSAttributedString(string: field.value, attributes: value))
        }
        return output
    }

    /// File lines with their numbers right-aligned in a gutter.
    static func numbered(_ lines: [ToolPresentation.NumberedLine]) -> NSAttributedString {
        let digits = max(3, String(lines.compactMap(\.number).max() ?? 0).count)
        let gutter = CGFloat(digits) * Theme.digitWidth(monoFont) + zoomed(2)
        // Wrapped lines hang under the text, past the number.
        let (style, offset) = Theme.lines(TypeScale.outputLine, font: monoFont, head: gutter + zoomed(14), first: 0)
        style.tabStops = [NSTextTab(textAlignment: .right, location: gutter), NSTextTab(textAlignment: .left, location: gutter + zoomed(14))]
        style.lineBreakMode = .byCharWrapping
        let numberAttributes: [NSAttributedString.Key: Any] = [.font: monoFont, .foregroundColor: Theme.faintText, .paragraphStyle: style, .baselineOffset: offset]
        let textAttributes: [NSAttributedString.Key: Any] = [.font: monoFont, .foregroundColor: Theme.quietText, .paragraphStyle: style, .baselineOffset: offset]
        let output = NSMutableAttributedString()
        for (index, line) in lines.enumerated() {
            if index > 0 { output.append(NSAttributedString(string: "\n", attributes: textAttributes)) }
            output.append(NSAttributedString(string: "\t" + (line.number.map(String.init) ?? "") + "\t", attributes: numberAttributes))
            output.append(NSAttributedString(string: line.text.replacingOccurrences(of: "\t", with: "    "), attributes: textAttributes))
        }
        return output
    }

    // MARK: Diffs

    /// A diff and, if it was cut short, what was left out: "Show 30 more
    /// lines", which opens the rest through the expansion key `more`, or
    /// with no key (all of it is already open, up to the cap) a quiet note.
    static func diffWithNote(_ diffs: [EditDiff], maxLines: Int, inset: CGFloat = zoomed(10), more: String? = nil, root: String? = nil) -> NSAttributedString {
        let (diff, hidden) = diffText(diffs, maxLines: maxLines, inset: inset, root: root)
        guard hidden > 0 else { return diff }
        let body = NSMutableAttributedString(attributedString: diff)
        let lines = hidden == 1 ? "1 more line" : "\(hidden) more lines"
        if let more {
            let (style, offset) = Theme.lines(TypeScale.scaled(26), font: Theme.detailFont, head: inset, first: inset)
            let link: [NSAttributedString.Key: Any] = [.font: Theme.detailFont, .foregroundColor: Theme.quietText, .paragraphStyle: style,
                                                       .baselineOffset: offset, .tbAction: more, .cursor: NSCursor.pointingHand]
            body.append(NSAttributedString(string: "\n", attributes: [.font: Theme.detailFont, .paragraphStyle: style]))
            body.append(NSAttributedString(string: "Show " + lines, attributes: link))
        } else {
            let (style, offset) = Theme.lines(TypeScale.scaled(24), font: Theme.smallFont, head: inset, first: inset)
            let note: [NSAttributedString.Key: Any] = [.font: Theme.smallFont, .foregroundColor: Theme.faintText, .paragraphStyle: style, .baselineOffset: offset]
            body.append(NSAttributedString(string: "\n", attributes: note))
            body.append(NSAttributedString(string: lines + " not shown", attributes: note))
        }
        return body
    }

    /// How many lines of `diffs` a diff opened short shows (a break between
    /// two diffs counts as a line, as `diffText` draws it).
    static func previewLines(_ diffs: [EditDiff]) -> Int {
        // A file-name line over each file's diff, or a break between edits
        // to one file.
        let between = namesFiles(diffs) ? diffs.count : max(0, diffs.count - 1)
        let total = diffs.reduce(0) { $0 + DiffBuilder.displayLines($1).count } + between
        return DiffPreview.shown(of: total)
    }

    /// Diff lines with line numbers and the +/− sign in a quiet gutter, on
    /// faint tints. Returns the text and how many lines were left out.
    /// Whether a run of diffs is more than one file (a Codex patch), so
    /// each gets its name over it; several edits to one file don't.
    static func namesFiles(_ diffs: [EditDiff]) -> Bool {
        Set(diffs.map(\.path)).count > 1
    }

    static func diffText(_ diffs: [EditDiff], maxLines: Int, inset: CGFloat = zoomed(10), root: String? = nil) -> (NSAttributedString, hidden: Int) {
        var lines: [DiffDisplayLine] = []
        var hidden = 0
        // Line index -> the file-name line drawn there instead of a break.
        // Without them a patch's three files ran together, split only by
        // "⋯", with line numbers starting again.
        var fileNames: [Int: NSAttributedString] = [:]
        let named = namesFiles(diffs)
        for (index, diff) in diffs.enumerated() {
            let room = maxLines - lines.count
            guard room > 0 else {
                hidden += DiffBuilder.displayLines(diff).count
                continue
            }
            if named {
                fileNames[lines.count] = fileNameLine(diff, root: root, inset: inset, first: index == 0)
                lines.append(DiffDisplayLine(kind: .hunkHeader, text: ""))
            } else if index > 0 {
                lines.append(DiffDisplayLine(kind: .hunkHeader, text: ""))
            }
            for line in DiffBuilder.displayLines(diff, maxLines: room) {
                if line.kind == .elided {
                    hidden += Int(line.text.split(separator: " ").first ?? "") ?? 0
                } else {
                    lines.append(line)
                }
            }
        }
        let numbers = lines.compactMap { $0.newNumber ?? $0.oldNumber }
        let digits = max(2, String(numbers.max() ?? 0).count)
        let numberEnd = inset + CGFloat(digits) * Theme.digitWidth(Theme.diffFont)
        // A new file is all additions: shown as plain content with green
        // signs rather than a solid green slab, the loudest thing on screen.
        let newFile = lines.allSatisfy { $0.kind != .removed && $0.kind != .context }
        let signAt = numberEnd + zoomed(10)
        let textAt = signAt + zoomed(14)
        // Wrapped lines stop as far from the box's right edge as the
        // numbers start from its left; they ran right up to the border.
        let (style, offset) = Theme.lines(Theme.diffLine, font: Theme.diffFont, head: textAt, first: 0, tail: -inset)
        style.tabStops = [NSTextTab(textAlignment: .right, location: numberEnd), NSTextTab(textAlignment: .left, location: signAt),
                          NSTextTab(textAlignment: .left, location: textAt)]
        style.lineBreakMode = .byCharWrapping
        let gutter: [NSAttributedString.Key: Any] = [.font: Theme.diffFont, .foregroundColor: Theme.faintText, .paragraphStyle: style, .baselineOffset: offset]
        let body: [NSAttributedString.Key: Any] = [.font: Theme.diffFont, .foregroundColor: NSColor.labelColor, .paragraphStyle: style, .baselineOffset: offset]

        let output = NSMutableAttributedString()
        for (index, line) in lines.enumerated() {
            if index > 0 { output.append(NSAttributedString(string: "\n", attributes: body)) }
            let start = output.length
            let number: Int?
            let sign: String
            let background: NSColor?
            switch line.kind {
            case .added: number = line.newNumber; sign = "+"; background = newFile ? nil : Theme.addedBackground
            // One column of new-file numbers that only counts up: a removed
            // line's old number made it run 20, 20, ... 27, 25.
            case .removed: number = nil; sign = "−"; background = Theme.removedBackground
            case .context: number = line.newNumber; sign = ""; background = nil
            case .hunkHeader, .elided: number = nil; sign = ""; background = nil
            }
            if let name = fileNames[index] {
                output.append(name)
                continue
            }
            if line.kind == .hunkHeader {
                // A quiet break between hunks rather than the @@ header.
                output.append(NSAttributedString(string: "\t\t⋯", attributes: gutter))
                continue
            }
            output.append(NSAttributedString(string: "\t" + (number.map(String.init) ?? "") + "\t", attributes: gutter))
            var signAttributes = gutter
            if newFile { signAttributes[.foregroundColor] = Theme.addedText }
            output.append(NSAttributedString(string: sign + "\t", attributes: signAttributes))
            output.append(NSAttributedString(string: line.text.replacingOccurrences(of: "\t", with: "    "), attributes: body))
            if let background {
                output.addAttribute(.tbLineBackground, value: background, range: NSRange(location: start, length: output.length - start))
            }
        }
        return (output, hidden)
    }

    /// "events.html  src/pages  +1 −0" over one file's part of a patch.
    static func fileNameLine(_ diff: EditDiff, root: String?, inset: CGFloat, first: Bool) -> NSAttributedString {
        let (style, offset) = Theme.lines(Theme.diffLine, font: Theme.detailFont, before: first ? 0 : zoomed(8), head: inset, first: inset)
        let line = NSMutableAttributedString(string: (diff.path as NSString).lastPathComponent, attributes: [
            .font: Theme.detailFont, .foregroundColor: Theme.quietText, .paragraphStyle: style, .baselineOffset: offset,
        ])
        let folder = PathDisplay.folder(of: diff.path, relativeTo: root)
        if !folder.isEmpty {
            line.append(NSAttributedString(string: "  " + folder, attributes: [.font: Theme.detailFont, .foregroundColor: Theme.faintText, .paragraphStyle: style, .baselineOffset: offset]))
        }
        let stats = DiffBuilder.stats(diff)
        let counts = NSMutableAttributedString(attributedString: statsText(added: stats.added, removed: stats.removed, leading: "  "))
        counts.addAttributes([.paragraphStyle: style, .baselineOffset: offset], range: NSRange(location: 0, length: counts.length))
        line.append(counts)
        return line
    }

    // MARK: Changes card

    static func changesRender(_ card: ChangedFiles, width: CGFloat, measurer: TextMeasurer) -> RowRender {
        let title = NSAttributedString(string: card.title, attributes: [.font: Theme.changesTitleFont, .foregroundColor: NSColor.labelColor])
        let total = statsText(added: card.added, removed: card.removed)
        var parts: [RowRender.Part] = []
        var height = RowMetrics.changesHeader
        for file in card.files {
            let line = NSMutableAttributedString(string: file.name, attributes: [.font: Theme.workFont, .foregroundColor: NSColor.labelColor, .paragraphStyle: truncating])
            if !file.folder.isEmpty {
                line.append(NSAttributedString(string: "  " + file.folder, attributes: [.font: Theme.detailFont, .foregroundColor: Theme.faintText, .paragraphStyle: truncating]))
            }
            var part = RowRender.Part(leading: line, trailing: statsText(added: file.added, removed: file.removed))
            height += RowMetrics.changesFile
            if file.isExpanded {
                let key = ChangedFiles.expansionKey(turnId: card.turnId, path: file.path)
                let body = file.showsAll
                    ? diffWithNote(file.diffs, maxLines: 600, inset: RowMetrics.cardPad)
                    : diffWithNote(file.diffs, maxLines: previewLines(file.diffs), inset: RowMetrics.cardPad, more: DiffPreview.allKey(key))
                part.body = body
                part.bodyHeight = measurer.measure(body, width: width - 1).height + zoomed(8)
                height += part.bodyHeight
            }
            parts.append(part)
        }
        height += zoomed(6)
        return RowRender(height: zoomed(8) + height + zoomed(6), text: title, detail: total, parts: parts)
    }

    // MARK: Cards

    /// "Write release.sh?" and, for a file, its folder after it, dimmed, as
    /// file rows show it. The card's tooltip has the whole path.
    static func approvalTitleText(_ item: ApprovalItem) -> NSAttributedString {
        if item.isStartRequest { return startRequestTitle(item.startRequest) }
        var attributes = Theme.text(Theme.cardTitleFont, line: TypeScale.scaled(20))
        let output = NSMutableAttributedString(string: ApprovalText.title(item.request), attributes: attributes)
        if let path = ApprovalText.filePath(item.request) {
            let folder = PathDisplay.folder(of: path, relativeTo: item.root)
            if !folder.isEmpty {
                // Same line height and baseline offset as the title, so the
                // smaller run sits on its baseline.
                attributes[.font] = Theme.detailFont
                attributes[.foregroundColor] = Theme.faintText
                output.append(NSAttributedString(string: "  " + folder, attributes: attributes))
            }
        }
        // Codex says why it's asking, in the model's own words ("Allow
        // creating b.txt in the current directory?").
        if let reason = item.request.input["reason"]?.stringValue?.trimmingCharacters(in: .whitespacesAndNewlines), !reason.isEmpty {
            output.append(NSAttributedString(string: "\n" + reason, attributes: Theme.text(Theme.detailFont, color: Theme.quietText, line: TypeScale.scaled(19))))
        }
        return output
    }

    /// The command, the start of what would be written to a file, the page,
    /// or the tool's input, in a monospaced block. The file's name and
    /// folder are in the title above it. A command and a tool's input are
    /// shown whole, every line and field, as Allow allows all of them: the
    /// card grows to fit (Daybreak, 7 Nov 2026, a long command's tail was
    /// cut off after 12 lines). The runner refuses a call too long to show.
    static func approvalPayload(_ request: ApprovalRequest) -> NSAttributedString {
        let input = request.input
        if let command = input["command"]?.stringValue {
            // Where it runs and any network it asks for (a Codex card's)
            // are part of what Allow allows; a reason or description isn't.
            let output = NSMutableAttributedString(attributedString: mono(command, .labelColor))
            let extra = ToolPresentation.fields(input, whole: true).filter { !["command", "description", "reason"].contains($0.key) }
            if !extra.isEmpty {
                output.append(mono("\n", .labelColor))
                output.append(fieldsText(extra))
            }
            return output
        }
        // Another MCP server's tool with a path is shown by all its fields,
        // below: its content is what Allow allows.
        if !request.name.hasPrefix("mcp__"), ApprovalText.filePath(request) != nil {
            let call = ToolCall(itemId: request.approvalId, name: request.name, kind: request.name == "Write" ? .write : .edit,
                                title: request.title, input: input)
            if let diff = DiffBuilder.diff(forTool: call), !diff.hunks.isEmpty {
                // A file Threadbear runs as code, or can't rule out, shows
                // every line it writes: a hook past the eighth line is still a hook.
                let code = request.title.contains("Threadbear runs this file as code")
                    || request.title.contains("Threadbear can't tell whether this file runs as code")
                return diffText([diff], maxLines: code ? 1_000_000 : 8, inset: 0).0
            }
            return mono(ToolPresentation.shortTitle(ApprovalText.filePath(request) ?? "", limit: 300), Theme.quietText)
        }
        if !request.name.hasPrefix("mcp__"), let url = input["url"]?.stringValue {
            return mono(url, .labelColor)
        }
        let fields = ToolPresentation.fields(input, whole: true)
        if fields.isEmpty { return mono(request.title, .labelColor) }
        return fieldsText(fields)
    }

    /// Another runner asking for a thread (docs/protocol.md, "Asking
    /// another runner"): who's asking and where it would start, from the
    /// request as it was filed, never the card's own words.
    static func startRequestTitle(_ info: StartRequest?) -> NSAttributedString {
        let titleAttributes = Theme.text(Theme.cardTitleFont, line: TypeScale.scaled(20))
        let quiet = Theme.text(Theme.detailFont, color: Theme.quietText, line: TypeScale.scaled(19))
        guard let info else { return NSAttributedString(string: "Another machine wants to start a thread", attributes: titleAttributes) }
        if let error = info.error {
            let output = NSMutableAttributedString(string: "Couldn't read this request", attributes: titleAttributes)
            output.append(NSAttributedString(string: "\n" + error, attributes: quiet))
            return output
        }
        let place = info.startsOn.map { $0.isSelf ? "this Mac" : $0.name } ?? "this Mac"
        let output = NSMutableAttributedString(string: "\(info.request.runnerName) wants to start a thread on \(place)", attributes: titleAttributes)
        var notes: [String] = []
        if info.target == nil { notes.append("It asked for \u{201C}\(info.request.target)\u{201D}, which isn't one of your machines.") }
        if let why = info.request.why?.trimmingCharacters(in: .whitespacesAndNewlines), !why.isEmpty { notes.append(why) }
        if !notes.isEmpty { output.append(NSAttributedString(string: "\n" + notes.joined(separator: "\n"), attributes: quiet)) }
        return output
    }

    /// The folder, access and model it would start with, then the whole
    /// brief: what Mike allows is all of it.
    static func startRequestPayload(_ info: StartRequest?) -> NSAttributedString {
        let quiet = Theme.text(Theme.detailFont, color: Theme.quietText, line: TypeScale.scaled(19))
        guard let info, info.error == nil else { return NSAttributedString(string: info == nil ? "Reading the request\u{2026}" : "", attributes: quiet) }
        let r = info.request
        let access: String
        switch r.permissionMode {
        case "ask": access = "Asks before edits"
        case "auto": access = "Auto"
        case "plan": access = "Plan first"
        case nil, "", "full": access = "Full access"
        // The runner refuses a mode it doesn't know rather than starting
        // on full access, so the card says what was asked, not "Full".
        case let other?: access = "Unknown (\(other))"
        }
        var facts = ["Folder: \(r.cwd?.isEmpty == false ? r.cwd! : "the usual one")", "Access: \(access)"]
        if let model = r.model, !model.isEmpty { facts.append("Model: \(model)\(r.effort.map { ", \($0)" } ?? "")") }
        let output = NSMutableAttributedString(string: facts.joined(separator: "\n") + "\n\n", attributes: quiet)
        output.append(NSAttributedString(string: r.text, attributes: Theme.text(Theme.detailFont, color: .labelColor, line: TypeScale.scaled(19))))
        return output
    }

    /// A question's text: card title weight, quieter once it's answered so
    /// the answer under it is the brighter line.
    static func questionText(_ question: String, answered: Bool = false) -> NSAttributedString {
        NSAttributedString(string: question, attributes: Theme.text(Theme.cardTitleFont, color: answered ? Theme.quietText : .labelColor, line: TypeScale.scaled(20)))
    }

    /// What an answered question card says under the question: the answer
    /// (sent as the resolution's message), or how it ended.
    static func answerText(_ resolution: ApprovalResolution) -> NSAttributedString {
        let message = resolution.message.flatMap { firstLine($0).isEmpty ? nil : firstLine($0) }
        let text = resolution.decision == .answered ? (message ?? "Answered") : ApprovalText.decision(resolution.decision)
        let color: NSColor = resolution.decision == .answered ? .labelColor : Theme.quietText
        return NSAttributedString(string: text, attributes: [.font: Theme.workFont, .foregroundColor: color, .paragraphStyle: truncating])
    }

    /// A secret card's words: the label as its title and the agent's
    /// reason under it, quieter. No "Asking for a secret" line above it:
    /// that's an eyebrow label, and the field and promise say it already.
    /// One text view, so the reason can be selected and copied like any
    /// other text in the transcript.
    static func secretCardText(_ request: SecretRequest) -> NSAttributedString {
        let output = NSMutableAttributedString(string: request.label, attributes: Theme.text(Theme.cardTitleFont, line: TypeScale.scaled(20)))
        if !request.reason.isEmpty {
            output.append(NSAttributedString(string: "\n" + request.reason, attributes: Theme.text(Theme.detailFont, color: Theme.quietText, line: TypeScale.scaled(19))))
        }
        return output
    }

    /// The line under a secret card's field: the promise, or an error.
    static func secretNoteText(_ text: String, color: NSColor) -> NSAttributedString {
        NSAttributedString(string: text, attributes: Theme.text(Theme.smallFont, color: color, line: TypeScale.scaled(16)))
    }

    /// Decline's width, and so the room the note has before it.
    static var secretDeclineWidth: CGFloat {
        ceil(NSAttributedString(string: "Decline", attributes: [.font: Theme.labelFont]).size().width) + zoomed(12)
    }

    static func secretNoteWidth(inner: CGFloat) -> CGFloat {
        max(zoomed(80), inner - RowMetrics.titleIndent - secretDeclineWidth + zoomed(6) - zoomed(10))
    }

    /// "Mac administrator password · Saved securely": the label, then how
    /// it ended, as a work line.
    static func secretResolvedText(_ item: SecretItem) -> NSAttributedString {
        let style = truncating
        let output = NSMutableAttributedString(string: item.request.label, attributes: [
            .font: Theme.workFont, .foregroundColor: Theme.quietText, .paragraphStyle: style,
        ])
        let ending = (item.resolvedText ?? "").dropFirst(item.request.label.count)
        output.append(NSAttributedString(string: String(ending), attributes: [
            .font: Theme.workFont, .foregroundColor: Theme.faintText, .paragraphStyle: style,
        ]))
        return output
    }

    static func questionHeight(_ question: Question, textHeight: CGFloat) -> CGFloat {
        // The question's short `header` isn't shown: it would read as an eyebrow label.
        var height: CGFloat = textHeight + zoomed(8)
        for option in question.options {
            height += RowMetrics.optionHeight
            if let description = option.description, !description.isEmpty { height += RowMetrics.optionDescription }
        }
        return height + zoomed(12)
    }

    /// "2 of 5 steps done", then the steps. Every card starts with a
    /// one-line title; without one the plan read as an orphaned box of
    /// struck-through lines.
    /// The plan card's title: "Plan", or how far along its steps are.
    static func planCardTitle(_ card: PlanCard) -> NSAttributedString {
        let title = card.entries.isEmpty ? PlanCardText.split(card.text).title ?? "Plan" : PlanSummary.title(card.entries)
        return NSAttributedString(string: title, attributes: [.font: Theme.changesTitleFont, .foregroundColor: NSColor.labelColor])
    }

    /// What the plan card shows: the plan (its start, until it's opened),
    /// or once approved its checklist, with the plan under it when opened.
    static func planCardBody(_ card: PlanCard, expanded: Bool) -> NSAttributedString {
        let text = PlanCardText.split(card.text).body
        let plan = MarkdownRenderer.render(expanded ? text : PlanCardText.preview(text).text).string
        guard !card.entries.isEmpty else { return plan }
        let out = NSMutableAttributedString(attributedString: planSteps(card.entries))
        if expanded {
            out.append(NSAttributedString(string: "\n\n", attributes: [.font: Theme.bodyFont]))
            out.append(plan)
        }
        return out
    }

    static func planText(_ entries: [PlanEntry]) -> NSAttributedString {
        let (titleStyle, titleOffset) = Theme.lines(TypeScale.workLine, font: Theme.changesTitleFont, spacing: zoomed(8))
        let output = NSMutableAttributedString(string: PlanSummary.title(entries), attributes: [
            .font: Theme.changesTitleFont, .foregroundColor: NSColor.labelColor, .paragraphStyle: titleStyle, .baselineOffset: titleOffset,
        ])
        output.append(NSAttributedString(string: "\n", attributes: [.font: Theme.changesTitleFont, .paragraphStyle: titleStyle]))
        output.append(planSteps(entries))
        return output
    }

    /// A plan's steps, each ticked, under way or still to do.
    static func planSteps(_ entries: [PlanEntry]) -> NSAttributedString {
        let output = NSMutableAttributedString()
        let font = Theme.bodyFont
        let (style, offset) = Theme.lines(TypeScale.scaled(22), font: font, spacing: zoomed(4), head: zoomed(24), first: 0)
        style.tabStops = [NSTextTab(textAlignment: .left, location: zoomed(24))]
        for (index, entry) in entries.enumerated() {
            if index > 0 { output.append(NSAttributedString(string: "\n", attributes: [.font: font, .paragraphStyle: style, .baselineOffset: offset])) }
            let (mark, color, textColor): (String, NSColor, NSColor) = switch entry.status {
            case .completed: ("✓", Theme.addedText, .secondaryLabelColor)
            case .in_progress: ("●", .controlAccentColor, .labelColor)
            case .pending: ("○", Theme.faintText, .labelColor)
            }
            output.append(NSAttributedString(string: mark + "\t", attributes: [.font: font, .foregroundColor: color, .paragraphStyle: style, .baselineOffset: offset]))
            var attributes: [NSAttributedString.Key: Any] = [.font: font, .foregroundColor: textColor, .paragraphStyle: style, .baselineOffset: offset]
            if entry.status == .completed { attributes[.strikethroughStyle] = NSUnderlineStyle.single.rawValue }
            output.append(NSAttributedString(string: entry.text, attributes: attributes))
        }
        return output
    }

    /// Mike's bubble. One that answered asks from the card shows each
    /// question small and quiet, its answer as his own words, then
    /// whatever else he wrote, so it doesn't read as if he wrote the
    /// questions (Mike, 28 Oct). An answer to a review reads the same way:
    /// the review's title small, then what he picked and his notes, not
    /// the review's id and the wording the agent gets (Mike, 29 Oct).
    static func userText(_ message: UserMessage) -> NSAttributedString {
        cardChips(pictureChips(userWords(message), images: message.images))
    }

    /// Notion cards and threads mentioned in his words drawn as chips,
    /// rather than the raw Markdown link the message holds. A click opens
    /// the card like any other link, or the thread in the app, and the card's title is what the hover card and a Quote
    /// or Explain of it read.
    private static func cardChips(_ text: NSAttributedString) -> NSAttributedString {
        let found = CardMentions.find(in: text.string)
        guard !found.isEmpty else { return text }
        let out = NSMutableAttributedString(attributedString: text)
        for mention in found.reversed() {
            guard let url = URL(string: mention.url) else { continue }
            var attributes = out.attributes(at: mention.range.location, effectiveRange: nil)
            attributes[.attachment] = CardChip.attachment(title: mention.title, kind: mention.kind, font: attributes[.font] as? NSFont ?? Theme.bodyFont)
            // A thread: link opens that thread (WorkLinks); it has no page
            // for the hover card to show.
            attributes[.link] = url
            if mention.kind == .card { attributes[.tbPeek] = LinkPeek(url: url, title: mention.title) }
            attributes[.tbCardChip] = mention.title
            out.replaceCharacters(in: mention.range, with: NSAttributedString(string: "\u{FFFC}", attributes: attributes))
        }
        return out
    }

    /// His [Picture N] markers drawn as the chips he pasted
    /// (docs/protocol.md, "Pictures in a message"), with the pictures
    /// themselves over the words as before. Each is a link to its picture,
    /// which gives it the hover card, the drag and the right-click menu of
    /// any file link; TranscriptTextView opens a click in Quick Look.
    static func pictureChips(_ text: NSAttributedString, images: [ImageRef]) -> NSAttributedString {
        let found = InlinePictures.markers(in: text.string, imageCount: images.count)
        guard !found.isEmpty else { return text }
        let out = NSMutableAttributedString(attributedString: text)
        for marker in found.reversed() {
            var attributes = out.attributes(at: marker.range.location, effectiveRange: nil)
            attributes[.attachment] = PictureChip.attachment(number: marker.index + 1, font: attributes[.font] as? NSFont ?? Theme.bodyFont)
            attributes[.link] = URL(fileURLWithPath: images[marker.index].path)
            attributes[.tbPictureChip] = marker.index as NSNumber
            out.replaceCharacters(in: marker.range, with: NSAttributedString(string: "\u{FFFC}", attributes: attributes))
        }
        return out
    }

    private static func userWords(_ message: UserMessage) -> NSAttributedString {
        let plain = Theme.text()
        let lines: [(label: String, text: String)]
        let extra: String
        if let review = message.review {
            (lines, extra) = (review.lines.map { ($0.label, $0.text) }, "")
        } else if let rest = Decisions.extra(in: message.text, answers: message.answers) {
            (lines, extra) = (message.answers.map { ($0.action, $0.answer) }, rest)
        } else {
            return NSAttributedString(string: message.text.isEmpty ? " " : message.text, attributes: plain)
        }
        let output = NSMutableAttributedString()
        let question = Theme.text(Theme.smallFont, color: .secondaryLabelColor, line: TypeScale.scaled(18))
        let answer = Theme.text(spacing: zoomed(8))
        // The review's icon, as on its card, so the answer reads as the
        // same feature.
        if message.review != nil {
            output.append(symbol(Symbols.review, label: "Review", font: Theme.smallFont, attributes: question, color: .secondaryLabelColor))
            output.append(NSAttributedString(string: " ", attributes: question))
        }
        for (i, item) in lines.enumerated() {
            if i > 0 { output.append(NSAttributedString(string: "\n", attributes: answer)) }
            // A review's reply under its pick has no label of its own.
            if !item.label.isEmpty { output.append(NSAttributedString(string: item.label + "\n", attributes: question)) }
            // Line separators keep a written answer's lines in one paragraph,
            // so the gap between answers doesn't open up inside one.
            output.append(NSAttributedString(string: item.text.replacingOccurrences(of: "\n", with: "\u{2028}"), attributes: answer))
        }
        if !extra.isEmpty {
            output.append(NSAttributedString(string: "\n" + extra, attributes: plain))
        }
        return output
    }

    /// One ask on an open card as message text: `Decisions.paragraph` drawn
    /// by the markdown renderer, so its size, colour, links and code are a
    /// message's, and a numbered ask is a list item ("1." then a tab), with
    /// the newline that starts it.
    private static func askParagraph(_ ask: Ask, number: Int?) -> NSAttributedString {
        var text = Decisions.paragraph(ask)
        // Words that would start a heading, quote or list of their own
        // ("- " or "2. ") are the ask's words, not markdown.
        if text.range(of: #"^(#{1,6}\s|>|[-+*]\s|\d{1,9}[.)]\s|```|~~~|<)"#, options: .regularExpression) != nil { text = "\\" + text }
        let paragraph = NSMutableAttributedString(string: "\n", attributes: Theme.bodyAttributes)
        paragraph.append(MarkdownRenderer.renderBlock(number.map { Decisions.continued("\($0). " + text, under: "\($0). ") } ?? text))
        // A message's paragraph spacing, swapped for the card's at the ends:
        // 12 under what's above, close over its buttons. The paragraphs and
        // list items between keep the message's, so a list in the why
        // looks the way it would in the message.
        let ns = paragraph.string as NSString
        func style(at location: Int) -> NSMutableParagraphStyle {
            let base = location < ns.length ? paragraph.attribute(.paragraphStyle, at: location, effectiveRange: nil) as? NSParagraphStyle : nil
            return (base ?? NSParagraphStyle.default).mutableCopy() as! NSMutableParagraphStyle
        }
        let first = ns.paragraphRange(for: NSRange(location: min(1, ns.length), length: 0))
        let last = ns.paragraphRange(for: NSRange(location: ns.length - 1, length: 0))
        let opening = style(at: 1)
        opening.paragraphSpacingBefore = zoomed(12)
        if first == last { opening.paragraphSpacing = zoomed(2) }
        // From 0: the leading line break takes the first paragraph's style.
        paragraph.addAttribute(.paragraphStyle, value: opening, range: NSRange(location: 0, length: NSMaxRange(first)))
        if first != last {
            let closing = style(at: last.location)
            closing.paragraphSpacing = zoomed(2)
            paragraph.addAttribute(.paragraphStyle, value: closing, range: last)
        }
        return paragraph
    }

    /// A quiet line on an asks card (its where) as markdown, small, its
    /// links and paths still links.
    private static func noteText(_ text: String, font: NSFont, color: NSColor, style: NSParagraphStyle, offset: CGFloat) -> NSAttributedString {
        let note = NSMutableAttributedString(attributedString: MarkdownRenderer.render(text).string)
        // A one-line note has no trailing newline to keep.
        while note.string.hasSuffix("\n") { note.deleteCharacters(in: NSRange(location: note.length - 1, length: 1)) }
        let whole = NSRange(location: 0, length: note.length)
        note.enumerateAttributes(in: whole) { attributes, range, _ in
            let current = attributes[.font] as? NSFont
            let traits = current?.fontDescriptor.symbolicTraits ?? []
            let base = traits.contains(.monoSpace) ? NSFont.monospacedSystemFont(ofSize: font.pointSize * 0.95, weight: .regular) : font
            let sized = NSFontManager.shared.convert(base, toHaveTrait: traits.contains(.bold) ? .boldFontMask : [])
            note.addAttribute(.font, value: sized, range: range)
            if attributes[.link] == nil { note.addAttribute(.foregroundColor, value: color, range: range) }
        }
        note.addAttribute(.paragraphStyle, value: style, range: whole)
        note.addAttribute(.baselineOffset, value: offset, range: whole)
        return note
    }

    private struct AskButton {
        var title: String
        var action: String
        var style: AskButtonStyle
        var peek: LinkPeek?
    }

    /// The asks a turn ended on (docs/protocol.md, "Needs you"). Open, each
    /// is one paragraph of message text, its action then its why, as the
    /// agent would have written it under "What I need from you" (numbered
    /// like a list when there are several), then rows of buttons: its links
    /// (the first filled in, as the thing to do next) and its answers, the
    /// picked one filled and the agent's pick outlined. Buttons are
    /// `.tbAction` runs (`link:<ask>:<n>`, `pick:<ask>:<n>`) drawn by
    /// BackgroundLayoutManager. An ask with Something else picked gets room
    /// under its buttons for its own answer box (`.tbAnswerBox`), sized to
    /// what's in it at `width`. Closed, it's just the asks, quietly.
    ///
    /// With `page`, only that ask is drawn, and the heading line gets
    /// ‹ 2 of 3 › on its right (`page:<n>`): three asks with their buttons
    /// took most of the window's height (Mike, 30 Oct), so a tall card
    /// shows them one at a time (ComposerCardHost decides when).
    /// `collapsed` is the heading alone, with no pager.
    static func asksText(_ card: AsksCard, width: CGFloat = 600, page: Int? = nil, collapsed: Bool = false) -> NSAttributedString {
        if card.isDone { return doneText(card, width: width) }
        if collapsed { return asksHeading(card, width: width, page: nil) }
        let page = page.flatMap { card.isOpen && card.asks.indices.contains($0) ? $0 : nil }
        let output = asksHeading(card, width: width, page: page)
        let numbered = card.asks.count > 1
        // A numbered ask's text starts past its number, as in a list in a
        // message; its buttons line up with the text, not the number.
        let indent = numbered ? MarkdownRenderer.Builder.listIndent : 0
        let (closedStyle, closedOffset) = Theme.lines(TypeScale.bodyLine, font: Theme.bodyFont, spacing: zoomed(2), before: zoomed(12))
        let small = Theme.smallFont
        let (noteStyle, noteOffset) = Theme.lines(TypeScale.scaled(19), font: small, spacing: zoomed(2), head: indent)
        let button = Theme.labelFont
        // Tall lines, so a row of buttons that wraps keeps them apart.
        let (buttonStyle, buttonOffset) = Theme.lines(TypeScale.scaled(38), font: button, before: zoomed(6), head: indent)
        for (i, ask) in card.asks.enumerated() where page == nil || page == i {
            guard card.isOpen else {
                output.append(NSAttributedString(string: "\n" + (numbered ? "\(i + 1)  " : "") + ask.plainAction, attributes: [
                    .font: Theme.bodyFont, .foregroundColor: NSColor.secondaryLabelColor,
                    .paragraphStyle: closedStyle, .baselineOffset: closedOffset,
                ]))
                continue
            }
            output.append(askParagraph(ask, number: numbered ? i + 1 : nil))
            // An agent can still give where apart from the paragraph (older
            // sessions keep the old tool): a quiet line of its own, as a
            // place to go rather than part of the reason.
            if let place = ask.where_, !place.isEmpty {
                output.append(NSAttributedString(string: "\n", attributes: [.font: small, .paragraphStyle: noteStyle]))
                output.append(noteText(place, font: small, color: Theme.faintText, style: noteStyle, offset: noteOffset))
            }
            // Links on a row of their own, over the answers: going to look
            // comes before answering.
            var links: [AskButton] = []
            for (n, link) in ask.links.enumerated() {
                guard let target = link.target else { continue }
                // A review has nothing to peek at: its window is the look.
                let isReview = WorkLinks.reviewId(of: target) != nil
                links.append(AskButton(title: link.title + " ↗", action: "link:\(i):\(n)", style: n == 0 ? .primary : .plain,
                                       peek: isReview ? nil : LinkPeek(url: target, title: link.title)))
            }
            var answers = Decisions.choices(for: ask).enumerated().map { n, choice in
                let style: AskButtonStyle = card.picks[i] == n ? .picked : ask.suggested == n ? .suggested : .plain
                return AskButton(title: style == .picked ? "✓ " + choice : choice, action: "pick:\(i):\(n)", style: style)
            }
            // Always a way to answer in his own words (Mike, 28 Oct): what he
            // types in the composer becomes this ask's answer.
            let own = card.picks[i] == Decisions.ownAnswer
            answers.append(AskButton(title: own ? "✓ Something else" : "Something else…", action: "pick:\(i):\(Decisions.ownAnswer)", style: own ? .picked : .plain))
            // With one reply each answer says what it does, so they're rows
            // rather than buttons (docs/reply-card-design, option A).
            let rows = !ask.optionNotes.isEmpty
            if rows {
                if !links.isEmpty { appendButtons(links, to: output, font: button, style: buttonStyle, offset: buttonOffset) }
                output.append(answerRows(ask, index: i, picked: card.picks[i], indent: indent))
            }
            for row in rows ? [] : [links, answers] where !row.isEmpty {
                appendButtons(row, to: output, font: button, style: buttonStyle, offset: buttonOffset)
            }
            // Something else: room for its box, under the answers and lined
            // up with them, as tall as what's written and pasted in it.
            if own {
                let box = AskBoxMetrics.height(card.notes[i] ?? AskNote(), width: width - indent)
                let style = NSMutableParagraphStyle()
                style.minimumLineHeight = box + AskBoxMetrics.gap
                style.maximumLineHeight = box + AskBoxMetrics.gap
                style.headIndent = indent
                style.firstLineHeadIndent = indent
                output.append(NSAttributedString(string: "\n\u{00A0}", attributes: [
                    .font: button, .paragraphStyle: style, .tbAnswerBox: NSNumber(value: i),
                ]))
            }
        }
        return output
    }

    /// A line of the card's buttons: `.tbAction` runs that
    /// BackgroundLayoutManager draws as buttons.
    private static func appendButtons(_ row: [AskButton], to output: NSMutableAttributedString, font: NSFont, style: NSParagraphStyle, offset: CGFloat) {
        output.append(NSAttributedString(string: "\n", attributes: [.font: font, .paragraphStyle: style]))
        for (k, item) in row.enumerated() {
            if k > 0 { output.append(NSAttributedString(string: "    ", attributes: [.font: font, .paragraphStyle: style, .baselineOffset: offset])) }
            // Spaces inside the run are the button's padding; the
            // no-break ones keep a short title from wrapping apart.
            var attributes: [NSAttributedString.Key: Any] = [
                .font: font, .foregroundColor: item.style.textColor, .paragraphStyle: style, .baselineOffset: offset,
                .tbAction: item.action, .tbButton: item.style.rawValue,
            ]
            if let peek = item.peek { attributes[.tbPeek] = peek }
            output.append(NSAttributedString(string: "\u{00A0}\u{00A0}\u{00A0}" + item.title.replacingOccurrences(of: " ", with: "\u{00A0}") + "\u{00A0}\u{00A0}\u{00A0}", attributes: attributes))
        }
    }

    /// An ask's answers as rows (one reply, docs/reply-card-design A): a
    /// circle, the label, "my pick" on the agent's, and under it what
    /// picking it does, in a box with a line between rows, then "Something
    /// else…". The whole row is the click (`.tbRow`, `pick:<ask>:<n>`), as
    /// on the done card; picking fills its circle. Each row is one
    /// paragraph, its note after a line separator so it wraps under the
    /// label, not under the circle.
    private static func answerRows(_ ask: Ask, index i: Int, picked: Int?, indent: CGFloat) -> NSAttributedString {
        let output = NSMutableAttributedString()
        let font = Theme.bodyFont
        let small = Theme.smallFont
        let inset = rowInset + indent
        let words = inset + ceil(font.pointSize * 1.2) + zoomed(8)
        let choices = Decisions.choices(for: ask)
        let total = choices.count + 1
        // The line break that starts the first row ends the paragraph over
        // it, so it stays out of the box; the ones after belong to the row
        // they end, so the box runs unbroken from the first row to the last.
        var breakAttributes: [NSAttributedString.Key: Any] = [.font: font]
        for n in 0..<total {
            let own = n == choices.count
            let pick = own ? Decisions.ownAnswer : n
            let action = "pick:\(i):\(pick)"
            // Natural line heights, so a note's smaller line takes less room
            // than its label's: three answers with notes have to fit the
            // card's cap (ComposerCardHost.maxHeight).
            let style = NSMutableParagraphStyle()
            style.firstLineHeadIndent = inset
            style.headIndent = words
            style.tailIndent = -zoomed(8)
            style.lineSpacing = zoomed(2)
            style.paragraphSpacingBefore = zoomed(n == 0 ? 14 : 6)
            style.paragraphSpacing = zoomed(6)
            let offset: CGFloat = 0
            style.tabStops = [NSTextTab(textAlignment: .left, location: words)]
            var attributes: [NSAttributedString.Key: Any] = [
                .font: font, .foregroundColor: own ? NSColor.secondaryLabelColor : NSColor.labelColor, .paragraphStyle: style, .baselineOffset: offset,
                .tbAction: action, .tbRow: action, .tbBlockBackground: Theme.answerRowsFill,
            ]
            if n > 0 { attributes[.tbRowRule] = true }
            breakAttributes[.paragraphStyle] = breakAttributes[.paragraphStyle] ?? style
            output.append(NSAttributedString(string: "\n", attributes: breakAttributes))
            let isPicked = picked == pick
            let isSuggested = !own && ask.suggested == n
            output.append(isPicked
                ? symbol("checkmark.circle.fill", label: "Picked", font: font, attributes: attributes, color: .controlAccentColor)
                : symbol("circle", label: "Not picked", font: font, attributes: attributes, color: isSuggested ? .controlAccentColor : Theme.faintText))
            output.append(NSAttributedString(string: "\t" + (own ? "Something else…" : choices[n]), attributes: attributes))
            if isSuggested {
                var pickAttributes = attributes
                pickAttributes[.font] = small
                pickAttributes[.foregroundColor] = NSColor.controlAccentColor
                output.append(NSAttributedString(string: "  my pick", attributes: pickAttributes))
            }
            if !own, n < ask.optionNotes.count, !ask.optionNotes[n].isEmpty {
                var noteAttributes = attributes
                noteAttributes[.font] = small
                noteAttributes[.foregroundColor] = NSColor.secondaryLabelColor
                output.append(NSAttributedString(string: "\u{2028}" + PreviewText.plain(ask.optionNotes[n]), attributes: noteAttributes))
            }
            // The next row's break is this row's last character.
            breakAttributes = attributes
            breakAttributes.removeValue(forKey: .tbRowRule)
        }
        // The box reaches the code-block pad below the last row's words,
        // past where the card measures to (its last line), so a line of
        // that height under it keeps the box's bottom edge in the card.
        let spacer = NSMutableParagraphStyle()
        spacer.minimumLineHeight = MarkdownRenderer.codePad + zoomed(2)
        spacer.maximumLineHeight = MarkdownRenderer.codePad + zoomed(2)
        output.append(NSAttributedString(string: "\n", attributes: breakAttributes))
        output.append(NSAttributedString(string: "\u{200B}", attributes: [.font: small, .paragraphStyle: spacer]))
        return output
    }

    /// The asks card's heading. Open, it's a raised hand in the sidebar's
    /// Needs you orange and what's wanted, so it reads as a title over
    /// the asks: a plain "Needs you" was easy to miss (Mike, 30 Oct).
    /// "Decisions needed" when every ask came with answers to pick from,
    /// as most do. On a paged card the line is a button tall, with the
    /// pager on a right tab, clear of the collapse chevron ComposerCardHost
    /// puts at the line's end; past either end its arrow is faint and does
    /// nothing.
    private static func asksHeading(_ card: AsksCard, width: CGFloat, page: Int?) -> NSMutableAttributedString {
        let title = Theme.changesTitleFont
        guard card.isOpen else {
            let (style, offset) = Theme.lines(TypeScale.workLine, font: title, spacing: zoomed(6))
            return NSMutableAttributedString(string: "Needed you", attributes: [
                .font: title, .foregroundColor: NSColor.secondaryLabelColor, .paragraphStyle: style, .baselineOffset: offset,
            ])
        }
        let button = Theme.labelFont
        let style: NSMutableParagraphStyle
        let offset: CGFloat
        var buttonOffset: CGFloat = 0
        if page != nil {
            let height = TypeScale.scaled(38)
            (style, buttonOffset) = Theme.lines(height, font: button)
            style.tabStops = [NSTextTab(textAlignment: .right, location: width - 1 - ComposerCardHost.toggleSize - zoomed(6))]
            offset = Theme.baselineOffset(height, font: title)
        } else {
            (style, offset) = Theme.lines(TypeScale.workLine, font: title, spacing: zoomed(6))
        }
        let attributes: [NSAttributedString.Key: Any] = [
            .font: title, .foregroundColor: NSColor.labelColor, .paragraphStyle: style, .baselineOffset: offset,
        ]
        let decisions = card.asks.allSatisfy { !$0.options.isEmpty }
        let words = !decisions ? "Needed from you" : card.asks.count == 1 ? "Decision needed" : "Decisions needed"
        let output = NSMutableAttributedString()
        output.append(symbol("hand.raised.fill", label: "Needs you", font: title, attributes: attributes, color: Theme.needsYou))
        output.append(NSAttributedString(string: " " + words, attributes: attributes))
        guard let page else { return output }
        output.append(NSAttributedString(string: "\t", attributes: attributes))
        let arrow = { (glyph: String, to: Int) -> NSAttributedString in
            var arrow: [NSAttributedString.Key: Any] = [.font: button, .paragraphStyle: style, .baselineOffset: buttonOffset]
            if card.asks.indices.contains(to) {
                arrow[.tbAction] = "page:\(to)"
                arrow[.tbButton] = AskButtonStyle.plain.rawValue
                arrow[.foregroundColor] = AskButtonStyle.plain.textColor
            } else {
                arrow[.foregroundColor] = Theme.faintText
            }
            return NSAttributedString(string: "\u{00A0}\u{00A0}" + glyph + "\u{00A0}\u{00A0}", attributes: arrow)
        }
        output.append(arrow("‹", page - 1))
        output.append(NSAttributedString(string: "\u{00A0}\u{00A0}\(page + 1) of \(card.asks.count)\u{00A0}\u{00A0}", attributes: [
            .font: button, .foregroundColor: NSColor.secondaryLabelColor, .paragraphStyle: style, .baselineOffset: buttonOffset,
        ]))
        output.append(arrow("›", page + 1))
        return output
    }

    /// Where a paged card's page number is in its text: the 2 of "2 of 3",
    /// which `asksHeading` sets off with non-breaking spaces, so an ask's
    /// own "2 of 3" further on isn't taken for it.
    static func pageNumberRange(in text: String) -> NSRange? {
        guard let match = text.range(of: "\u{00A0}\u{00A0}[0-9]+ of [0-9]+\u{00A0}\u{00A0}", options: .regularExpression) else { return nil }
        let found = text[match].drop { !$0.isNumber }.prefix { $0.isNumber }
        return NSRange(found.startIndex..<found.endIndex, in: text)
    }

    /// The done card: the agent said nothing waits on Mike, so it says
    /// Done, with Archive (`archive`, as ⌘E does) at the right of that
    /// line. Any follow-ups it suggested sit under "Or carry on", one
    /// row each with a tick circle, and a click ticks or unticks one
    /// (`next:<n>`): ticked ones go with his next message, so he can pick
    /// several and add to them (30 Oct). Mike found
    /// "Nothing needed from you" over a list of ticks confusing (30 Oct):
    /// it read as things to do. Now the card offers the real choice, put
    /// it away or keep going, and he picked this from mockups. Rows rather
    /// than buttons, as a long one broke into two buttons; the pointer
    /// lights up the whole row (`.tbRow`). The follow-ups go once he's
    /// replied, like an ask's answers. A "?" at each row's right asks
    /// the agent what it meant, as one can come out of nowhere (31 Oct);
    /// it toggles too and goes with the ticks, so he can ask about
    /// several at once (1 Nov).
    private static func doneText(_ card: AsksCard, width: CGFloat) -> NSAttributedString {
        let title = Theme.changesTitleFont
        let button = Theme.labelFont
        // One line as tall as the button, with Archive on a right tab.
        let height = TypeScale.scaled(38)
        let (lineStyle, buttonOffset) = Theme.lines(height, font: button)
        lineStyle.tabStops = [NSTextTab(textAlignment: .right, location: width - 1)]
        let titleOffset = Theme.baselineOffset(height, font: title)
        let output = NSMutableAttributedString()
        let titleAttributes: [NSAttributedString.Key: Any] = [
            .font: title, .foregroundColor: card.isOpen ? NSColor.labelColor : NSColor.secondaryLabelColor,
            .paragraphStyle: lineStyle, .baselineOffset: titleOffset,
        ]
        output.append(symbol("checkmark", label: "Done", font: title, attributes: titleAttributes, color: .systemGreen))
        output.append(NSAttributedString(string: " Done", attributes: titleAttributes))
        // The runner checked and found nothing left (protocol "Loose
        // ends"): said beside Done, so Archive reads as safe without
        // asking the agent first (the nightly retro, 6 Nov).
        let ends = card.isOpen ? card.looseEnds : nil
        if let ends, !ends.contains(where: { !$0.isBooked }) {
            let small = Theme.smallFont
            output.append(NSAttributedString(string: "\u{00A0}\u{00A0}\u{00A0}Nothing left open", attributes: [
                .font: small, .foregroundColor: NSColor.secondaryLabelColor, .paragraphStyle: lineStyle, .baselineOffset: Theme.baselineOffset(height, font: small),
            ]))
        }
        output.append(NSAttributedString(string: "\t", attributes: titleAttributes))
        output.append(NSAttributedString(string: "\u{00A0}\u{00A0}\u{00A0}Archive\u{00A0}\u{00A0}\u{00A0}", attributes: [
            .font: button, .foregroundColor: AskButtonStyle.plain.textColor, .paragraphStyle: lineStyle, .baselineOffset: buttonOffset,
            .tbAction: "archive", .tbButton: AskButtonStyle.plain.rawValue,
        ]))
        guard card.isOpen else { return output }
        let small = Theme.smallFont
        // The rows and their label sit in by the hover fill's padding, as
        // the text view clips anything drawn left of its text.
        let inset = rowInset
        let (labelStyle, labelOffset) = Theme.lines(TypeScale.scaled(19), font: small, before: zoomed(10), head: inset)
        if let ends, !ends.isEmpty { output.append(looseEndsText(ends, inset: inset, labelStyle: labelStyle, labelOffset: labelOffset)) }
        guard !card.next.isEmpty else { return output }
        output.append(NSAttributedString(string: "\nOr carry on", attributes: [
            .font: small, .foregroundColor: NSColor.secondaryLabelColor, .paragraphStyle: labelStyle, .baselineOffset: labelOffset,
        ]))
        let font = Theme.bodyFont
        // The words start on a tab past the circle, and a long one wraps
        // in line with them rather than under the circle.
        let words = inset + ceil(font.pointSize * 1.2) + zoomed(8)
        // The words stop short of the "?" the cell puts at the right
        // (TextRowCell.placeExplainButtons).
        let (rowStyle, rowOffset) = Theme.lines(TypeScale.bodyLine, font: font, spacing: zoomed(8), before: zoomed(8), head: words, first: inset, tail: -(inset + explainRoom + zoomed(8)))
        rowStyle.tabStops = [NSTextTab(textAlignment: .left, location: words)]
        for (n, text) in card.next.enumerated() {
            // The break ends the line before, so it isn't part of the row.
            output.append(NSAttributedString(string: "\n", attributes: [.font: font, .paragraphStyle: rowStyle]))
            let attributes: [NSAttributedString.Key: Any] = [
                .font: font, .foregroundColor: NSColor.labelColor, .paragraphStyle: rowStyle, .baselineOffset: rowOffset,
                .tbAction: "next:\(n)", .tbRow: "next:\(n)",
            ]
            let ticked = card.pickedNext.contains(n)
            output.append(ticked
                ? symbol("checkmark.circle.fill", label: "Ticked", font: font, attributes: attributes, color: .controlAccentColor)
                : symbol("circle", label: "Not ticked", font: font, attributes: attributes))
            output.append(NSAttributedString(string: "\t" + text, attributes: attributes))
        }
        return output
    }

    /// The done card's loose ends (protocol "Loose ends"): what the runner
    /// found still open, under "Still open", one line each. A thread one
    /// links to it; a booked check-in says when it comes back, and alone
    /// sits under "Coming back", as it doesn't stop an archive. Plain
    /// lines, not buttons: the Land chip above the composer lands a branch.
    private static func looseEndsText(_ ends: [LooseEnd], inset: CGFloat, labelStyle: NSParagraphStyle, labelOffset: CGFloat) -> NSAttributedString {
        let output = NSMutableAttributedString()
        let small = Theme.smallFont
        let open = ends.contains { !$0.isBooked }
        output.append(NSAttributedString(string: open ? "\nStill open" : "\nComing back", attributes: [
            .font: small, .foregroundColor: NSColor.secondaryLabelColor, .paragraphStyle: labelStyle, .baselineOffset: labelOffset,
        ]))
        let font = Theme.bodyFont
        let words = inset + ceil(font.pointSize * 1.2) + zoomed(8)
        let (rowStyle, rowOffset) = Theme.lines(TypeScale.bodyLine, font: font, spacing: zoomed(4), before: zoomed(4), head: words, first: inset)
        rowStyle.tabStops = [NSTextTab(textAlignment: .left, location: words)]
        // Open ones first, then the check-ins.
        for end in ends.filter({ !$0.isBooked }) + ends.filter(\.isBooked) {
            output.append(NSAttributedString(string: "\n", attributes: [.font: font, .paragraphStyle: rowStyle]))
            var attributes: [NSAttributedString.Key: Any] = [.font: font, .foregroundColor: NSColor.labelColor, .paragraphStyle: rowStyle, .baselineOffset: rowOffset]
            output.append(end.isBooked
                ? symbol("clock", label: "Booked", font: font, attributes: attributes)
                : symbol("exclamationmark.circle", label: "Still open", font: font, attributes: attributes, color: .systemOrange))
            var text = end.text
            if end.isBooked, let when = end.at.flatMap(ISO8601.parse) { text = "\(bookedFormat.string(from: when)): \(text)" }
            if let id = end.threadId, let url = URL(string: "thread:\(id)") { attributes[.link] = url }
            output.append(NSAttributedString(string: "\t" + text, attributes: attributes))
        }
        return output
    }

    /// "Fri 13 Nov, 9:30 am", for when a booked check-in comes back.
    private static let bookedFormat: DateFormatter = {
        let f = DateFormatter()
        f.setLocalizedDateFormatFromTemplate("EEE d MMM h:mm a")
        return f
    }()

    /// How far a follow-up row's words sit in from its hover fill.
    static var rowInset: CGFloat { zoomed(8) }

    /// The room at a follow-up row's right for its "?", which turns on
    /// asking the agent what it meant (`explain:<n>`).
    static var explainRoom: CGFloat { zoomed(22) }

    /// A plain sentence for a failure whose cause the runner gave.
    static func errorAdvice(_ kind: TurnErrorKind?) -> String? {
        switch kind {
        case .contextWindow?: return "The conversation is too long for this model. Start a new thread to carry on."
        case .auth?: return "Its login was refused. Sign in again from the line above, then send again."
        case .network?: return "The internet dropped. This thread carries on by itself once the connection is back."
        case .usageLimit?, nil: return nil
        }
    }

    /// "12s · $0.04" for Claude, "12s" for Codex, which reports no cost
    /// (its tokens are in "Copy debug info" instead).
    static func footerText(_ completion: TurnCompletion) -> NSAttributedString {
        // "Done" is the done card's now, under this line.
        var parts: [String] = []
        switch completion.outcome {
        case .completed: parts.append(RelativeTime.duration(milliseconds: completion.durationMs))
        case .interrupted: parts.append("Stopped after \(RelativeTime.duration(milliseconds: completion.durationMs))")
        case .failed: parts.append("Failed after \(RelativeTime.duration(milliseconds: completion.durationMs))")
        }
        if let cost = CostText.format(completion.costUsd) { parts.append(cost) }
        var text = parts.joined(separator: " · ")
        // A failure the runner knows the cause of has its error row just
        // above, with the same words and what to do; saying them a third
        // time here was noise (Mike, 2 Nov 2026).
        if let error = completion.error, !error.isEmpty, completion.errorKind == nil { text += ": " + firstLine(error) }
        return NSAttributedString(string: text, attributes: [
            .font: Theme.smallFont,
            .foregroundColor: completion.outcome == .failed ? NSColor.systemRed : Theme.faintText,
            .paragraphStyle: truncating,
        ])
    }

    // MARK: Images

    /// Lays images out in rows, each fitted to `maxHeight` and the grid's
    /// cell width, with the images in a row at one height
    /// (`ImageLayout`).
    static func imageFrames(_ images: [ImageRef], maxWidth: CGFloat, maxHeight: CGFloat, cellWidth: CGFloat = RowMetrics.gridMaxWidth,
                            alignRight: Bool) -> ([NSRect], CGFloat) {
        let layout = ImageLayout.frames(sizes: images.map(pixelSize), maxWidth: maxWidth, maxHeight: maxHeight,
                                        cellWidth: cellWidth, gap: RowMetrics.imageGap, alignRight: alignRight)
        return (layout.frames, layout.height)
    }

    nonisolated(unsafe) private static let sizeCache = NSCache<NSString, NSValue>()

    static func pixelSize(_ image: ImageRef) -> NSSize {
        if let width = image.width, let height = image.height, width > 0, height > 0 {
            return NSSize(width: width, height: height)
        }
        if let cached = sizeCache.object(forKey: image.path as NSString) { return cached.sizeValue }
        var size = NSSize(width: 160, height: 120)
        if let header = ImageSize.read(path: image.path) {
            size = NSSize(width: header.width, height: header.height)
        }
        sizeCache.setObject(NSValue(size: size), forKey: image.path as NSString)
        return size
    }
}
