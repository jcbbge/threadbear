import AppKit
import SwiftUI
import ThreadbearCore

@MainActor
protocol RowCellDelegate: AnyObject {
    func toggleExpanded(rowId: String)
    func toggleChangedFile(turnId: String, path: String)
    /// "Show 30 more lines" under an opened diff: `key` is the diff's
    /// `DiffPreview.allKey`.
    func showAllLines(_ key: String)
    func respond(approvalId: String, decision: ApprovalDecision, answers: [String: String]?, message: String?)
    /// Another runner's request for a thread: read it for its card.
    func loadStartRequest(_ approvalId: String)
    /// The card's answer is on its way: a spinner, and no more clicks.
    func isAnswering(_ approvalId: String) -> Bool
    func questionDraft(_ approvalId: String) -> [Int: Set<String>]
    func setQuestionDraft(_ approvalId: String, _ draft: [Int: Set<String>])
    /// A secret card (docs/protocol.md, "Secrets"): where its answer is,
    /// and sending one. The value goes straight to `secrets.answer`; the
    /// delegate never keeps it.
    func secretState(_ approvalId: String) -> SecretCardState
    func answerSecret(approvalId: String, _ answer: SecretAnswer)
    /// Mike typed again after a failed send: the error goes.
    func secretEdited(_ approvalId: String)
    /// A click on an asks card: `tick:<index>` or `reply:<index>`.
    func askAction(_ card: AsksCard, action: String)
    /// An ask's Something else box on the open card (AskAnswerBox): what's
    /// in it changed, or pictures were added to it.
    func askNoteChanged(_ card: AsksCard, ask: Int, note: AskNote)
    func askNoteImages(_ card: AsksCard, ask: Int, urls: [URL])
    /// Pictures pasted, dropped or chosen in a box go in as chips: whether
    /// this thread can take them (saying why not), and each one copied in.
    func askPicturesAllowed(_ card: AsksCard) -> Bool
    func askImportPicture(_ card: AsksCard, url: URL) async -> ImageRef?
    func sendAnswers(_ card: AsksCard)
    /// Return in ask `ask`'s box: on to the next unanswered ask, or send
    /// (⌘Return, or nothing left unanswered).
    func answerBoxReturn(_ card: AsksCard, ask: Int, command: Bool)
    func openReview(_ review: DesignReview)
    /// Whether a "Woke up" note should play its bear waking up: only the
    /// thread's newest, once, the first time it's seen after waking.
    func claimWakeUp(rowId: String) -> Bool
    /// The pencil by one of Mike's messages: edit it and carry on from
    /// there (docs/protocol.md, "Editing a message").
    func editMessage(rowId: String)
    /// A work:, thread: or review: link in row `rowId`'s text (WorkLinks): open the
    /// step in that turn's working, or the other thread.
    func openThreadLink(_ url: URL, fromRow rowId: String)
    /// A "Plan first" plan card: Go ahead approves it (plans.approve); Send
    /// back puts Mike in the composer, as anything he writes sends it back.
    func approvePlan(itemId: String)
    func sendBackPlan()
    /// For a thread on another runner ("bruce"): its pictures are files
    /// on that Mac, fetched through this. Nil for this Mac's own.
    var remoteImages: RemoteImages? { get }
    /// The thread the row is in, which its links are followed in.
    var linkThreadId: String? { get }
}

extension RowCellDelegate {
    var remoteImages: RemoteImages? { nil }
    var linkThreadId: String? { nil }
    func secretState(_ approvalId: String) -> SecretCardState { .ready }
    func isAnswering(_ approvalId: String) -> Bool { false }
    func answerSecret(approvalId: String, _ answer: SecretAnswer) {}
    func secretEdited(_ approvalId: String) {}
    func askNoteChanged(_ card: AsksCard, ask: Int, note: AskNote) {}
    func askNoteImages(_ card: AsksCard, ask: Int, urls: [URL]) {}
    func askPicturesAllowed(_ card: AsksCard) -> Bool { false }
    func askImportPicture(_ card: AsksCard, url: URL) async -> ImageRef? { nil }
    func sendAnswers(_ card: AsksCard) {}
    func answerBoxReturn(_ card: AsksCard, ask: Int, command: Bool) {}
    func openReview(_ review: DesignReview) {}
    func claimWakeUp(rowId: String) -> Bool { false }
    func editMessage(rowId: String) {}
    func openThreadLink(_ url: URL, fromRow rowId: String) {}
    func approvePlan(itemId: String) {}
    func sendBackPlan() {}
}

/// Base for transcript cells: flipped, so layout reads top-down.
class RowCellView: NSTableCellView {
    weak var delegate: RowCellDelegate?
    // The header, group and changes rows open on a press of their own: those
    // count while Threadbear isn't the app in front too (FirstClick.swift).
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
    var rowId = ""

    override var isFlipped: Bool { true }

    override init(frame frameRect: NSRect) {
        super.init(frame: frameRect)
        hover.isHidden = true
    }

    required init?(coder: NSCoder) { fatalError() }

    func configure(row: TranscriptRow, render: RowRender, tableWidth: CGFloat, expanded: Bool) {
        rowId = row.id
    }

    /// Called when the table takes the row off screen: let go of images and
    /// drawn text so parked cells cost little. `configure` or
    /// `updateSlices(force:)` restores them.
    func releaseContent() {}

    /// Moves tall text views' drawn slices to what's on screen.
    func updateSlices(force: Bool = false) {}

    // MARK: Hover

    /// A faint rounded fill behind `hoverRect` while the pointer is over it,
    /// for rows that open on a click. Cells that use it add `hover` first,
    /// so it sits behind their content.
    let hover = FillView()
    var hoverRect = NSRect.zero {
        didSet { updateHover() }
    }
    private var pointer: NSPoint?
    private var tracking: NSTrackingArea?

    override func updateTrackingAreas() {
        super.updateTrackingAreas()
        guard tracking == nil else { return }
        let area = NSTrackingArea(rect: .zero, options: [.mouseEnteredAndExited, .mouseMoved, .activeInKeyWindow, .inVisibleRect], owner: self)
        addTrackingArea(area)
        tracking = area
    }

    override func mouseEntered(with event: NSEvent) { pointer = convert(event.locationInWindow, from: nil); updateHover() }
    override func mouseMoved(with event: NSEvent) { pointer = convert(event.locationInWindow, from: nil); updateHover() }
    override func mouseExited(with event: NSEvent) { pointer = nil; updateHover() }

    override func prepareForReuse() {
        super.prepareForReuse()
        pointer = nil
        updateHover()
        // A recycled cell mustn't carry a lift on to some other row.
        layer?.removeAnimation(forKey: SendLift.key)
    }

    #if DEBUG
    /// The automation hook's `hover`: draws the row as if the pointer were
    /// over the part a click opens. Returns false for a row with none.
    func debugHover(_ on: Bool) -> Bool {
        guard !on || hoverRect != .zero else { return false }
        pointer = on ? NSPoint(x: hoverRect.midX, y: hoverRect.midY) : nil
        updateHover()
        return true
    }
    #endif

    private func updateHover() {
        let on = hoverRect != .zero && pointer.map { hoverRect.contains($0) } == true
        if hover.isHidden == on { hover.isHidden = !on }
        if on, hover.frame != hoverRect {
            hover.frame = hoverRect
            hover.set(fill: Theme.hoverFill, stroke: nil, radius: zoomed(6))
        }
    }
}

/// A rounded box drawn in `draw(_:)`, so its dynamic colours follow light
/// and dark mode by themselves (layer colours have to be re-resolved).
final class FillView: NSView {
    // Clicks count while Threadbear isn't the app in front (FirstClick.swift).
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }

    var fill: NSColor? { didSet { needsDisplay = true } }
    var stroke: NSColor? { didSet { needsDisplay = true } }
    var radius: CGFloat = 8 { didSet { needsDisplay = true } }
    /// A bar down the left edge, following the rounded corners (cards that
    /// need Mike).
    var accent: NSColor? { didSet { needsDisplay = true } }

    override var isFlipped: Bool { true }
    override var isOpaque: Bool { false }

    func set(fill: NSColor?, stroke: NSColor?, radius: CGFloat, accent: NSColor? = nil) {
        if self.fill != fill { self.fill = fill }
        if self.stroke != stroke { self.stroke = stroke }
        if self.radius != radius { self.radius = radius }
        if self.accent != accent { self.accent = accent }
    }

    override func draw(_ dirtyRect: NSRect) {
        if radius == 0 {
            // A plain fill (a hairline rule): no inset, or a 0.5 pt rule
            // would have no height left to fill.
            fill?.setFill()
            bounds.fill()
            return
        }
        let rect = bounds.insetBy(dx: 0.25, dy: 0.25)
        let corner = min(radius, rect.height / 2)
        let path = NSBezierPath(roundedRect: rect, xRadius: corner, yRadius: corner)
        if let fill {
            fill.setFill()
            path.fill()
        }
        if let stroke {
            stroke.setStroke()
            path.lineWidth = 0.5
            path.stroke()
        }
        if let accent {
            // The card's own left edge in the accent colour, drawn over the
            // border and clipped to the corners: a capsule floating inside
            // the card read as a quote rule in a box, with the grey border
            // still running down the edge beside it.
            NSGraphicsContext.saveGraphicsState()
            NSBezierPath(roundedRect: bounds, xRadius: corner, yRadius: corner).addClip()
            accent.setFill()
            NSRect(x: 0, y: 0, width: RowMetrics.accentBar, height: bounds.height).fill()
            NSGraphicsContext.restoreGraphicsState()
        }
    }
}

/// Symbol images, made once: a new NSImage or tint makes an image view
/// rasterize its symbol again, which was the biggest main-thread cost of a
/// fast scroll (about 14%).
@MainActor
enum Symbols {
    private static var cache: [String: NSImage] = [:]

    /// Comparing the agent's images (show_options): the button to open
    /// waiting ones, the card, the panel's tab and Mike's answer all wear
    /// it, so they read as one feature (Mike, 29 Oct).
    nonisolated static let review = "rectangle.on.rectangle"

    /// `size` is the design size; the image is made at the zoom's.
    static func image(_ name: String, size: CGFloat = 12, weight: NSFont.Weight = .regular) -> NSImage? {
        let size = zoomed(size)
        let key = "\(name)|\(size)|\(weight.rawValue)"
        if let cached = cache[key] { return cached }
        let image = NSImage(systemSymbolName: name, accessibilityDescription: nil)?
            .withSymbolConfiguration(NSImage.SymbolConfiguration(pointSize: size, weight: weight))
        cache[key] = image
        return image
    }

    static func set(_ view: NSImageView, _ name: String, size: CGFloat = 12, weight: NSFont.Weight = .regular, tint: NSColor) {
        let image = self.image(name, size: size, weight: weight)
        if view.image !== image { view.image = image }
        if view.contentTintColor != tint { view.contentTintColor = tint }
    }

    static func makeView() -> NSImageView {
        let view = FirstClickImageView()
        view.imageScaling = .scaleNone
        view.imageAlignment = .alignCenter
        return view
    }
}

/// A one-line, truncating label.
@MainActor
func makeLabel() -> NSTextField {
    let label = NSTextField(labelWithString: "")
    label.lineBreakMode = .byTruncatingTail
    label.maximumNumberOfLines = 1
    label.cell?.truncatesLastVisibleLine = true
    return label
}

// MARK: - Text rows: user, assistant, plan, note, error, footer

final class TextRowCell: RowCellView {
    let textView = TranscriptTextView()
    let box = FillView()
    let images = ImageGridView()
    /// The pencil left of an editable message of Mike's, shown while the
    /// pointer is over the row.
    let edit = NSButton()
    /// Left of a message still on its way to the runner: a spinner while
    /// it's sent, a clock once it's queued behind the running turn.
    let pendingMark = PendingMark()
    /// Left of a message Mike sent from the iPhone app: a small phone, its
    /// tip saying so on hover or click, in place of a line of text.
    let phoneMark = NSButton()
    private var editable = false
    private var pointerInside = false
    /// Left of the words of a "Woke up" note. Made the first time one's
    /// shown, as hardly any text rows ever need it.
    private var wokenBear: WokenBearView?
    /// The open card's Something else boxes, by ask, over the room its
    /// text leaves for them; kept while the cell is, so typing in one
    /// survives the card being laid out again around it.
    private var answerBoxes: [Int: AskAnswerBox] = [:]
    /// The open card the boxes belong to, as last shown.
    private var answerCard: AsksCard?
    /// The "?" at the right of each of the open done card's follow-ups,
    /// by index, over the room its row leaves (`RowRenderer.explainRoom`).
    /// Real buttons rather than `.tbAction` runs, so they get a tip.
    private var explainButtons: [Int: NSButton] = [:]
    /// Screenshots show the pencil without a real hover.
    static var debugShowEdit = false
    private var shownBlocks: [String] = []
    private var shownStarts: [Int] = []
    private var shownRowId = ""
    /// The zoom the shown text was rendered at: a pooled cell can get the
    /// same row back after a zoom change, with its blocks still matching.
    private var shownZoom = 0
    /// Draws an asks card with no box of its own, filling the cell: the
    /// open card at the top of the composer (ComposerCard), whose box
    /// is the composer's.
    var bare = false

    override init(frame frameRect: NSRect) {
        super.init(frame: frameRect)
        addSubview(box)
        addSubview(textView)
        addSubview(images)
        edit.isBordered = false
        edit.bezelStyle = .regularSquare
        edit.imagePosition = .imageOnly
        edit.target = self
        edit.action = #selector(editClicked)
        edit.isHidden = true
        edit.setTip("Edit this message and carry on from here")
        edit.setAccessibilityLabel("Edit message")
        addSubview(edit)
        pendingMark.isHidden = true
        addSubview(pendingMark)
        phoneMark.isBordered = false
        phoneMark.bezelStyle = .regularSquare
        phoneMark.imagePosition = .imageOnly
        phoneMark.target = self
        phoneMark.action = #selector(phoneClicked)
        phoneMark.isHidden = true
        phoneMark.setTip("Sent from the iPhone app")
        phoneMark.setAccessibilityLabel("Sent from the iPhone app")
        addSubview(phoneMark)
    }

    required init?(coder: NSCoder) { fatalError() }

    @objc private func phoneClicked() {
        phoneMark.showTipNow()
    }

    @objc private func editClicked() {
        delegate?.editMessage(rowId: rowId)
    }

    override func mouseEntered(with event: NSEvent) {
        super.mouseEntered(with: event)
        pointerInside = true
        updateEdit()
    }

    override func mouseExited(with event: NSEvent) {
        super.mouseExited(with: event)
        pointerInside = false
        updateEdit()
    }

    override func prepareForReuse() {
        super.prepareForReuse()
        pointerInside = false
        updateEdit()
    }

    private func placeWokenBear(_ row: TranscriptRow, x: CGFloat, width: CGFloat, textSize: NSSize, changedRow: Bool) {
        guard row.content.isWakeNote else {
            if let wokenBear, !wokenBear.isHidden {
                wokenBear.settle()
                wokenBear.isHidden = true
            }
            return
        }
        let bear = wokenBear ?? {
            let bear = WokenBearView()
            addSubview(bear)
            wokenBear = bear
            return bear
        }()
        bear.isHidden = false
        bear.tint = Theme.quietText
        bear.hat = BearGeometry.wearsHat()
        let side = RowMetrics.wokenBearSide
        // Level with the first line, whatever the row's grown to.
        let line = TypeScale.scaled(17)
        bear.frame = NSRect(x: x + (width - textSize.width) / 2 - RowMetrics.wokenBearRoom, y: RowMetrics.rowTop + (line - side) / 2, width: side, height: side)
        if changedRow { bear.settle() }
        if delegate?.claimWakeUp(rowId: row.id) == true { bear.wakeUp() }
    }

    private func updateEdit() {
        let show = editable && (pointerInside || Self.debugShowEdit)
        if edit.isHidden == show { edit.isHidden = !show }
    }

    #if DEBUG
    /// A message of Mike's has no hover fill, but shows its pencil. A
    /// done card lights up its first follow-up.
    override func debugHover(_ on: Bool) -> Bool {
        if textView.debugHoverFirstRow(on) { return true }
        guard editable else { return super.debugHover(on) }
        pointerInside = on
        updateEdit()
        return true
    }
    #endif

    override func configure(row: TranscriptRow, render: RowRender, tableWidth: CGFloat, expanded: Bool) {
        let previousRowId = shownRowId
        super.configure(row: row, render: render, tableWidth: tableWidth, expanded: expanded)
        let (x, width) = RowMetrics.column(for: row, tableWidth: tableWidth)
        let top = RowMetrics.rowTop
        box.isHidden = true
        images.isHidden = true
        phoneMark.isHidden = true
        textView.isHidden = render.text == nil
        editable = false
        var pending: UserMessage.Pending?

        switch row.content {
        case .user(let message) where message.showsAsNote:
            textView.place(NSRect(x: x, y: RowMetrics.runnerTop, width: width, height: render.textSize.height))

        case .user(let message) where message.agentHeader != nil:
            box.isHidden = false
            box.set(fill: Theme.cardBackground, stroke: Theme.cardBorder, radius: RowMetrics.bubbleRadius)
            box.frame = NSRect(x: x, y: RowMetrics.userTop, width: width, height: render.textSize.height + RowMetrics.cardPad * 2)
            textView.place(box.frame.insetBy(dx: RowMetrics.cardPad, dy: RowMetrics.cardPad))

        case .user(let message):
            var y = RowMetrics.userTop
            if !message.images.isEmpty {
                // Attachments sit above the bubble, right-aligned, with no box.
                let area = floor(width * RowMetrics.bubbleShare)
                images.isHidden = false
                images.frame = NSRect(x: x + width - area, y: y, width: area, height: render.imageAreaHeight)
                images.remote = delegate?.remoteImages
                images.show(paths: message.images.map(\.path), frames: render.imageFrames)
                y += render.imageAreaHeight + RowMetrics.imageGap
            }
            if render.text != nil {
                let maxBubble = floor(width * RowMetrics.bubbleShare)
                let bubbleWidth = min(maxBubble, render.textSize.width + RowMetrics.bubblePadH * 2)
                let bubble = NSRect(x: x + width - bubbleWidth, y: y, width: bubbleWidth, height: render.textSize.height + RowMetrics.bubblePadV * 2)
                box.isHidden = false
                box.frame = bubble
                box.set(fill: Theme.bubbleBackground, stroke: nil, radius: RowMetrics.bubbleRadius)
                textView.place(bubble.insetBy(dx: RowMetrics.bubblePadH, dy: RowMetrics.bubblePadV))
            }
            // Right beside the bubble (or the pictures) and level with its
            // last line; the pending mark and the pencil go left of it.
            var markEdge = render.text != nil ? box.frame.minX : images.frame.minX
            if message.origin == "phone" {
                let side = zoomed(22)
                let bottom = render.text != nil ? box.frame.maxY : images.frame.maxY
                phoneMark.isHidden = false
                phoneMark.frame = NSRect(x: markEdge - side - zoomed(2), y: bottom - side - zoomed(4), width: side, height: side)
                let image = Symbols.image("iphone", size: 12)
                if phoneMark.image !== image { phoneMark.image = image }
                phoneMark.contentTintColor = .tertiaryLabelColor
                markEdge = phoneMark.frame.minX
            }
            pending = message.pending
            if let state = message.pending {
                // Where the pencil goes on a message that's landed.
                let side = zoomed(22)
                let left = markEdge
                let bottom = render.text != nil ? box.frame.maxY : images.frame.maxY
                pendingMark.frame = NSRect(x: left - side - zoomed(6), y: bottom - side - zoomed(4), width: side, height: side)
                pendingMark.show(state)
            }
            if message.editable {
                // Left of the bubble (or of the pictures, with no text),
                // level with its last line, as Codex and ChatGPT put theirs.
                editable = true
                let side = zoomed(22)
                let left = markEdge
                let bottom = render.text != nil ? box.frame.maxY : images.frame.maxY
                edit.frame = NSRect(x: left - side - zoomed(6), y: bottom - side - zoomed(4), width: side, height: side)
                let image = Symbols.image("pencil", size: 12)
                if edit.image !== image { edit.image = image }
                edit.contentTintColor = .secondaryLabelColor
            }

        case .assistant:
            textView.place(NSRect(x: x, y: top, width: width, height: render.textSize.height))

        case .plan:
            box.isHidden = false
            box.set(fill: Theme.cardBackground, stroke: Theme.cardBorder, radius: zoomed(10))
            box.frame = NSRect(x: x, y: top + zoomed(2), width: width, height: render.textSize.height + RowMetrics.cardPad * 2 - zoomed(4))
            textView.place(box.frame.insetBy(dx: RowMetrics.cardPad, dy: RowMetrics.cardPad - zoomed(2)))

        case .asks where bare:
            textView.place(NSRect(x: 0, y: 0, width: bounds.width, height: render.textSize.height))

        case .asks(let card) where card.isOpen:
            // Drawn in the composer; this row is empty (RowRenderer).
            textView.isHidden = true

        case .asks(let card):
            // A closed card, or the done card (nothing's waiting), is a plain card.
            box.isHidden = false
            box.set(fill: Theme.cardBackground, stroke: card.isOpen && !card.isDone ? NSColor.controlAccentColor : Theme.cardBorder, radius: zoomed(10))
            box.frame = NSRect(x: x, y: top + zoomed(2), width: width, height: render.textSize.height + RowMetrics.cardPad * 2 - zoomed(4))
            textView.place(box.frame.insetBy(dx: RowMetrics.cardPad, dy: RowMetrics.cardPad - zoomed(2)))

        case .error:
            box.isHidden = false
            box.set(fill: Theme.errorBackground, stroke: nil, radius: zoomed(10))
            box.frame = NSRect(x: x, y: top, width: width, height: render.textSize.height + RowMetrics.boxPad * 2)
            textView.place(box.frame.insetBy(dx: RowMetrics.boxPad, dy: RowMetrics.boxPad))

        case .footer:
            textView.place(NSRect(x: x, y: zoomed(5), width: width, height: RowMetrics.footerHeight - zoomed(10)))

        default:
            textView.place(NSRect(x: x, y: top, width: width, height: render.textSize.height))
        }

        placeWokenBear(row, x: x, width: width, textSize: render.textSize, changedRow: previousRowId != row.id)
        updateEdit()
        // A message the runner hasn't shown yet is drawn faded.
        let alpha: CGFloat = pending == nil ? 1 : 0.5
        for view in [box, textView, images] as [NSView] where view.alphaValue != alpha { view.alphaValue = alpha }
        if pending == nil, !pendingMark.isHidden { pendingMark.hide() }

        // Messages get the selection bar (Explain, Quote, Copy).
        switch row.content {
        case .user(let message): textView.selectionMessage = message.text
        case .assistant(let item): textView.selectionMessage = item.text
        default: textView.selectionMessage = nil
        }

        // Pooled cells are reused for any text row, so only an asks card
        // keeps a click handler.
        if case .asks(let card) = row.content, card.isOpen {
            textView.onAction = { [weak self] action in self?.delegate?.askAction(card, action: action) }
        } else {
            textView.onAction = nil
        }

        guard let text = render.text else { placeAnswerBoxes(row); placeExplainButtons(row); return }
        let textWidth = textView.fullFrame.width
        // A streaming assistant row only replaces the blocks that changed,
        // so TextKit lays out just the tail.
        let zoom = TypeScale.percent
        if case .assistant = row.content, previousRowId == row.id, zoom == shownZoom, !shownBlocks.isEmpty,
           textView.textContainer?.size.width == textWidth {
            var common = 0
            while common < min(shownBlocks.count, render.blocks.count) - 1, shownBlocks[common] == render.blocks[common] {
                common += 1
            }
            let start = render.blockStarts.indices.contains(common) ? render.blockStarts[common] : 0
            let oldStart = shownStarts.indices.contains(common) ? shownStarts[common] : 0
            if start == oldStart {
                let tail = text.attributedSubstring(from: NSRange(location: start, length: text.length - start))
                textView.replaceTail(from: start, with: tail)
            } else {
                textView.show(text, width: textWidth)
            }
        } else {
            textView.show(text, width: textWidth)
        }
        shownBlocks = render.blocks
        shownStarts = render.blockStarts
        shownRowId = row.id
        shownZoom = zoom
        placeAnswerBoxes(row)
        placeExplainButtons(row)
    }

    /// False when the card hasn't made room for that box yet.
    @discardableResult
    func focusAnswerBox(_ ask: Int) -> Bool {
        guard let box = answerBoxes[ask], !box.isHidden else { return false }
        // In the composer the card may be scrolled past it.
        box.scrollToVisible(box.bounds)
        box.focus()
        return true
    }

    /// Puts each Something else box over the room the card's text left for
    /// it (`.tbAnswerBox`, its last character the box's own line), and
    /// hides the rest.
    private func placeAnswerBoxes(_ row: TranscriptRow) {
        var shown = Set<Int>()
        if case .asks(let card) = row.content, card.isOpen, let storage = textView.textStorage,
           let layoutManager = textView.layoutManager, let container = textView.textContainer {
            answerCard = card
            layoutManager.ensureLayout(for: container)
            let full = textView.fullFrame
            let origin = textView.textContainerOrigin
            storage.enumerateAttribute(.tbAnswerBox, in: NSRange(location: 0, length: storage.length)) { value, range, _ in
                guard let index = (value as? NSNumber)?.intValue, range.length > 0 else { return }
                let at = NSMaxRange(range) - 1
                let line = layoutManager.lineFragmentRect(forGlyphAt: layoutManager.glyphIndexForCharacter(at: at), effectiveRange: nil)
                let indent = (storage.attribute(.paragraphStyle, at: at, effectiveRange: nil) as? NSParagraphStyle)?.headIndent ?? 0
                let box = answerBoxes[index] ?? makeAnswerBox(index)
                box.frame = NSRect(x: full.minX + origin.x + indent, y: full.minY + origin.y + line.minY + AskBoxMetrics.gap,
                                   width: full.width - origin.x - indent, height: max(0, line.height - AskBoxMetrics.gap))
                box.show(card.notes[index] ?? AskNote())
                if box.isHidden { box.isHidden = false }
                shown.insert(index)
            }
        } else {
            answerCard = nil
        }
        for (index, box) in answerBoxes where !shown.contains(index) && !box.isHidden { box.isHidden = true }
    }

    /// Puts a "?" at the right of each follow-up's first line on the open
    /// done card in the composer, and hides the rest.
    private func placeExplainButtons(_ row: TranscriptRow) {
        var shown = Set<Int>()
        if bare, case .asks(let card) = row.content, card.isDone, card.isOpen, let storage = textView.textStorage,
           let layoutManager = textView.layoutManager, let container = textView.textContainer {
            layoutManager.ensureLayout(for: container)
            let full = textView.fullFrame
            let origin = textView.textContainerOrigin
            let side = RowRenderer.explainRoom
            storage.enumerateAttribute(.tbRow, in: NSRange(location: 0, length: storage.length)) { value, range, _ in
                guard let action = value as? String, action.hasPrefix("next:"), let index = Int(action.dropFirst(5)), range.length > 0 else { return }
                // Level with the row's tick circle, its first character:
                // the line's own box has the space between rows in it.
                let circle = layoutManager.boundingRect(forGlyphRange: NSRange(location: layoutManager.glyphIndexForCharacter(at: range.location), length: 1), in: container)
                let button = explainButtons[index] ?? makeExplainButton(index)
                button.frame = NSRect(x: full.minX + origin.x + container.size.width - RowRenderer.rowInset - side,
                                      y: full.minY + origin.y + circle.midY - side / 2, width: side, height: side)
                // Set each time, so it follows a zoom change. Filled and
                // in the accent when on, like a ticked row's circle.
                let on = card.explainNext.contains(index)
                let image = Symbols.image(on ? "questionmark.circle.fill" : "questionmark.circle", size: 14)
                if button.image !== image { button.image = image }
                let tint: NSColor = on ? .controlAccentColor : .secondaryLabelColor
                if button.contentTintColor != tint { button.contentTintColor = tint }
                button.state = on ? .on : .off
                if button.isHidden { button.isHidden = false }
                shown.insert(index)
            }
        }
        for (index, button) in explainButtons where !shown.contains(index) && !button.isHidden { button.isHidden = true }
    }

    /// Where the page number of a paged card's "‹ 2 of 3 ›" is drawn, in this
    /// view. It's the first number in the text, on the heading line.
    func pageNumberRect() -> NSRect? {
        guard let storage = textView.textStorage, let layoutManager = textView.layoutManager, let container = textView.textContainer,
              let range = RowRenderer.pageNumberRange(in: storage.string) else { return nil }
        layoutManager.ensureLayout(for: container)
        let glyphs = layoutManager.glyphRange(forCharacterRange: range, actualCharacterRange: nil)
        let rect = layoutManager.boundingRect(forGlyphRange: glyphs, in: container)
        let full = textView.fullFrame
        let origin = textView.textContainerOrigin
        return rect.offsetBy(dx: full.minX + origin.x, dy: full.minY + origin.y)
    }

    /// The done card's tick draws itself on, as the sidebar row's does. The
    /// tick is an attachment in the text, which can't animate, so a view of
    /// the very same picture takes its exact place, revealed along the tick's
    /// stroke, and the text's own is see-through until that's done. The same
    /// picture so its green is the card's, and so nothing jumps at the swap:
    /// the symbol effect, tried first, drew a slightly different tick.
    func drawDoneTickOn() {
        guard let storage = textView.textStorage, storage.length > 0,
              let layoutManager = textView.layoutManager, let container = textView.textContainer,
              let tick = storage.attribute(.attachment, at: 0, effectiveRange: nil) as? NSTextAttachment,
              let image = tick.image else { return }
        layoutManager.ensureLayout(for: container)
        let glyph = layoutManager.glyphIndexForCharacter(at: 0)
        let line = layoutManager.lineFragmentRect(forGlyphAt: glyph, effectiveRange: nil)
        let at = layoutManager.location(forGlyphAt: glyph)
        let full = textView.fullFrame
        let origin = textView.textContainerOrigin
        let size = tick.bounds.size
        // A flipped text view: the attachment's picture sits on the line's
        // baseline, whatever its bounds and the line's offset say. Filmed
        // against the text's own, as it hops at the swap if this is out.
        let view = NSImageView(frame: NSRect(x: full.minX + origin.x + line.minX + at.x,
                                             y: full.minY + origin.y + line.minY + at.y - size.height,
                                             width: size.width, height: size.height))
        view.image = image
        view.imageScaling = .scaleNone
        view.wantsLayer = true
        addSubview(view)
        let clear = NSTextAttachment()
        clear.image = NSImage(size: size)
        clear.bounds = tick.bounds
        storage.addAttribute(.attachment, value: clear, range: NSRange(location: 0, length: 1))
        // The stroke of a tick, wide enough to uncover all of it by the end.
        let stroke = CAShapeLayer()
        stroke.frame = view.bounds
        let path = CGMutablePath()
        path.move(to: CGPoint(x: 0, y: size.height * 0.45))
        path.addLine(to: CGPoint(x: size.width * 0.36, y: size.height * 0.1))
        path.addLine(to: CGPoint(x: size.width, y: size.height))
        stroke.path = path
        stroke.fillColor = nil
        stroke.strokeColor = NSColor.black.cgColor
        stroke.lineWidth = size.height * 0.7
        stroke.lineCap = .butt
        stroke.lineJoin = .round
        stroke.isGeometryFlipped = view.isFlipped
        view.layer?.mask = stroke
        let draw = CABasicAnimation(keyPath: "strokeEnd")
        draw.fromValue = 0
        draw.toValue = 1
        draw.beginTime = CACurrentMediaTime() + Self.tickDelay
        draw.duration = Self.tickDraw
        draw.fillMode = .backwards
        draw.timingFunction = CAMediaTimingFunction(controlPoints: 0.3, 0, 0.2, 1)
        stroke.add(draw, forKey: "draw")
        // The text's own comes back under it, then the view goes.
        DispatchQueue.main.asyncAfter(deadline: .now() + Self.tickDelay + Self.tickDraw + 0.02) { [weak self, weak view, weak storage] in
            defer { view?.removeFromSuperview() }
            guard let self, let storage, storage.length > 0,
                  storage.attribute(.attachment, at: 0, effectiveRange: nil) as? NSTextAttachment === clear else { return }
            storage.addAttribute(.attachment, value: tick, range: NSRange(location: 0, length: 1))
            self.textView.needsDisplay = true
        }
    }

    private static let tickDelay: CFTimeInterval = 0.04
    private static let tickDraw: CFTimeInterval = 0.26

    private func makeExplainButton(_ index: Int) -> NSButton {
        let button = PointerButton()
        button.isBordered = false
        button.bezelStyle = .regularSquare
        button.imagePosition = .imageOnly
        button.contentTintColor = .secondaryLabelColor
        button.tag = index
        button.target = self
        button.action = #selector(explainClicked(_:))
        button.setTip("Ask what this means")
        button.setAccessibilityLabel("Ask what this means")
        explainButtons[index] = button
        addSubview(button)
        return button
    }

    @objc private func explainClicked(_ sender: NSButton) {
        guard let card = answerCard, card.isDone else { return }
        delegate?.askAction(card, action: "explain:\(sender.tag)")
    }

    private func makeAnswerBox(_ index: Int) -> AskAnswerBox {
        let box = AskAnswerBox()
        box.onChange = { [weak self] note in
            guard let self, let card = self.answerCard else { return }
            self.delegate?.askNoteChanged(card, ask: index, note: note)
        }
        box.onImages = { [weak self] urls in
            guard let self, let card = self.answerCard else { return }
            self.delegate?.askNoteImages(card, ask: index, urls: urls)
        }
        box.pictures = ComposerTextView.Pictures(
            allowed: { [weak self] in
                guard let self, let card = self.answerCard else { return false }
                return self.delegate?.askPicturesAllowed(card) ?? false
            },
            importOne: { [weak self] url in
                guard let self, let card = self.answerCard else { return nil }
                return await self.delegate?.askImportPicture(card, url: url)
            })
        box.onReturn = { [weak self] command in
            guard let self, let card = self.answerCard else { return }
            self.delegate?.answerBoxReturn(card, ask: index, command: command)
        }
        answerBoxes[index] = box
        addSubview(box)
        return box
    }

    override func releaseContent() {
        // The text itself stays: laying it out again on every scroll back in
        // costs more frame time than the memory it frees. Its drawing goes.
        images.clear()
        textView.park()
    }

    override func updateSlices(force: Bool = false) {
        textView.updateSlice(force: force)
    }
}

/// A borderless button that shows the pointing hand, as the card's own
/// rows (text, not views) do. A cursor rect alone doesn't hold: the text view
/// under it sets its I-beam as the pointer moves, which `TranscriptTextView`
/// now skips over one of these, and whenever AppKit works the cursor out again
/// (a tip coming up, a click redrawing the card) it asks SwiftUI's view behind
/// the card rather than this one, which answers with the arrow, and nothing
/// corrects that until the pointer next moves (Mike, 1 Nov). So the hand goes
/// back straight after each of those.
final class PointerButton: NSButton {
    private static let cursorWatch: Any? = NSEvent.addLocalMonitorForEvents(matching: .cursorUpdate) { event in
        // After the event's been handled: this sees it first.
        DispatchQueue.main.async {
            MainActor.assumeIsolated {
                guard let window = event.window ?? NSApp.keyWindow,
                      isUnderPointer(in: window, at: window.mouseLocationOutsideOfEventStream) else { return }
                NSCursor.pointingHand.set()
            }
        }
        return event
    }

    /// Is one of these what's really at `point`, in the window's coordinates?
    /// Tracking areas fire for whatever's underneath as well.
    static func isUnderPointer(in window: NSWindow, at point: NSPoint) -> Bool {
        guard let content = window.contentView else { return false }
        return content.hitTest(content.superview?.convert(point, from: nil) ?? point) is PointerButton
    }

    override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        _ = Self.cursorWatch
    }

    override func resetCursorRects() {
        addCursorRect(bounds, cursor: .pointingHand)
    }
}

/// The mark left of a message still on its way, with a tip saying where
/// it is: the spinner turns in the render server, so nothing redraws while
/// a slow runner keeps it waiting.
final class PendingMark: NSView {
    // Clicks count while Threadbear isn't the app in front (FirstClick.swift).
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }

    private let spinner = SpinnerView()
    private let clock = Symbols.makeView()
    private(set) var state: UserMessage.Pending?

    override init(frame frameRect: NSRect) {
        super.init(frame: frameRect)
        addSubview(spinner)
        addSubview(clock)
        setAccessibilityElement(true)
        setAccessibilityRole(.image)
    }

    required init?(coder: NSCoder) { fatalError() }

    override var isFlipped: Bool { true }

    func show(_ state: UserMessage.Pending) {
        isHidden = false
        let side = zoomed(14)
        let inset = (bounds.width - side) / 2
        spinner.frame = NSRect(x: inset, y: inset, width: side, height: side)
        clock.frame = bounds
        spinner.color = Theme.quietText
        Symbols.set(clock, "clock", size: 12, tint: Theme.quietText)
        spinner.isHidden = state != .sending
        clock.isHidden = state != .queued
        if state == .sending { spinner.start() } else { spinner.stop() }
        guard state != self.state else { return }
        self.state = state
        let words = state == .sending ? "Sending to the runner" : "Waiting for the current turn to finish"
        setTip(words)
        setAccessibilityLabel(words)
    }

    func hide() {
        isHidden = true
        spinner.stop()
        state = nil
    }
}

// MARK: - Work rows: thinking, tools, diffs (and notes inside a group)

/// Every work line has the same shape, T3 and Codex style: an icon (or a
/// spinner) in a slot at the column edge, the text from
/// `RowMetrics.titleIndent`, and the chevron right after the words rather
/// than at the far end of the column.
enum WorkLine {
    /// The label's frame for text of `textWidth`, stopping short of
    /// `trailing` (room for the chevron and a failed badge).
    static func labelFrame(x: CGFloat, width: CGFloat, textWidth: CGFloat, trailing: CGFloat, rowHeight: CGFloat) -> NSRect {
        let left = x + RowMetrics.titleIndent - RowMetrics.labelInset
        let fit = ceil(textWidth) + RowMetrics.labelInset * 2
        let height = Theme.workLabelHeight
        return NSRect(x: left, y: (rowHeight - height) / 2, width: max(0, min(fit, x + width - left - trailing)), height: height)
    }

    static func iconFrame(x: CGFloat, rowHeight: CGFloat) -> NSRect {
        let side = zoomed(16)
        return NSRect(x: x, y: (rowHeight - side) / 2, width: side, height: side)
    }

    static func spinnerFrame(x: CGFloat, rowHeight: CGFloat) -> NSRect {
        let side = zoomed(14)
        return NSRect(x: x + zoomed(1), y: (rowHeight - side) / 2, width: side, height: side)
    }

    static func chevronFrame(after label: NSRect, rowHeight: CGFloat) -> NSRect {
        let side = zoomed(14)
        return NSRect(x: label.maxX + zoomed(1), y: (rowHeight - side) / 2 + 0.5, width: side, height: side)
    }

    /// What a click opens, and where the hover fill goes: the line from its
    /// icon to its chevron.
    static func hitRect(x: CGFloat, right: CGFloat, rowHeight: CGFloat) -> NSRect {
        NSRect(x: x - zoomed(6), y: zoomed(2), width: right - x + zoomed(12), height: rowHeight - zoomed(4))
    }
}

final class HeaderRowCell: RowCellView {
    let chevron = Symbols.makeView()
    let icon = Symbols.makeView()
    let title = makeLabel()
    let box = FillView()
    let body = TranscriptTextView()
    private var headerRect = NSRect.zero

    override init(frame frameRect: NSRect) {
        super.init(frame: frameRect)
        [hover, box, body, chevron, icon, title].forEach(addSubview)
        body.onAction = { [weak self] key in self?.delegate?.showAllLines(key) }
    }

    required init?(coder: NSCoder) { fatalError() }

    override func configure(row: TranscriptRow, render: RowRender, tableWidth: CGFloat, expanded: Bool) {
        super.configure(row: row, render: render, tableWidth: tableWidth, expanded: expanded)
        let (x, width) = RowMetrics.column(for: row, tableWidth: tableWidth)
        let header = RowMetrics.workHeight
        if title.attributedStringValue != render.text { title.attributedStringValue = render.text ?? NSAttributedString() }

        var symbol = "brain"
        var tint = Theme.faintIcon
        var canExpand = true
        var tooltip: String?
        switch row.content {
        case .reasoning:
            symbol = "brain"
        case .tool(let tool):
            // A failed tool is marked once, by a red icon in the icon's
            // place; its title and output keep their usual colours.
            symbol = tool.failed ? "xmark.circle.fill" : ToolPresentation.symbol(for: tool.toolKind, name: tool.name)
            if tool.failed { tint = Theme.failed }
            // The title names just the file; the whole path is here.
            tooltip = ToolPresentation.fileTitle(tool)?.path
        case .approval(let item):
            switch item.resolution?.decision {
            case .deny?:
                symbol = "xmark.circle"
                tint = Theme.failed
            case .expired?: symbol = "clock"
            default: symbol = "checkmark.circle"
            }
            // Its tool's own row opens to the same thing.
            canExpand = item.opens
            tooltip = ToolPresentation.shortTitle(item.request.title, limit: 400)
        case .secret(let item):
            switch item.resolution?.decision {
            case .answered?: symbol = "lock"
            case .expired?: symbol = "clock"
            default: symbol = "xmark.circle"
            }
            canExpand = false
            tooltip = item.request.reason.isEmpty ? item.request.label : item.request.label + ": " + item.request.reason
        case .note:
            symbol = "info.circle"
            canExpand = false
        default:
            break
        }
        title.setTip(tooltip ?? "")
        Symbols.set(icon, symbol, size: 12, tint: tint)
        icon.frame = WorkLine.iconFrame(x: x, rowHeight: header)
        title.frame = WorkLine.labelFrame(x: x, width: width, textWidth: render.textSize.width, trailing: canExpand ? zoomed(16) : 0, rowHeight: header)
        var right = title.frame.maxX
        chevron.isHidden = !canExpand
        if canExpand {
            Symbols.set(chevron, expanded ? "chevron.down" : "chevron.right", size: 9, weight: .semibold, tint: Theme.faintIcon)
            chevron.frame = WorkLine.chevronFrame(after: title.frame, rowHeight: header)
            right = chevron.frame.maxX
        }
        headerRect = canExpand ? WorkLine.hitRect(x: x, right: right, rowHeight: header) : .zero
        hoverRect = headerRect
        window?.invalidateCursorRects(for: self)

        guard let detail = render.detail else {
            box.isHidden = true
            body.isHidden = true
            return
        }
        box.isHidden = false
        body.isHidden = false
        // Opened content sits under the title, past the icon slot.
        let left = x + RowMetrics.titleIndent
        let inner = width - RowMetrics.titleIndent
        switch row.content {
        case .reasoning:
            box.isHidden = true
            body.place(NSRect(x: left, y: header, width: inner, height: render.detailSize.height))
        default:
            if row.kind == .diff {
                box.set(fill: Theme.cardBackground, stroke: Theme.cardBorder, radius: zoomed(10))
                box.frame = NSRect(x: left, y: header + zoomed(2), width: inner, height: render.detailSize.height + RowMetrics.diffPadV * 2)
                body.place(NSRect(x: left + 0.5, y: box.frame.minY + RowMetrics.diffPadV, width: inner - 1, height: render.detailSize.height))
            } else {
                box.set(fill: Theme.codeBackground, stroke: Theme.cardBorder, radius: zoomed(8))
                box.frame = NSRect(x: left, y: header + zoomed(2), width: inner, height: render.detailSize.height + RowMetrics.boxPad * 2)
                body.place(box.frame.insetBy(dx: RowMetrics.boxPad, dy: RowMetrics.boxPad))
            }
        }
        body.show(detail, width: body.fullFrame.width)
    }

    override func releaseContent() {
        body.park()
    }

    override func updateSlices(force: Bool = false) {
        body.updateSlice(force: force)
    }

    override func mouseDown(with event: NSEvent) {
        let point = convert(event.locationInWindow, from: nil)
        if headerRect.contains(point) {
            delegate?.toggleExpanded(rowId: rowId)
        } else {
            super.mouseDown(with: event)
        }
    }

    override func resetCursorRects() {
        if headerRect != .zero { addCursorRect(headerRect, cursor: .pointingHand) }
    }
}

// MARK: - Group summary line

/// "Read 3 files, ran 4 commands ›": a run of work folded into one line.
/// Clicking it opens the run under it. A live group says what it's doing
/// after a dot but keeps its icon: the working line under it is the turn's
/// one spinner (two stacked "busy" lines read as a stray child row).
final class GroupRowCell: RowCellView {
    let icon = Symbols.makeView()
    let label = makeLabel()
    let chevron = Symbols.makeView()
    private var hitRect = NSRect.zero

    override init(frame frameRect: NSRect) {
        super.init(frame: frameRect)
        [hover, icon, label, chevron].forEach(addSubview)
    }

    required init?(coder: NSCoder) { fatalError() }

    override func configure(row: TranscriptRow, render: RowRender, tableWidth: CGFloat, expanded: Bool) {
        super.configure(row: row, render: render, tableWidth: tableWidth, expanded: expanded)
        guard case .group(let group) = row.content else { return }
        let (x, width) = RowMetrics.column(for: row, tableWidth: tableWidth)
        let height = RowMetrics.workHeight
        if label.attributedStringValue != render.text { label.attributedStringValue = render.text ?? NSAttributedString() }
        // T3's mark for a run of tool calls; no single tool uses it.
        Symbols.set(icon, "hammer", size: 12, tint: Theme.faintIcon)
        icon.frame = WorkLine.iconFrame(x: x, rowHeight: height)
        label.frame = WorkLine.labelFrame(x: x, width: width, textWidth: render.textSize.width, trailing: zoomed(16), rowHeight: height)
        Symbols.set(chevron, group.isExpanded ? "chevron.down" : "chevron.right", size: 9, weight: .semibold, tint: Theme.faintIcon)
        chevron.frame = WorkLine.chevronFrame(after: label.frame, rowHeight: height)
        hitRect = WorkLine.hitRect(x: x, right: chevron.frame.maxX, rowHeight: height)
        hoverRect = hitRect
        window?.invalidateCursorRects(for: self)
    }

    override func mouseDown(with event: NSEvent) {
        let point = convert(event.locationInWindow, from: nil)
        if hitRect.contains(point) {
            delegate?.toggleExpanded(rowId: rowId)
        } else {
            super.mouseDown(with: event)
        }
    }

    override func resetCursorRects() {
        addCursorRect(hitRect, cursor: .pointingHand)
    }
}

// MARK: - Working line

/// "Bear with me · 12s" with the bear at the end of a running turn: the
/// turn's one status line. Counts by itself once a second while it's in a
/// window, so the row never re-renders as time passes.
final class WorkingRowCell: RowCellView {
    let bear = WavingBearView()
    let label = makeLabel()
    private var startedAt: Date?
    private var timer: Timer?

    override init(frame frameRect: NSRect) {
        super.init(frame: frameRect)
        // Body-sized secondary text, not the faintest grey in the window:
        // this line is what Mike watches while a turn runs.
        label.font = Theme.workFont
        label.textColor = Theme.quietText
        bear.tint = Theme.quietText
        addSubview(bear)
        addSubview(label)
    }

    required init?(coder: NSCoder) { fatalError() }

    override func configure(row: TranscriptRow, render: RowRender, tableWidth: CGFloat, expanded: Bool) {
        super.configure(row: row, render: render, tableWidth: tableWidth, expanded: expanded)
        guard case .working(let status) = row.content else { return }
        let (x, width) = RowMetrics.column(for: row, tableWidth: tableWidth)
        let height = RowMetrics.workingHeight
        // Set here too, not just at init: a pooled cell outlives a zoom.
        label.font = Theme.workFont
        // The bear is a little bigger than a tool icon and sits a touch
        // left of the icon column so its feet line up with the icons.
        let side = Bear.workingSide
        bear.frame = NSRect(x: x - zoomed(3), y: (height - side) / 2, width: side, height: side)
        let left = bear.frame.maxX + zoomed(6)
        label.frame = NSRect(x: left, y: (height - Theme.workLabelHeight) / 2, width: max(0, x + width - left), height: Theme.workLabelHeight)
        startedAt = status.startedAt
        tick()
        startIfVisible()
    }

    override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        if window == nil { stop() } else { startIfVisible() }
    }

    override func releaseContent() { stop() }

    private func startIfVisible() {
        guard window != nil else { return }
        bear.hat = BearGeometry.wearsHat()
        // A turn that's only just begun gets the bear popping up; scrolling
        // back to one that's been going a while doesn't.
        bear.start(fresh: startedAt.map { Date().timeIntervalSince($0) < 2 } ?? false)
        guard timer == nil, startedAt != nil else { return }
        let timer = Timer(timeInterval: 1, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated { self?.tick() }
        }
        timer.tolerance = 0.2
        RunLoop.main.add(timer, forMode: .common)
        self.timer = timer
    }

    private func stop() {
        timer?.invalidate()
        timer = nil
        bear.stop()
    }

    private func tick() {
        let text: String
        if let startedAt {
            let elapsed = max(0, Date().timeIntervalSince(startedAt))
            text = "Bear with me · " + RelativeTime.duration(milliseconds: max(1000, elapsed * 1000))
        } else {
            text = "Bear with me"
        }
        if label.stringValue != text { label.stringValue = text }
    }
}

// MARK: - Background work line

/// "3 sub-agents working in the background · Rebuild page A, ..." at the
/// end of a thread whose turn is over but whose CLI still has work going
/// (`ThreadSummary.background`). Deliberately not the working line: the
/// bear sits (a cub when sub-agents are out) rather than waves, nothing
/// ticks, and the words say what's running.
final class BackgroundRowCell: RowCellView {
    let bear: NSImageView = FirstClickImageView()
    let label = makeLabel()

    override init(frame frameRect: NSRect) {
        super.init(frame: frameRect)
        label.font = Theme.workFont
        label.textColor = Theme.quietText
        label.lineBreakMode = .byTruncatingTail
        bear.contentTintColor = Theme.quietText
        bear.imageScaling = .scaleProportionallyUpOrDown
        addSubview(bear)
        addSubview(label)
    }

    required init?(coder: NSCoder) { fatalError() }

    override func configure(row: TranscriptRow, render: RowRender, tableWidth: CGFloat, expanded: Bool) {
        super.configure(row: row, render: render, tableWidth: tableWidth, expanded: expanded)
        guard case .background(let status) = row.content else { return }
        let (x, width) = RowMetrics.column(for: row, tableWidth: tableWidth)
        let height = RowMetrics.workingHeight
        label.font = Theme.workFont
        // A cub while sub-agents are out, else the bear sat waiting;
        // placed as the working line's bear so the two lines match.
        let cubs = status.tasks.contains { $0.kind == .agent && !$0.finished }
        bear.image = Bear.image(cubs ? .cub : .sit)
        let side = Bear.workingSide
        bear.frame = NSRect(x: x - zoomed(3), y: (height - side) / 2, width: side, height: side)
        let left = bear.frame.maxX + zoomed(6)
        label.frame = NSRect(x: left, y: (height - Theme.workLabelHeight) / 2, width: max(0, x + width - left), height: Theme.workLabelHeight)
        label.stringValue = BackgroundWork.lineWithDetail(status.tasks)
        label.setTip(BackgroundWork.detail(status.tasks))
    }
}

// MARK: - Wait divider

/// "6 min later · Mine the repo finished": a thin rule across the column
/// with the wait in the middle, between a turn and the one the agent
/// started by itself after it (`TurnGap`, Mike picked it 3 Nov). Quiet on
/// purpose, like a chat app's day divider: it only says time went by.
final class GapRowCell: RowCellView {
    let label = makeLabel()
    let left = FillView()
    let right = FillView()

    override init(frame frameRect: NSRect) {
        super.init(frame: frameRect)
        label.alignment = .center
        for rule in [left, right] { rule.set(fill: Theme.hairline, stroke: nil, radius: 0) }
        [left, right, label].forEach(addSubview)
    }

    required init?(coder: NSCoder) { fatalError() }

    override func configure(row: TranscriptRow, render: RowRender, tableWidth: CGFloat, expanded: Bool) {
        super.configure(row: row, render: render, tableWidth: tableWidth, expanded: expanded)
        guard case .gap(let gap) = row.content else { return }
        let (x, width) = RowMetrics.column(for: row, tableWidth: tableWidth)
        label.font = Theme.smallFont
        label.textColor = Theme.faintText
        label.stringValue = gap.label
        label.setTip(Self.tip(gap))
        let space = zoomed(12)
        // The words never take more than the column less a short rule each side.
        // The field draws its text inset from its frame on each side; without
        // that back, the last word was cut off with room to spare.
        let fit = min(ceil(label.intrinsicContentSize.width) + RowMetrics.labelInset * 2 + 2, max(0, width - zoomed(48) * 2 - space * 2))
        let height = ceil(label.intrinsicContentSize.height)
        let labelX = x + floor((width - fit) / 2)
        label.frame = NSRect(x: labelX, y: floor((render.height - height) / 2), width: fit, height: height)
        let ruleY = floor(render.height / 2)
        let rule: CGFloat = 1 / max(1, window?.backingScaleFactor ?? 2)
        left.frame = NSRect(x: x, y: ruleY, width: max(0, labelX - space - x), height: rule)
        right.frame = NSRect(x: label.frame.maxX + space, y: ruleY, width: max(0, x + width - label.frame.maxX - space), height: rule)
    }

    /// The times either side, and everything that finished when the line
    /// only had room for the first.
    static func tip(_ gap: TurnGap) -> String {
        let time = DateFormatter()
        time.dateStyle = .none
        time.timeStyle = .short
        var lines = ["Waited from \(time.string(from: gap.from)) to \(time.string(from: gap.to))"]
        let names = gap.wokeBy.map(\.description).filter { !$0.isEmpty }
        if !names.isEmpty { lines.append("Finished: " + names.joined(separator: ", ")) }
        return lines.joined(separator: "\n")
    }
}

// MARK: - Changed files card

/// "Edited 3 files": each file with its folder and line counts. Clicking a
/// file opens its diff under it.
final class ChangesRowCell: RowCellView {
    let card = FillView()
    let title = makeLabel()
    let total = makeLabel()
    let rule = FillView()
    private var fileRows: [(chevron: NSImageView, name: NSTextField, stats: NSTextField)] = []
    private var diffViews: [TranscriptTextView] = []
    private var hitRects: [(rect: NSRect, path: String)] = []
    private var turnId = ""

    override init(frame frameRect: NSRect) {
        super.init(frame: frameRect)
        // The hover fill sits on the card, behind the file names.
        [card, hover, title, total, rule].forEach(addSubview)
        total.alignment = .right
    }

    required init?(coder: NSCoder) { fatalError() }

    override func configure(row: TranscriptRow, render: RowRender, tableWidth: CGFloat, expanded: Bool) {
        super.configure(row: row, render: render, tableWidth: tableWidth, expanded: expanded)
        guard case .changes(let changes) = row.content else { return }
        turnId = changes.turnId
        let (x, width) = RowMetrics.column(for: row, tableWidth: tableWidth)
        let pad = RowMetrics.cardPad
        let top = zoomed(8)
        card.set(fill: Theme.cardBackground, stroke: Theme.cardBorder, radius: zoomed(10))
        card.frame = NSRect(x: x, y: top, width: width, height: render.height - top - zoomed(6))
        let header = RowMetrics.changesHeader
        title.attributedStringValue = render.text ?? NSAttributedString()
        title.frame = NSRect(x: x + pad, y: top + (header - zoomed(18)) / 2, width: width / 2, height: zoomed(18))
        // Line counts sit against the right edge, sized to fit (a label
        // wider than its text would truncate or drift left), on the same
        // baseline as the text beside them: centred on their own, the
        // smaller figures rode about 2 pt high.
        let totalWidth = ceil(render.detail?.size().width ?? 0) + zoomed(4)
        total.attributedStringValue = render.detail ?? NSAttributedString()
        total.frame = NSRect(x: x + width - pad - totalWidth, y: title.frame.minY + Theme.changesTitleFont.ascender - Theme.statsFont.ascender,
                             width: totalWidth, height: zoomed(17))
        rule.set(fill: Theme.hairline, stroke: nil, radius: 0)
        rule.frame = NSRect(x: x + 0.5, y: top + header - 0.5, width: width - 1, height: 0.5)

        hitRects = []
        hoverRect = .zero
        var y = top + header
        var diffIndex = 0
        for (index, part) in render.parts.enumerated() {
            if fileRows.count <= index {
                let entry = (chevron: Symbols.makeView(), name: makeLabel(), stats: makeLabel())
                entry.stats.alignment = .right
                [entry.chevron, entry.name, entry.stats].forEach(addSubview)
                fileRows.append(entry)
            }
            let entry = fileRows[index]
            let file = changes.files.indices.contains(index) ? changes.files[index] : nil
            let rowHeight = RowMetrics.changesFile
            for view in [entry.chevron, entry.name, entry.stats] as [NSView] { view.isHidden = false }
            Symbols.set(entry.chevron, file?.isExpanded == true ? "chevron.down" : "chevron.right", size: 9, weight: .semibold, tint: Theme.faintIcon)
            entry.chevron.frame = NSRect(x: x + pad - zoomed(2), y: y + (rowHeight - zoomed(14)) / 2, width: zoomed(14), height: zoomed(14))
            let statsWidth = ceil(part.trailing?.size().width ?? 0) + zoomed(4)
            entry.name.attributedStringValue = part.leading
            let nameHeight = Theme.workLabelHeight
            entry.name.frame = NSRect(x: x + pad + zoomed(18), y: y + (rowHeight - nameHeight) / 2, width: width - pad * 2 - zoomed(18) - statsWidth - zoomed(12), height: nameHeight)
            entry.stats.attributedStringValue = part.trailing ?? NSAttributedString()
            entry.stats.frame = NSRect(x: x + width - pad - statsWidth, y: entry.name.frame.minY + Theme.workFont.ascender - Theme.statsFont.ascender,
                                       width: statsWidth, height: zoomed(17))
            if let path = file?.path { hitRects.append((NSRect(x: x, y: y, width: width, height: rowHeight), path)) }
            y += rowHeight
            if let body = part.body {
                if diffViews.count <= diffIndex {
                    let view = TranscriptTextView()
                    view.onAction = { [weak self] key in self?.delegate?.showAllLines(key) }
                    addSubview(view)
                    diffViews.append(view)
                }
                let view = diffViews[diffIndex]
                view.isHidden = false
                view.place(NSRect(x: x + 0.5, y: y, width: width - 1, height: part.bodyHeight - zoomed(8)))
                view.show(body, width: width - 1)
                y += part.bodyHeight
                diffIndex += 1
            }
        }
        for entry in fileRows.dropFirst(render.parts.count) {
            for view in [entry.chevron, entry.name, entry.stats] as [NSView] { view.isHidden = true }
        }
        for view in diffViews.dropFirst(diffIndex) {
            view.isHidden = true
            view.clear()
        }
        window?.invalidateCursorRects(for: self)
    }

    override func releaseContent() {
        diffViews.forEach { $0.park() }
    }

    override func updateSlices(force: Bool = false) {
        diffViews.forEach { $0.updateSlice(force: force) }
    }

    // The file under the pointer gets the hover fill every other line that
    // opens on a click has. Only its line, not its open diff.
    override func mouseEntered(with event: NSEvent) {
        hoverRect = fileRect(at: convert(event.locationInWindow, from: nil))
        super.mouseEntered(with: event)
    }

    override func mouseMoved(with event: NSEvent) {
        hoverRect = fileRect(at: convert(event.locationInWindow, from: nil))
        super.mouseMoved(with: event)
    }

    private func fileRect(at point: NSPoint) -> NSRect {
        hitRects.first { $0.rect.contains(point) }.map { $0.rect.insetBy(dx: zoomed(4), dy: zoomed(1)) } ?? .zero
    }

    override func mouseDown(with event: NSEvent) {
        let point = convert(event.locationInWindow, from: nil)
        if let hit = hitRects.first(where: { $0.rect.contains(point) }) {
            delegate?.toggleChangedFile(turnId: turnId, path: hit.path)
        } else {
            super.mouseDown(with: event)
        }
    }

    override func resetCursorRects() {
        for hit in hitRects { addCursorRect(hit.rect, cursor: .pointingHand) }
    }
}

// MARK: - Images

final class ImagesRowCell: RowCellView {
    let grid = ImageGridView()

    override init(frame frameRect: NSRect) {
        super.init(frame: frameRect)
        addSubview(grid)
    }

    required init?(coder: NSCoder) { fatalError() }

    override func configure(row: TranscriptRow, render: RowRender, tableWidth: CGFloat, expanded: Bool) {
        super.configure(row: row, render: render, tableWidth: tableWidth, expanded: expanded)
        guard case .images(_, let images, _) = row.content else { return }
        let (x, width) = RowMetrics.column(for: row, tableWidth: tableWidth)
        grid.frame = NSRect(x: x, y: RowMetrics.rowTop + zoomed(2), width: width, height: render.imageAreaHeight)
        grid.remote = delegate?.remoteImages
        grid.show(paths: images.map(\.path), frames: render.imageFrames)
    }

    override func releaseContent() {
        grid.clear()
    }
}

// MARK: - Buttons

/// A capsule button drawn the same in light and dark: the prominent one
/// filled with the accent colour, the others a hairline outline.
final class PillButton: NSButton {
    var prominent = false { didSet { needsDisplay = true } }
    /// A key drawn faintly after the title ("Allow  ⏎").
    var shortcut: String? { didSet { needsDisplay = true } }

    override var isEnabled: Bool {
        didSet { if isEnabled != oldValue { needsDisplay = true } }
    }

    convenience init(pill title: String, prominent: Bool = false, shortcut: String? = nil) {
        self.init(frame: .zero)
        self.title = title
        self.prominent = prominent
        self.shortcut = shortcut
        isBordered = false
        setButtonType(.momentaryPushIn)
        focusRingType = .none
    }

    static var font: NSFont { .systemFont(ofSize: TypeScale.label, weight: .medium) }
    static var shortcutFont: NSFont { .systemFont(ofSize: TypeScale.small, weight: .medium) }

    var fittingWidth: CGFloat {
        ceil(label(color: .labelColor).size().width) + zoomed(30)
    }

    private func label(color: NSColor) -> NSAttributedString {
        let text = NSMutableAttributedString(string: title, attributes: [.font: Self.font, .foregroundColor: color])
        if let shortcut {
            let faint = prominent && isEnabled ? NSColor.white.withAlphaComponent(0.7) : NSColor.tertiaryLabelColor
            text.append(NSAttributedString(string: "  " + shortcut, attributes: [.font: Self.shortcutFont, .foregroundColor: faint]))
        }
        return text
    }

    override func draw(_ dirtyRect: NSRect) {
        let rect = bounds.insetBy(dx: 0.5, dy: 0.5)
        let path = NSBezierPath(roundedRect: rect, xRadius: rect.height / 2, yRadius: rect.height / 2)
        let pressed = isHighlighted
        if prominent, !isEnabled {
            // Nothing to send yet: no accent fill pretending it would work.
            Theme.inlineCodeBackground.setFill()
            path.fill()
        } else if prominent {
            NSColor.controlAccentColor.blended(withFraction: pressed ? 0.2 : 0, of: .black)?.setFill()
            path.fill()
        } else {
            (pressed ? Theme.inlineCodeBackground : Theme.cardBackground).setFill()
            path.fill()
            Theme.cardBorder.setStroke()
            path.lineWidth = 1
            path.stroke()
        }
        let color: NSColor = !isEnabled ? .tertiaryLabelColor : prominent ? .white : .labelColor
        let text = label(color: color)
        let size = text.size()
        text.draw(at: NSPoint(x: (bounds.width - size.width) / 2, y: (bounds.height - size.height) / 2))
    }
}

/// The small spinner a card shows beside its buttons while its answer is
/// on its way (ThreadSession.answering). Core Animation turns it, so a busy
/// main thread doesn't stop it.
enum Spinner {
    static func make() -> NSProgressIndicator {
        let s = NSProgressIndicator()
        s.style = .spinning
        s.controlSize = .small
        s.isIndeterminate = true
        s.isDisplayedWhenStopped = false
        s.usesThreadedAnimation = true
        return s
    }

    /// Shows it centred on the left of `at` (a point on the buttons' middle line), or hides it.
    static func show(_ spinner: NSProgressIndicator, _ busy: Bool, at point: NSPoint) {
        let side: CGFloat = 16
        spinner.frame = NSRect(x: point.x, y: point.y - side / 2, width: side, height: side)
        if busy { spinner.startAnimation(nil) } else { spinner.stopAnimation(nil) }
        spinner.isHidden = !busy
    }
}

// MARK: - Approval card

final class ApprovalRowCell: RowCellView {
    let card = FillView()
    let titleView = TranscriptTextView()
    let payloadBox = FillView()
    let payloadView = TranscriptTextView()
    /// Return in an empty composer allows it too (ComposerView).
    let allow = PillButton(pill: "Allow", prominent: true, shortcut: "⏎")
    let always = PillButton(pill: "Always allow")
    let deny = PillButton(pill: "Deny")
    /// Beside the buttons while the answer is on its way.
    let spinner = Spinner.make()
    private var approvalId = ""

    override init(frame frameRect: NSRect) {
        super.init(frame: frameRect)
        for (button, action) in [(allow, #selector(allowClicked)), (always, #selector(alwaysClicked)), (deny, #selector(denyClicked))] {
            button.target = self
            button.action = action
        }
        [card, titleView, payloadBox, payloadView, allow, always, deny, spinner].forEach(addSubview)
        allow.setTip("Let it do this once (Return)")
        always.setTip("Allow this, and anything like it for the rest of this thread")
        deny.setTip("Don't let it do this; the agent is told no")
    }

    required init?(coder: NSCoder) { fatalError() }

    override func configure(row: TranscriptRow, render: RowRender, tableWidth: CGFloat, expanded: Bool) {
        super.configure(row: row, render: render, tableWidth: tableWidth, expanded: expanded)
        guard case .approval(let item) = row.content else { return }
        approvalId = item.request.approvalId
        let (x, width) = RowMetrics.column(for: row, tableWidth: tableWidth)
        let pad = RowMetrics.cardPad
        // Only a waiting approval gets this card; once answered it's a work
        // line (HeaderRowCell).
        let pending = item.resolution == nil
        let top = RowMetrics.rowTop + zoomed(2)
        card.frame = NSRect(x: x, y: top, width: width, height: render.height - top - RowMetrics.rowBottom - zoomed(2))
        card.set(fill: Theme.cardBackground, stroke: Theme.cardBorder, radius: RowMetrics.cardRadius, accent: .controlAccentColor)
        let left = x + pad + RowMetrics.accentBar
        let inner = width - pad * 2 - RowMetrics.accentBar
        var y = card.frame.minY + pad
        titleView.place(NSRect(x: left, y: y, width: inner, height: render.textSize.height))
        titleView.show(render.text ?? NSAttributedString(), width: inner)
        let path = ApprovalText.filePath(item.request).map { ToolPresentation.shortTitle($0, limit: 400) }
        titleView.setTip(path ?? "")
        y += render.textSize.height + zoomed(10)
        payloadBox.set(fill: Theme.codeBackground, stroke: nil, radius: zoomed(8))
        payloadBox.frame = NSRect(x: left, y: y, width: inner, height: render.detailSize.height + RowMetrics.boxPad * 2)
        payloadView.place(payloadBox.frame.insetBy(dx: RowMetrics.boxPad, dy: RowMetrics.boxPad))
        payloadView.show(render.detail ?? NSAttributedString(), width: inner - RowMetrics.boxPad * 2)
        y = payloadBox.frame.maxY + zoomed(12)

        // Allow first and filled; Deny last, on the right of the row.
        var options = Set(item.request.options)
        // Another runner asking for a thread: Start it or Don't, once its
        // request has been read (it may come with no options: the phone's
        // row has none).
        let start = item.isStartRequest
        allow.title = start ? "Start it" : "Allow"
        allow.shortcut = start ? nil : "⏎"
        deny.title = start ? "Don't" : "Deny"
        allow.setTip(start ? "Start this thread with this brief" : "Let it do this once (Return)")
        deny.setTip(start ? "Don't start it; the asking thread is told no" : "Don't let it do this; the agent is told no")
        if start {
            options = item.startRequest.map { $0.error == nil ? [.allow, .deny] : [] } ?? []
            if pending, item.startRequest == nil { delegate?.loadStartRequest(approvalId) }
        }
        var buttonX = left
        let busy = pending && delegate?.isAnswering(approvalId) == true
        for (button, option) in [(allow, ApprovalOption.allow), (always, .allowAlways), (deny, .deny)] {
            button.isHidden = !pending || !options.contains(option)
            guard !button.isHidden else { continue }
            button.isEnabled = !busy
            button.frame = NSRect(x: buttonX, y: y, width: max(zoomed(76), button.fittingWidth), height: RowMetrics.buttonHeight)
            buttonX = button.frame.maxX + zoomed(8)
        }
        Spinner.show(spinner, busy, at: NSPoint(x: buttonX + zoomed(2), y: y + RowMetrics.buttonHeight / 2))
    }

    override func releaseContent() {
        titleView.park()
        payloadView.park()
    }

    override func updateSlices(force: Bool = false) {
        titleView.updateSlice(force: force)
        payloadView.updateSlice(force: force)
    }

    @objc private func allowClicked() { delegate?.respond(approvalId: approvalId, decision: .allow, answers: nil, message: nil) }
    @objc private func alwaysClicked() { delegate?.respond(approvalId: approvalId, decision: .allowAlways, answers: nil, message: nil) }
    @objc private func denyClicked() { delegate?.respond(approvalId: approvalId, decision: .deny, answers: nil, message: nil) }
}

// MARK: - Plan card

/// What the plan card has under its text: its buttons while it waits, and
/// the toggle for a plan longer than its preview or behind its checklist.
enum PlanCardLayout {
    static func hasFooter(_ card: PlanCard) -> Bool {
        card.state == .waiting || !card.entries.isEmpty || PlanCardText.preview(PlanCardText.split(card.text).body).clipped
    }
}

/// "Plan first" (docs/protocol.md): the agent's plan for Mike to approve,
/// which then becomes its checklist. Mike picked this from mockups (6 Nov):
/// the plan in a card with Go ahead and Send back, the details behind the ⓘ.
final class PlanCardCell: RowCellView {
    static let info = "Plan first: the agent reads and plans, and changes nothing until you approve. "
        + "Go ahead lets it start, in the permission mode the thread had before. "
        + "Send back, or anything you write, asks it for another go."

    let card = FillView()
    let titleView = TranscriptTextView()
    let status = NSTextField(labelWithString: "")
    let info = NSHostingView(rootView: InfoTip(PlanCardCell.info))
    let bodyView = TranscriptTextView()
    /// Return in an empty composer approves it too, as Claude's plan is an
    /// approval waiting (ComposerView).
    let goAhead = PillButton(pill: "Go ahead", prominent: true)
    let sendBack = PillButton(pill: "Send back…")
    let toggle = PointerButton()
    /// Go ahead is on its way (ThreadSession.answering).
    let spinner = Spinner.make()
    private var itemId = ""

    override init(frame frameRect: NSRect) {
        super.init(frame: frameRect)
        goAhead.target = self
        goAhead.action = #selector(goAheadClicked)
        sendBack.target = self
        sendBack.action = #selector(sendBackClicked)
        toggle.isBordered = false
        toggle.target = self
        toggle.action = #selector(toggleClicked)
        status.textColor = .secondaryLabelColor
        status.alignment = .right
        status.lineBreakMode = .byTruncatingTail
        [card, titleView, status, info, bodyView, goAhead, sendBack, toggle, spinner].forEach(addSubview)
        goAhead.setTip("Approve the plan and let it start")
        sendBack.setTip("Tell it what to change; it plans again")
    }

    required init?(coder: NSCoder) { fatalError() }

    override func configure(row: TranscriptRow, render: RowRender, tableWidth: CGFloat, expanded: Bool) {
        super.configure(row: row, render: render, tableWidth: tableWidth, expanded: expanded)
        guard case .planCard(let plan) = row.content else { return }
        itemId = plan.itemId
        let (x, width) = RowMetrics.column(for: row, tableWidth: tableWidth)
        let pad = RowMetrics.cardPad
        let top = RowMetrics.rowTop + zoomed(2)
        card.frame = NSRect(x: x, y: top, width: width, height: render.height - top - RowMetrics.rowBottom - zoomed(2))
        card.set(fill: Theme.cardBackground, stroke: Theme.cardBorder, radius: RowMetrics.cardRadius)
        let left = x + pad
        let inner = width - pad * 2
        var y = card.frame.minY + pad
        titleView.place(NSRect(x: left, y: y, width: render.textSize.width + zoomed(4), height: render.textSize.height))
        titleView.show(render.text ?? NSAttributedString(), width: render.textSize.width + zoomed(4))
        let side = zoomed(19)
        // Level with the title's first line: a long heading wraps.
        let line = min(render.textSize.height, ceil(Theme.changesTitleFont.ascender - Theme.changesTitleFont.descender + Theme.changesTitleFont.leading))
        info.frame = NSRect(x: titleView.frame.maxX + zoomed(4), y: y + (line - side) / 2, width: side, height: side)
        status.stringValue = switch plan.state {
        case .waiting: "Waiting for you"
        case .sentBack: "Sent back"
        case .approved: plan.entries.isEmpty ? "Approved" : ""
        }
        status.font = .systemFont(ofSize: TypeScale.label)
        let statusWidth = ceil(status.attributedStringValue.size().width) + zoomed(4)
        status.frame = NSRect(x: left + inner - statusWidth, y: y + (line - zoomed(17)) / 2, width: statusWidth, height: zoomed(17))
        y += render.textSize.height + zoomed(8)
        bodyView.place(NSRect(x: left, y: y, width: inner, height: render.detailSize.height))
        bodyView.show(render.detail ?? NSAttributedString(), width: inner)
        y += render.detailSize.height + zoomed(12)

        let waiting = plan.state == .waiting
        let busy = waiting && delegate?.isAnswering(plan.itemId) == true
        var buttonX = left
        for button in [goAhead, sendBack] {
            button.isHidden = !waiting
            guard waiting else { continue }
            button.isEnabled = !busy
            button.frame = NSRect(x: buttonX, y: y, width: max(zoomed(76), button.fittingWidth), height: RowMetrics.buttonHeight)
            buttonX = button.frame.maxX + zoomed(8)
        }
        Spinner.show(spinner, busy, at: NSPoint(x: buttonX + zoomed(2), y: y + RowMetrics.buttonHeight / 2))
        if busy { buttonX += zoomed(22) }
        let clipped = PlanCardText.preview(PlanCardText.split(plan.text).body).clipped
        let title: String? = !plan.entries.isEmpty ? (expanded ? "Hide plan" : "Show plan") : clipped ? (expanded ? "Show less" : "Show full plan") : nil
        toggle.isHidden = title == nil
        if let title {
            toggle.attributedTitle = NSAttributedString(string: title, attributes: [.font: NSFont.systemFont(ofSize: TypeScale.label), .foregroundColor: NSColor.secondaryLabelColor])
            let w = ceil(toggle.attributedTitle.size().width) + zoomed(8)
            toggle.frame = NSRect(x: buttonX + (waiting ? zoomed(2) : -zoomed(4)), y: y, width: w, height: RowMetrics.buttonHeight)
            toggle.setTip(expanded ? "Show less of it" : "Show the whole plan")
        }
    }

    override func releaseContent() {
        titleView.park()
        bodyView.park()
    }

    override func updateSlices(force: Bool = false) {
        titleView.updateSlice(force: force)
        bodyView.updateSlice(force: force)
    }

    @objc private func goAheadClicked() { delegate?.approvePlan(itemId: itemId) }
    @objc private func sendBackClicked() { delegate?.sendBackPlan() }
    @objc private func toggleClicked() { delegate?.toggleExpanded(rowId: rowId) }
}

// MARK: - Question card

/// One question's text, options and option notes. Each question gets its own
/// view so AppKit's automatic radio grouping (same superview, same action)
/// can't link the options of different questions.
private final class QuestionGroupView: NSView {
    let label = TranscriptTextView()
    var buttons: [NSButton] = []
    var notes: [NSTextField] = []

    override var isFlipped: Bool { true }

    override init(frame frameRect: NSRect) {
        super.init(frame: frameRect)
        addSubview(label)
    }

    required init?(coder: NSCoder) { fatalError() }
}

final class QuestionRowCell: RowCellView, NSTextFieldDelegate {
    let card = FillView()
    /// "Something else": a plain field in a rounded box like the approval
    /// card's payload. The system's rounded bezel was the only bright,
    /// hard-edged box in the transcript.
    let otherBox = FillView()
    let other = NSTextField()
    let send = PillButton(pill: "Send answer", prominent: true)
    let spinner = Spinner.make()
    let answerIcon = Symbols.makeView()
    let answer = makeLabel()
    private var request: QuestionRequest?
    private var groups: [QuestionGroupView] = []
    private var buttons: [(question: Int, label: String, button: NSButton)] = []
    /// What the question views were last laid out for. The same question at
    /// the same width (scrolling it back into view, a draft change) only
    /// updates button states; rebuilding every view and measuring the text
    /// on each configure made a 580 pt card cost a 100 ms frame in a fling.
    private var builtFor: String?
    private var optionsBottom: CGFloat = 0
    private var editing = false

    override init(frame frameRect: NSRect) {
        super.init(frame: frameRect)
        styleOther()
        other.isBezeled = false
        other.isBordered = false
        other.drawsBackground = false
        other.focusRingType = .none
        other.delegate = self
        send.target = self
        send.action = #selector(sendClicked)
        send.setTip("Send your answers to the agent")
        [card, otherBox, other, send, answerIcon, answer, spinner].forEach(addSubview)
    }

    required init?(coder: NSCoder) { fatalError() }

    /// The field's font at the current zoom: at init, and again when the
    /// card is rebuilt after a zoom change.
    private func styleOther() {
        other.font = .systemFont(ofSize: TypeScale.work)
        // The composer's placeholder tier, set outright: a borderless field
        // otherwise picks its own grey.
        other.placeholderAttributedString = NSAttributedString(string: "Something else", attributes: [
            .font: NSFont.systemFont(ofSize: TypeScale.work), .foregroundColor: ComposerTextView.placeholderColor,
        ])
    }

    override func configure(row: TranscriptRow, render: RowRender, tableWidth: CGFloat, expanded: Bool) {
        super.configure(row: row, render: render, tableWidth: tableWidth, expanded: expanded)
        guard case .question(let item) = row.content else { return }
        let (x, width) = RowMetrics.column(for: row, tableWidth: tableWidth)
        let pad = RowMetrics.cardPad
        let left = x + pad + RowMetrics.accentBar
        let inner = width - pad * 2 - RowMetrics.accentBar
        let pending = item.resolution == nil
        let top = RowMetrics.rowTop + zoomed(2)
        card.frame = NSRect(x: x, y: top, width: width, height: render.height - top - RowMetrics.rowBottom - zoomed(2))
        // Answered, it's history: an outline with no fill or accent, so a
        // card still waiting on Mike stands out from it.
        card.set(fill: pending ? Theme.cardBackground : nil, stroke: Theme.cardBorder, radius: RowMetrics.cardRadius,
                 accent: pending ? .controlAccentColor : nil)

        let key = "\(row.id)|\(row.version)|\(Int(tableWidth))|\(TypeScale.percent)"
        if builtFor != key {
            if request?.approvalId != item.request.approvalId { other.stringValue = "" }
            request = item.request
            styleOther()
            layoutQuestions(item.request, render: render, x: left, top: card.frame.minY + pad, width: inner, answered: !pending)
            builtFor = key
        }
        let draft = delegate?.questionDraft(item.request.approvalId) ?? [:]
        for entry in buttons {
            entry.button.state = draft[entry.question]?.contains(entry.label) == true ? .on : .off
        }

        var y = optionsBottom
        for view in [otherBox, other, send] as [NSView] { view.isHidden = !pending }
        answerIcon.isHidden = pending
        answer.isHidden = pending
        if let resolution = item.resolution {
            let (symbol, tint): (String, NSColor) = switch resolution.decision {
            case .answered: ("checkmark.circle.fill", .controlAccentColor)
            case .expired: ("clock", Theme.faintIcon)
            default: ("xmark.circle", Theme.faintIcon)
            }
            Symbols.set(answerIcon, symbol, size: 13, tint: tint)
            let side = zoomed(16)
            answerIcon.frame = NSRect(x: left, y: y + (RowMetrics.answerHeight - side) / 2, width: side, height: side)
            if answer.attributedStringValue != render.text { answer.attributedStringValue = render.text ?? NSAttributedString() }
            // Text from the same edge as a work line's after its icon, less
            // the label's own inset so the glyphs line up.
            let textX = left + RowMetrics.titleIndent - RowMetrics.labelInset
            let height = Theme.workLabelHeight
            answer.frame = NSRect(x: textX, y: y + (RowMetrics.answerHeight - height) / 2, width: left + inner - textX + RowMetrics.labelInset, height: height)
            answer.setTip(resolution.message ?? "")
            Spinner.show(spinner, false, at: .zero)
        } else {
            otherBox.frame = NSRect(x: left, y: y, width: inner, height: RowMetrics.otherFieldHeight)
            updateOtherBox()
            let fieldHeight = ceil(other.intrinsicContentSize.height)
            other.frame = NSRect(x: left + RowMetrics.boxPad - RowMetrics.labelInset, y: y + (RowMetrics.otherFieldHeight - fieldHeight) / 2,
                                 width: inner - RowMetrics.boxPad * 2 + RowMetrics.labelInset * 2, height: fieldHeight)
            y += RowMetrics.otherFieldHeight + zoomed(2) + zoomed(12)
            send.frame = NSRect(x: left, y: y, width: max(zoomed(110), send.fittingWidth), height: RowMetrics.buttonHeight)
            updateSend()
        }
    }

    /// The box's outline takes the accent colour while Mike types in it,
    /// standing in for the focus ring the plain field doesn't draw.
    private func updateOtherBox() {
        otherBox.set(fill: Theme.codeBackground, stroke: editing ? NSColor.controlAccentColor.withAlphaComponent(0.5) : Theme.cardBorder, radius: zoomed(8))
    }

    func controlTextDidBeginEditing(_ notification: Notification) {
        editing = true
        updateOtherBox()
    }

    func controlTextDidEndEditing(_ notification: Notification) {
        editing = false
        updateOtherBox()
    }

    /// "Send answer" only looks (and is) clickable once there's an answer.
    private func updateSend() {
        guard let request else { return }
        let draft = delegate?.questionDraft(request.approvalId) ?? [:]
        let typed = other.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
        let busy = delegate?.isAnswering(request.approvalId) == true
        let ready = !busy && !Self.answers(for: request, chosen: draft, typed: typed).isEmpty
        if send.isEnabled != ready { send.isEnabled = ready }
        Spinner.show(spinner, busy && !send.isHidden, at: NSPoint(x: send.frame.maxX + zoomed(10), y: send.frame.midY))
    }

    /// Places each question's views, reusing the ones already made. An
    /// answered card shows just its questions; the answer goes under them.
    private func layoutQuestions(_ request: QuestionRequest, render: RowRender, x: CGFloat, top: CGFloat, width: CGFloat, answered: Bool) {
        buttons = []
        var y = top
        for (index, question) in request.questions.enumerated() {
            if groups.count <= index {
                let group = QuestionGroupView(frame: .zero)
                addSubview(group)
                groups.append(group)
            }
            let group = groups[index]
            group.isHidden = false
            let text = RowRenderer.questionText(question.question, answered: answered)
            // Heights come from the render (measured off the main thread).
            let height = render.lineHeights.indices.contains(index)
                ? render.lineHeights[index] : TextMeasurer.current.measure(text, width: width).height
            group.label.frame = NSRect(x: 0, y: 0, width: width, height: height)
            group.label.show(text, width: width)
            if answered {
                group.buttons.forEach { $0.isHidden = true }
                group.notes.forEach { $0.isHidden = true }
                group.frame = NSRect(x: x, y: y, width: width, height: height)
                y += height + RowMetrics.answeredGap
                continue
            }
            var inner = height + zoomed(8)
            var noteIndex = 0
            for (optionIndex, option) in question.options.enumerated() {
                if group.buttons.count <= optionIndex {
                    let button = NSButton(radioButtonWithTitle: "", target: self, action: #selector(optionClicked(_:)))
                    group.addSubview(button)
                    group.buttons.append(button)
                }
                let button = group.buttons[optionIndex]
                button.isHidden = false
                // Here rather than at creation, so a zoom change reaches it.
                button.font = .systemFont(ofSize: TypeScale.work)
                button.setButtonType(question.multiSelect ? .switch : .radio)
                if button.title != option.label { button.title = option.label }
                button.frame = NSRect(x: 0, y: inner, width: width, height: RowMetrics.optionHeight)
                buttons.append((index, option.label, button))
                inner += RowMetrics.optionHeight
                if let description = option.description, !description.isEmpty {
                    if group.notes.count <= noteIndex {
                        let note = makeLabel()
                        note.textColor = .secondaryLabelColor
                        group.addSubview(note)
                        group.notes.append(note)
                    }
                    let note = group.notes[noteIndex]
                    note.isHidden = false
                    note.font = Theme.labelFont
                    if note.stringValue != description { note.stringValue = description }
                    note.frame = NSRect(x: zoomed(20), y: inner - zoomed(2), width: width - zoomed(20), height: RowMetrics.optionDescription)
                    inner += RowMetrics.optionDescription
                    noteIndex += 1
                }
            }
            for button in group.buttons.dropFirst(question.options.count) { button.isHidden = true }
            for note in group.notes.dropFirst(noteIndex) { note.isHidden = true }
            group.frame = NSRect(x: x, y: y, width: width, height: inner)
            y += inner + zoomed(12)
        }
        for group in groups.dropFirst(request.questions.count) { group.isHidden = true }
        optionsBottom = y
    }

    @objc private func optionClicked(_ sender: NSButton) {
        guard let request, let entry = buttons.first(where: { $0.button === sender }) else { return }
        var draft = delegate?.questionDraft(request.approvalId) ?? [:]
        var chosen = draft[entry.question] ?? []
        if request.questions[entry.question].multiSelect {
            if sender.state == .on { chosen.insert(entry.label) } else { chosen.remove(entry.label) }
        } else {
            chosen = [entry.label]
            for other in buttons where other.question == entry.question && other.button !== sender { other.button.state = .off }
            // Choosing an option for the last question replaces typed text.
            if entry.question == request.questions.count - 1 { other.stringValue = "" }
        }
        draft[entry.question] = chosen
        delegate?.setQuestionDraft(request.approvalId, draft)
        updateSend()
    }

    /// Typing "Something else" for a single-choice last question clears its
    /// chosen option, so the answer is one or the other, never both.
    func controlTextDidChange(_ notification: Notification) {
        defer { updateSend() }
        guard let request, let last = request.questions.indices.last, !request.questions[last].multiSelect,
              !other.stringValue.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return }
        var draft = delegate?.questionDraft(request.approvalId) ?? [:]
        guard draft[last]?.isEmpty == false else { return }
        draft[last] = []
        delegate?.setQuestionDraft(request.approvalId, draft)
        for entry in buttons where entry.question == last { entry.button.state = .off }
    }

    @objc private func sendClicked() {
        guard let request else { return }
        let draft = delegate?.questionDraft(request.approvalId) ?? [:]
        let typed = other.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
        let answers = Self.answers(for: request, chosen: draft, typed: typed)
        guard !answers.isEmpty else { return }
        // The answers also go as the message, which the runner keeps in the
        // transcript (only `answers` goes to the CLI), so the card can show
        // what was chosen after the drafts are gone.
        delegate?.respond(approvalId: request.approvalId, decision: .answered, answers: answers,
                          message: ApprovalText.answerSummary(request, answers: answers))
    }

    /// The `answers` map for `approvals.respond`. "Something else" is the
    /// answer to the last question: it replaces a single choice and is added
    /// to multiple ones. It never fills in other questions.
    static func answers(for request: QuestionRequest, chosen: [Int: Set<String>], typed: String) -> [String: String] {
        var answers: [String: String] = [:]
        let last = request.questions.count - 1
        for (index, question) in request.questions.enumerated() {
            var parts = question.options.map(\.label).filter { chosen[index]?.contains($0) == true }
            if !typed.isEmpty, index == last {
                if question.multiSelect { parts.append(typed) } else { parts = [typed] }
            }
            if !parts.isEmpty { answers[question.question] = parts.joined(separator: ", ") }
        }
        return answers
    }
}

// MARK: - Secret card

/// Where a secret card's answer is. Kept by the transcript (not the cell,
/// which is reused), and never holding the value itself.
enum SecretCardState: Equatable {
    case ready
    case sending
    /// It went; the card closes when the runner's approval.resolved comes.
    case sent
    /// The runner said no (or couldn't be reached): its message, under the
    /// field. The card stays open for another go.
    case failed(String)
}

/// The secret card's field: masked, and with nothing that would keep or
/// offer what's typed. NSSecureTextField already skips spelling, undo and
/// copying out; this turns off completion and AutoFill's suggestions too.
final class SecretField: NSSecureTextField {
    override init(frame frameRect: NSRect) {
        super.init(frame: frameRect)
        isAutomaticTextCompletionEnabled = false
        allowsCharacterPickerTouchBarItem = false
        // No content type, so macOS offers no saved passwords or codes and
        // never asks to save this one.
        contentType = nil
        isBezeled = false
        isBordered = false
        drawsBackground = false
        backgroundColor = .clear
        focusRingType = .none
        usesSingleLineMode = true
        lineBreakMode = .byClipping
        cell?.isScrollable = true
    }

    required init?(coder: NSCoder) { fatalError() }

    /// Called once the field has the cursor, before anything's typed.
    var onFocus: (() -> Void)?

    override func becomeFirstResponder() -> Bool {
        let became = super.becomeFirstResponder()
        // After AppKit has given it its editor.
        if became { DispatchQueue.main.async { [weak self] in self?.onFocus?() } }
        return became
    }
}

/// An agent's `ask_secret`: what it wants and why, a masked field with Save
/// securely, and Decline. Laid out like the question card (same container,
/// field box and buttons). Settled, it's a work line (HeaderRowCell).
final class SecretRowCell: RowCellView, NSTextFieldDelegate {
    let card = FillView()
    let textView = TranscriptTextView()
    let fieldBox = FillView()
    let field = SecretField(frame: .zero)
    let save = PillButton(pill: "Save securely", prominent: true)
    let shield = Symbols.makeView()
    /// Wraps, and an error longer than the room it has is cut short (the
    /// whole of it is in the tip).
    let note: NSTextField = {
        let label = NSTextField(wrappingLabelWithString: "")
        label.lineBreakMode = .byTruncatingTail
        label.cell?.truncatesLastVisibleLine = true
        return label
    }()
    let decline = PointerButton()
    private var approvalId = ""
    private var state = SecretCardState.ready
    private var editing = false

    nonisolated static let promise = "Kept out of chat, in a private file this agent's commands can read for 24 hours"
    static let promiseTip = "The value never goes in the chat, the phone or the archive. The agent gets a private file its commands can read, deleted after 24 hours. A command that printed it would show it."

    override init(frame frameRect: NSRect) {
        super.init(frame: frameRect)
        field.delegate = self
        field.onFocus = { [weak self] in
            guard let self, let editor = field.currentEditor() as? NSTextView else { return }
            // The secure field's editor brings a box of its own; the field
            // box (with its outline now) is the only one.
            editor.drawsBackground = false
            editing = true
            updateFieldBox()
        }
        save.target = self
        save.action = #selector(saveClicked)
        decline.isBordered = false
        decline.bezelStyle = .regularSquare
        decline.setButtonType(.momentaryPushIn)
        decline.focusRingType = .none
        decline.target = self
        decline.action = #selector(declineClicked)
        field.setTip("Type or paste it here. It's masked, and never shown in the chat")
        save.setTip("Save it to a private file for the agent (Return)")
        decline.setTip("Don't give it; the agent is told you declined")
        shield.setTip(Self.promiseTip)
        [card, textView, fieldBox, field, save, shield, note, decline].forEach(addSubview)
    }

    required init?(coder: NSCoder) { fatalError() }

    override func configure(row: TranscriptRow, render: RowRender, tableWidth: CGFloat, expanded: Bool) {
        super.configure(row: row, render: render, tableWidth: tableWidth, expanded: expanded)
        guard case .secret(let item) = row.content else { return }
        // A reused cell must never show what was typed into another card.
        if approvalId != item.request.approvalId {
            clearField()
            approvalId = item.request.approvalId
        }
        state = delegate?.secretState(approvalId) ?? .ready
        let (x, width) = RowMetrics.column(for: row, tableWidth: tableWidth)
        let pad = RowMetrics.cardPad
        let left = x + pad + RowMetrics.accentBar
        let inner = width - pad * 2 - RowMetrics.accentBar
        let top = RowMetrics.rowTop + zoomed(2)
        card.frame = NSRect(x: x, y: top, width: width, height: render.height - top - RowMetrics.rowBottom - zoomed(2))
        card.set(fill: Theme.cardBackground, stroke: Theme.cardBorder, radius: RowMetrics.cardRadius, accent: .controlAccentColor)

        var y = card.frame.minY + pad
        textView.place(NSRect(x: left, y: y, width: inner, height: render.textSize.height))
        textView.show(render.text ?? NSAttributedString(), width: inner)
        y += render.textSize.height + zoomed(12)

        // The field and Save on one line, Save at its right.
        let saveWidth = max(zoomed(110), save.fittingWidth)
        let boxWidth = max(zoomed(120), inner - saveWidth - zoomed(8))
        fieldBox.frame = NSRect(x: left, y: y, width: boxWidth, height: RowMetrics.otherFieldHeight)
        updateFieldBox()
        styleField(item.request)
        let fieldHeight = ceil(field.intrinsicContentSize.height)
        field.frame = NSRect(x: left + RowMetrics.boxPad - RowMetrics.labelInset, y: y + (RowMetrics.otherFieldHeight - fieldHeight) / 2,
                             width: boxWidth - RowMetrics.boxPad * 2 + RowMetrics.labelInset * 2, height: fieldHeight)
        save.frame = NSRect(x: fieldBox.frame.maxX + zoomed(8), y: y + (RowMetrics.otherFieldHeight - RowMetrics.buttonHeight) / 2,
                            width: saveWidth, height: RowMetrics.buttonHeight)
        y += RowMetrics.otherFieldHeight + zoomed(10)

        // What happens to it, or why it didn't go, then Decline at the right.
        // The promise wraps onto a second line in a narrow window (its
        // height is measured with the rest of the card).
        let footer = render.lineHeights.first ?? RowMetrics.secretFooterHeight
        decline.attributedTitle = NSAttributedString(string: "Decline", attributes: [.font: Theme.labelFont, .foregroundColor: Theme.quietText])
        let declineWidth = RowRenderer.secretDeclineWidth
        decline.frame = NSRect(x: left + inner - declineWidth + zoomed(6), y: y + (footer - RowMetrics.secretFooterHeight) / 2,
                               width: declineWidth, height: RowMetrics.secretFooterHeight)
        let side = zoomed(16)
        shield.frame = NSRect(x: left, y: y + (RowMetrics.secretFooterHeight - side) / 2, width: side, height: side)
        let textX = left + RowMetrics.titleIndent - RowMetrics.labelInset
        let noteText: NSAttributedString
        if case .failed(let message) = state {
            Symbols.set(shield, "exclamationmark.triangle", size: 12, tint: Theme.failed)
            noteText = RowRenderer.secretNoteText(message, color: Theme.failed)
            note.setTip(message)
        } else {
            Symbols.set(shield, "lock.shield", size: 12, tint: Theme.faintIcon)
            noteText = RowRenderer.secretNoteText(Self.promise, color: Theme.faintText)
            note.setTip(Self.promiseTip)
        }
        if note.attributedStringValue != noteText { note.attributedStringValue = noteText }
        note.frame = NSRect(x: textX, y: y + zoomed(3), width: RowRenderer.secretNoteWidth(inner: inner) + RowMetrics.labelInset * 2,
                            height: footer - zoomed(3))
        updateControls()
    }

    /// The field's font and placeholder at the current zoom.
    private func styleField(_ request: SecretRequest) {
        field.font = .systemFont(ofSize: TypeScale.work)
        let placeholder = request.placeholder ?? "Paste the secret"
        if field.placeholderAttributedString?.string != placeholder || field.placeholderAttributedString?.attribute(.font, at: 0, effectiveRange: nil) as? NSFont != field.font {
            field.placeholderAttributedString = NSAttributedString(string: placeholder, attributes: [
                .font: NSFont.systemFont(ofSize: TypeScale.work), .foregroundColor: ComposerTextView.placeholderColor,
            ])
        }
    }

    /// Save only once there's something to save, and nothing while it's
    /// on its way.
    private func updateControls() {
        let busy = state == .sending || state == .sent
        let ready = !busy && SecretAnswer.canSave(field.stringValue)
        if save.isEnabled != ready { save.isEnabled = ready }
        if field.isEnabled == busy { field.isEnabled = !busy }
        if decline.isEnabled == busy { decline.isEnabled = !busy }
    }

    /// The box's outline takes the accent colour while Mike types in it,
    /// as the question card's does.
    private func updateFieldBox() {
        fieldBox.set(fill: Theme.codeBackground, stroke: editing ? NSColor.controlAccentColor.withAlphaComponent(0.5) : Theme.cardBorder, radius: zoomed(8))
    }

    /// Empties the field and its editor, so the value isn't left in either.
    private func clearField() {
        if field.currentEditor() != nil { field.abortEditing() }
        field.stringValue = ""
        // abortEditing doesn't say editing ended, so the outline goes here.
        editing = false
        updateFieldBox()
    }

    func controlTextDidBeginEditing(_ notification: Notification) {
        editing = true
        updateFieldBox()
    }

    func controlTextDidEndEditing(_ notification: Notification) {
        editing = false
        updateFieldBox()
    }

    func controlTextDidChange(_ notification: Notification) {
        // The secure field's editor brings a box of its own; the field box
        // is the only one.
        if let editor = field.currentEditor() as? NSTextView, editor.drawsBackground { editor.drawsBackground = false }
        if case .failed = state {
            state = .ready
            delegate?.secretEdited(approvalId)
        }
        updateControls()
    }

    /// Return saves; nothing else in the field does anything special.
    func control(_ control: NSControl, textView: NSTextView, doCommandBy selector: Selector) -> Bool {
        guard selector == #selector(NSResponder.insertNewline(_:)) else { return false }
        saveClicked()
        return true
    }

    @objc private func saveClicked() {
        guard state != .sending, state != .sent, !approvalId.isEmpty else { return }
        let typed = field.stringValue
        guard SecretAnswer.canSave(typed) else { return }
        // Out of the field the moment it goes: a failed send means typing it
        // again, never a value left sitting in the window.
        clearField()
        state = .sending
        updateControls()
        delegate?.answerSecret(approvalId: approvalId, .secret(typed))
    }

    @objc private func declineClicked() {
        guard state != .sending, state != .sent, !approvalId.isEmpty else { return }
        clearField()
        state = .sending
        updateControls()
        delegate?.answerSecret(approvalId: approvalId, .decline)
    }

    override func releaseContent() {
        textView.park()
    }

    override func updateSlices(force: Bool = false) {
        textView.updateSlice(force: force)
    }
}

extension NSColor {
    /// Resolves a dynamic colour for a view's current appearance, for layers.
    func resolvedCGColor(for view: NSView) -> CGColor {
        var color = cgColor
        view.effectiveAppearance.performAsCurrentDrawingAppearance {
            color = self.cgColor
        }
        return color
    }
}
