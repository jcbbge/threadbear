import AppKit
import SwiftUI
import ThreadbearCore

/// TextKit 1 layout manager that also draws the transcript's custom
/// backgrounds: rounded boxes behind code blocks and full-width line fills
/// for diffs. Plain `.backgroundColor` only covers the glyphs.
final class BackgroundLayoutManager: NSLayoutManager {
    /// The `.tbRow` paragraph under the pointer, lit up (set by the text
    /// view).
    var hoveredRow: NSRange?

    override func drawBackground(forGlyphRange glyphsToShow: NSRange, at origin: NSPoint) {
        super.drawBackground(forGlyphRange: glyphsToShow, at: origin)
        guard let storage = textStorage, let container = textContainers.first, storage.length > 0 else { return }
        let characters = characterRange(forGlyphRange: glyphsToShow, actualGlyphRange: nil)
        let whole = NSRange(location: 0, length: storage.length)
        let width = container.size.width

        if let row = hoveredRow, NSMaxRange(row) <= storage.length, NSIntersectionRange(row, characters).length > 0 {
            drawHoveredRow(row, width: width, origin: origin)
        }

        var drawnBlocks = Set<Int>()
        storage.enumerateAttribute(.tbBlockBackground, in: characters) { value, range, _ in
            guard let color = value as? NSColor else { return }
            var effective = NSRange()
            _ = storage.attribute(.tbBlockBackground, at: range.location, longestEffectiveRange: &effective, in: whole)
            guard drawnBlocks.insert(effective.location).inserted else { return }
            let glyphs = glyphRange(forCharacterRange: effective, actualCharacterRange: nil)
            var box = NSRect.null
            enumerateLineFragments(forGlyphRange: glyphs) { _, used, _, _, _ in
                box = box.union(used)
            }
            guard !box.isNull else { return }
            let style = storage.attribute(.paragraphStyle, at: effective.location, effectiveRange: nil) as? NSParagraphStyle
            let pad = MarkdownRenderer.codePad
            // From the first line's indent when it's further left: an
            // answer row's circle sits left of its words.
            let head = min(style?.headIndent ?? 0, style?.firstLineHeadIndent ?? 0) - pad
            let tail = width + (style?.tailIndent ?? 0) + pad
            var rect = NSRect(x: head, y: box.minY - pad, width: max(0, tail - head), height: box.height + pad * 2)
            rect.origin.y = max(0, rect.origin.y)
            rect = rect.offsetBy(dx: origin.x, dy: origin.y).insetBy(dx: 0.25, dy: 0.25)
            let path = NSBezierPath(roundedRect: rect, xRadius: zoomed(8), yRadius: zoomed(8))
            color.setFill()
            path.fill()
            Theme.cardBorder.setStroke()
            path.lineWidth = 0.5
            path.stroke()
            // The lines between answer rows, across the box.
            storage.enumerateAttribute(.tbRowRule, in: effective) { rule, ruleRange, _ in
                guard rule != nil else { return }
                let first = self.glyphIndexForCharacter(at: ruleRange.location)
                let line = self.lineFragmentRect(forGlyphAt: first, effectiveRange: nil)
                let y = (line.minY + origin.y).rounded() + 0.25
                Theme.cardBorder.setFill()
                NSRect(x: rect.minX, y: y, width: rect.width, height: 0.5).fill()
            }
        }

        storage.enumerateAttribute(.tbInlineBackground, in: characters) { value, range, _ in
            guard let color = value as? NSColor else { return }
            // Inline code that's just a thread id is drawn as its chip instead.
            var ref = NSRange()
            if let word = storage.attribute(.tbThreadRef, at: range.location, longestEffectiveRange: &ref, in: range) as? String,
               ref == range, ThreadChips.resolve(word) != nil { return }
            drawPill(range, color: color, storage: storage, origin: origin)
        }

        storage.enumerateAttribute(.tbThreadRef, in: characters) { value, range, _ in
            guard let word = value as? String, ThreadChips.resolve(word) != nil else { return }
            drawPill(range, color: Theme.chipBackground, storage: storage, origin: origin)
        }

        storage.enumerateAttribute(.tbButton, in: characters) { value, range, _ in
            guard let raw = value as? String, let style = AskButtonStyle(rawValue: raw) else { return }
            drawButton(range, style: style, storage: storage, origin: origin)
        }

        // By id rather than look, so two pills side by side stay two.
        storage.enumerateAttribute(.tbReplyButton, in: characters) { value, range, _ in
            guard value != nil, let raw = storage.attribute(.tbReplyLook, at: range.location, effectiveRange: nil) as? String,
                  let look = ReplyButtons.Look(rawValue: raw) else { return }
            drawReplyButton(range, look: look, storage: storage, origin: origin)
        }

        storage.enumerateAttribute(.tbLineBackground, in: characters) { value, range, _ in
            guard let color = value as? NSColor else { return }
            let glyphs = glyphRange(forCharacterRange: range, actualCharacterRange: nil)
            color.setFill()
            enumerateLineFragments(forGlyphRange: glyphs) { rect, _, _, _, _ in
                NSRect(x: origin.x, y: rect.minY + origin.y, width: width, height: rect.height).fill()
            }
        }
    }

    /// A faint fill across a hovered `.tbRow` paragraph, the width of the
    /// text view (the row's words sit in from its edges).
    private func drawHoveredRow(_ range: NSRange, width: CGFloat, origin: NSPoint) {
        let glyphs = glyphRange(forCharacterRange: range, actualCharacterRange: nil)
        var box = NSRect.null
        enumerateLineFragments(forGlyphRange: glyphs) { _, used, _, _, _ in
            box = box.union(used)
        }
        guard !box.isNull else { return }
        let rect = NSRect(x: origin.x, y: origin.y + box.minY - zoomed(5), width: width, height: box.height + zoomed(10))
        Theme.hoverFill.setFill()
        NSBezierPath(roundedRect: rect, xRadius: zoomed(6), yRadius: zoomed(6)).fill()
    }

    /// A capsule behind an asks card button, one per line if it wraps.
    private func drawButton(_ range: NSRange, style: AskButtonStyle, storage: NSTextStorage, origin: NSPoint) {
        let font = storage.attribute(.font, at: range.location, effectiveRange: nil) as? NSFont ?? Theme.labelFont
        let glyphs = glyphRange(forCharacterRange: range, actualCharacterRange: nil)
        enumerateLineFragments(forGlyphRange: glyphs) { fragment, _, textContainer, lineGlyphs, _ in
            let part = NSIntersectionRange(lineGlyphs, glyphs)
            guard part.length > 0 else { return }
            var box = self.boundingRect(forGlyphRange: part, in: textContainer)
            let baseline = fragment.minY + self.location(forGlyphAt: part.location).y
            box.origin.y = baseline - font.ascender - zoomed(7)
            box.size.height = font.ascender - font.descender + zoomed(14)
            box = box.offsetBy(dx: origin.x, dy: origin.y).insetBy(dx: 0.5, dy: 0.5)
            // Rounded rects like the app's other buttons, with a soft
            // shadow under them so they sit up off the card.
            let radius = zoomed(7)
            let path = NSBezierPath(roundedRect: box, xRadius: radius, yRadius: radius)
            NSGraphicsContext.saveGraphicsState()
            let shadow = NSShadow()
            shadow.shadowColor = NSColor.black.withAlphaComponent(0.25)
            shadow.shadowOffset = NSSize(width: 0, height: -zoomed(1))
            shadow.shadowBlurRadius = zoomed(1.5)
            shadow.set()
            style.fill.setFill()
            path.fill()
            NSGraphicsContext.restoreGraphicsState()
            style.stroke.setStroke()
            path.lineWidth = 1
            path.stroke()
        }
    }

    /// A reply button's capsule (MarkdownRenderer.replyButton), one per
    /// line if a long one wraps, with an edge as in the mockup.
    private func drawReplyButton(_ range: NSRange, look: ReplyButtons.Look, storage: NSTextStorage, origin: NSPoint) {
        let font = storage.attribute(.font, at: range.location, effectiveRange: nil) as? NSFont ?? Theme.labelFont
        let colors = Theme.replyButton(look)
        let glyphs = glyphRange(forCharacterRange: range, actualCharacterRange: nil)
        enumerateLineFragments(forGlyphRange: glyphs) { fragment, _, textContainer, lineGlyphs, _ in
            let part = NSIntersectionRange(lineGlyphs, glyphs)
            guard part.length > 0 else { return }
            var box = self.boundingRect(forGlyphRange: part, in: textContainer)
            // The last character's kern is the room after the pill.
            let last = self.characterIndexForGlyph(at: NSMaxRange(part) - 1)
            if let kern = storage.attribute(.kern, at: last, effectiveRange: nil) as? CGFloat {
                box.size.width = max(0, box.width - kern)
            }
            let baseline = fragment.minY + self.location(forGlyphAt: part.location).y
            box.origin.y = baseline - font.ascender - zoomed(3)
            box.size.height = font.ascender - font.descender + zoomed(6)
            box = box.insetBy(dx: -MarkdownRenderer.replyPad, dy: 0).offsetBy(dx: origin.x, dy: origin.y).insetBy(dx: 0.5, dy: 0.5)
            let path = NSBezierPath(roundedRect: box, xRadius: box.height / 2, yRadius: box.height / 2)
            colors.fill.setFill()
            path.fill()
            colors.edge.setStroke()
            path.lineWidth = 1
            path.stroke()
        }
    }

    /// A small rounded fill behind just a run's glyphs (inline code, chips).
    private func drawPill(_ range: NSRange, color: NSColor, storage: NSTextStorage, origin: NSPoint) {
        let font = storage.attribute(.font, at: range.location, effectiveRange: nil) as? NSFont ?? Theme.codeFont
        let glyphs = glyphRange(forCharacterRange: range, actualCharacterRange: nil)
        color.setFill()
        // One pill per line the run covers, sized to the font rather than
        // the line (which includes the paragraph's extra line height).
        enumerateLineFragments(forGlyphRange: glyphs) { fragment, _, textContainer, lineGlyphs, _ in
            let part = NSIntersectionRange(lineGlyphs, glyphs)
            guard part.length > 0 else { return }
            var box = self.boundingRect(forGlyphRange: part, in: textContainer)
            // The run's last character is kerned to make room for the
            // pill (MarkdownRenderer); that space isn't part of the glyphs.
            let last = self.characterIndexForGlyph(at: NSMaxRange(part) - 1)
            if let kern = storage.attribute(.kern, at: last, effectiveRange: nil) as? CGFloat {
                box.size.width = max(0, box.width - kern)
            }
            let baseline = fragment.minY + self.location(forGlyphAt: part.location).y
            box.origin.y = baseline - font.ascender - zoomed(1.5)
            box.size.height = font.ascender - font.descender + zoomed(3)
            box = box.insetBy(dx: -MarkdownRenderer.pillPad, dy: 0).offsetBy(dx: origin.x, dy: origin.y)
            NSBezierPath(roundedRect: box, xRadius: zoomed(3.5), yRadius: zoomed(3.5)).fill()
        }
    }
}

/// Measures attributed strings with a private TextKit 1 stack. One per
/// thread (TextKit 1 objects are fine off the main thread when they aren't
/// attached to a view).
final class TextMeasurer {
    private let storage = NSTextStorage()
    private let layoutManager = NSLayoutManager()
    private let container = NSTextContainer(size: NSSize(width: 100, height: CGFloat.greatestFiniteMagnitude))

    init() {
        container.lineFragmentPadding = 0
        layoutManager.addTextContainer(container)
        layoutManager.allowsNonContiguousLayout = false
        storage.addLayoutManager(layoutManager)
    }

    /// Height and the widest line's width.
    func measure(_ string: NSAttributedString, width: CGFloat) -> NSSize {
        guard string.length > 0 else { return .zero }
        container.size = NSSize(width: max(1, width), height: CGFloat.greatestFiniteMagnitude)
        storage.setAttributedString(string)
        layoutManager.ensureLayout(for: container)
        let used = layoutManager.usedRect(for: container)
        storage.setAttributedString(NSAttributedString())
        return NSSize(width: ceil(used.width), height: ceil(used.height))
    }

    static var current: TextMeasurer {
        let key = "com.mikerosoft.threadbear.measurer"
        if let measurer = Thread.current.threadDictionary[key] as? TextMeasurer { return measurer }
        let measurer = TextMeasurer()
        Thread.current.threadDictionary[key] = measurer
        return measurer
    }
}

/// A read-only, selectable TextKit 1 text view for transcript text.
final class TranscriptTextView: NSTextView {
    // Clicks count while Threadbear isn't the app in front (FirstClick.swift).
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }

    /// A mockup, doc or picture previews in the pane beside the transcript
    /// (AppModel.openTranscriptFileLink); ⌘-click and other files open in
    /// the app macOS associates with them.
    var openFileLink: (URL) -> Bool = { url in
        let commandKey = NSApp.currentEvent?.modifierFlags.contains(.command) ?? false
        return MainActor.assumeIsolated { AppModel.shared.openTranscriptFileLink(url, commandKey: commandKey) }
    }

    /// A web link opens in the panel when that's what "Default" says
    /// (WebLinkAction.click). False leaves it to AppKit, which hands it to
    /// the browser: the default, and always for a ⌘-click.
    var openWebLink: (URL) -> Bool = { url in
        let commandKey = NSApp.currentEvent?.modifierFlags.contains(.command) ?? false
        guard !commandKey, WebLinkAction.click == .panel else { return false }
        return MainActor.assumeIsolated { AppModel.shared.openTranscriptWebLink(url, .panel) }
    }

    /// An http(s) link, as a URL or the string NSTextView sometimes has.
    private func webURL(_ link: Any) -> URL? {
        let url = (link as? URL) ?? (link as? String).flatMap(URL.init(string:))
        guard let url, let scheme = url.scheme?.lowercased(), scheme == "http" || scheme == "https" else { return nil }
        return url
    }

    /// The path a scheme-less link names, decoded (nil for any other link).
    static func relativeTarget(_ link: Any) -> String? {
        let url = (link as? URL) ?? (link as? String).flatMap(URL.init(string:))
        guard let url, url.scheme == nil, !url.relativeString.isEmpty else { return nil }
        return url.relativeString.removingPercentEncoding ?? url.relativeString
    }

    /// A file path written in inline code (FilePathRefs).
    var openPathRef: (String) -> Bool = { text in
        let commandKey = NSApp.currentEvent?.modifierFlags.contains(.command) ?? false
        return MainActor.assumeIsolated { AppModel.shared.openTranscriptPathRef(text, commandKey: commandKey) }
    }

    override func clicked(onLink link: Any, at charIndex: Int) {
        closeChipCard()
        forItsThread { followLink(link, at: charIndex) }
    }

    private func followLink(_ link: Any, at charIndex: Int) {
        // work:, thread: and review: links go somewhere in Threadbear: the
        // row's cell knows which turn the link is in (WorkLinks).
        if let url = link as? URL, WorkLinks.quote(of: url) != nil || WorkLinks.threadId(of: url) != nil || WorkLinks.reviewId(of: url) != nil {
            var view: NSView? = superview
            while let v = view, !(v is RowCellView) { view = v.superview }
            if let cell = view as? RowCellView { cell.delegate?.openThreadLink(url, fromRow: cell.rowId) }
            return
        }
        // NSTextView follows web links itself, but ignores file URLs.
        if let url = link as? URL, let text = FilePathRefs.text(of: url) {
            _ = openPathRef(text)
        } else if let url = link as? URL, url.isFileURL {
            _ = openFileLink(url)
        } else if let url = webURL(link), openWebLink(url) {
            return
        } else if let text = Self.relativeTarget(link) {
            // A link with no scheme that didn't come from the renderer:
            // NSWorkspace can't open one (Finder's -50), so it's looked
            // for from the thread's folder like a path in inline code.
            _ = openPathRef(text)
        } else if webURL(link) != nil {
            // http(s), checked just above: AppKit hands it to the browser.
            super.clicked(onLink: link, at: charIndex)
        } else {
            // Any other scheme (`slack:`, `x-apple.systempreferences:`):
            // AppKit would start its app on the click alone. OpenGate asks
            // first, naming the app and the link (Daybreak, 7 Nov).
            openOtherLink(link)
        }
    }

    /// A link that's neither a file nor a web page, through OpenGate.
    var openOtherLink: (Any) -> Void = { link in
        MainActor.assumeIsolated {
            guard let url = (link as? URL) ?? (link as? String).flatMap(URL.init(string:)) else { return NSSound.beep() }
            OpenGate.openLink(url)
        }
    }

    /// The thread this text is in, for a transcript row's: a thread open in
    /// a panel isn't the selected one.
    var linkThreadId: String? {
        var view: NSView? = superview
        while let v = view, !(v is RowCellView) { view = v.superview }
        return (view as? RowCellView)?.delegate?.linkThreadId
    }

    /// Runs `body` with this text's thread as the one links are followed
    /// in (AppModel.linkThreadId), so another Mac's thread in a panel has
    /// its paths fetched from that Mac, not read as this Mac's.
    func forItsThread<T>(_ threadId: String? = nil, _ body: () -> T) -> T {
        let app = AppModel.shared
        let saved = app.linkThreadId
        app.linkThreadId = threadId ?? linkThreadId ?? saved
        defer { app.linkThreadId = saved }
        return body()
    }

    convenience init() {
        let storage = NSTextStorage()
        let layoutManager = BackgroundLayoutManager()
        layoutManager.allowsNonContiguousLayout = false
        storage.addLayoutManager(layoutManager)
        let container = NSTextContainer(size: NSSize(width: 100, height: CGFloat.greatestFiniteMagnitude))
        container.lineFragmentPadding = 0
        container.widthTracksTextView = false
        layoutManager.addTextContainer(container)
        self.init(frame: .zero, textContainer: container)
        isEditable = false
        isSelectable = true
        drawsBackground = false
        isRichText = true
        textContainerInset = .zero
        isVerticallyResizable = false
        isHorizontallyResizable = false
        linkTextAttributes = [.foregroundColor: NSColor.linkColor, .cursor: NSCursor.pointingHand]
        usesFindBar = false
        isAutomaticLinkDetectionEnabled = false
    }

    // MARK: Drawing tall text through a window
    //
    // A layer-backed view keeps a backing store the size of its whole frame:
    // a 2,864 pt streaming reply cost 36 MB at 2x, and an expanded 1,500-line
    // diff would cost hundreds. So text taller than about a screen and a half
    // is drawn through a window ("slice") over the part that's on screen plus
    // half a screen either side. The view's frame is the slice, and its
    // bounds origin is moved by the slice's offset, so text coordinates,
    // selection and clicks are the same as for the whole frame.

    /// Where all of the text sits in the superview (what `frame` would be).
    private(set) var fullFrame = NSRect.zero

    /// The text always starts at (0, 0) in the view's coordinates, whatever
    /// slice the bounds show. NSTextView recomputes this from the bounds
    /// origin when it re-lays out (a finished reply replacing its streamed
    /// text did it), and a slice at offset 2,844 then drew the start of a
    /// long reply where its end belonged.
    override var textContainerOrigin: NSPoint {
        NSPoint(x: textContainerInset.width, y: textContainerInset.height)
    }
    private var placed = false

    /// Puts the text at `frame` in the superview, drawing only a slice of
    /// it if it's tall.
    func place(_ frame: NSRect) {
        fullFrame = frame
        placed = true
        updateSlice(force: true)
    }

    /// Moves the slice to cover what's on screen. Cheap when nothing needs
    /// to change; called as the transcript scrolls.
    func updateSlice(force: Bool = false) {
        guard placed else { return }
        let full = fullFrame
        let screen = max(200, enclosingScrollView?.contentView.bounds.height ?? 900)
        guard full.height > screen * 1.5, let superview else {
            apply(slice: 0..<full.height)
            return
        }
        // The slice drawn now, if it still fits the text.
        var current: Range<CGFloat>? = frame.height > 0 && !parked ? bounds.minY..<(bounds.minY + frame.height) : nil
        if let slice = current, slice.upperBound > full.height { current = nil }
        // The part of the text on screen, from the top of the text.
        let visible = superview.visibleRect.intersection(full)
        guard !visible.isNull, visible.height > 0 else {
            // Not on screen (yet): keep the slice it has, or start at the top.
            if force || current == nil { apply(slice: current ?? 0..<min(full.height, screen * 2)) }
            return
        }
        let top = visible.minY - full.minY
        let bottom = visible.maxY - full.minY
        let margin = screen * 0.5
        if let slice = current {
            // Keep the slice while what's on screen is inside it with some
            // room to scroll (or the slice already reaches that end of the text).
            let roomAbove = top - slice.lowerBound
            let roomBelow = slice.upperBound - bottom
            let enoughAbove = slice.lowerBound <= 0 || roomAbove >= margin / 3
            let enoughBelow = slice.upperBound >= full.height || roomBelow >= margin / 3
            if roomAbove >= 0, roomBelow >= 0, enoughAbove, enoughBelow {
                // The frame may still need to follow a moved or resized row.
                if force { apply(slice: slice) }
                return
            }
        }
        apply(slice: max(0, top - margin)..<min(full.height, bottom + margin))
    }

    private var parked = false

    /// Shrinks to nothing (letting go of its backing store) while its row
    /// is parked off screen. `updateSlice(force:)` brings it back.
    func park() {
        guard placed, !parked else { return }
        parked = true
        super.frame = NSRect(x: fullFrame.minX, y: fullFrame.minY, width: fullFrame.width, height: 0)
    }

    private func apply(slice: Range<CGFloat>) {
        parked = false
        let target = NSRect(x: fullFrame.minX, y: fullFrame.minY + slice.lowerBound, width: fullFrame.width, height: slice.upperBound - slice.lowerBound)
        var moved = false
        if frame != target {
            super.frame = target
            moved = true
        }
        if bounds.origin.y != slice.lowerBound || bounds.origin.x != 0 {
            setBoundsOrigin(NSPoint(x: 0, y: slice.lowerBound))
            moved = true
        }
        // The slice shows a different part of the text now: draw it afresh
        // rather than trust the old contents to be redrawn.
        if moved { needsDisplay = true }
    }

    /// Sets the text unless it's the same object already shown.
    func show(_ string: NSAttributedString, width: CGFloat) {
        if let container = textContainer, container.size.width != width {
            container.size = NSSize(width: width, height: CGFloat.greatestFiniteMagnitude)
        }
        guard let storage = textStorage else { return }
        if storage.length == string.length, storage.isEqual(to: string) { return }
        storage.setAttributedString(string)
        (layoutManager as? BackgroundLayoutManager)?.hoveredRow = nil
        refreshChips()
        // The pointing hand over "Show 30 more lines" (always the last run)
        // only shows once the view rebuilds its cursor rects.
        if string.length > 0, string.attribute(.tbAction, at: string.length - 1, effectiveRange: nil) != nil {
            window?.invalidateCursorRects(for: self)
        }
    }

    /// Empties the text so a parked cell holds no layout.
    func clear() {
        guard let storage = textStorage, storage.length > 0 else { return }
        storage.setAttributedString(NSAttributedString())
        (layoutManager as? BackgroundLayoutManager)?.hoveredRow = nil
        refreshChips()
    }

    /// Replaces everything from `offset` on, so TextKit only lays out the tail.
    func replaceTail(from offset: Int, with tail: NSAttributedString) {
        guard let storage = textStorage else { return }
        let start = min(offset, storage.length)
        storage.beginEditing()
        storage.replaceCharacters(in: NSRange(location: start, length: storage.length - start), with: tail)
        storage.endEditing()
        refreshChips()
    }

    var usedHeight: CGFloat {
        guard let layoutManager, let textContainer else { return 0 }
        layoutManager.ensureLayout(for: textContainer)
        return ceil(layoutManager.usedRect(for: textContainer).height)
    }

    /// Called with a `.tbAction` run's value when it's clicked. A plain
    /// attribute rather than a link, so it keeps its own colour (links are
    /// drawn in `linkTextAttributes`) and needs no URL scheme.
    var onAction: ((String) -> Void)?

    override func mouseDown(with event: NSEvent) {
        let point = convert(event.locationInWindow, from: nil)
        // A ```mermaid or ```html box's buttons. Elsewhere in the box a
        // press selects as text does.
        if let box = richBox(at: point), let action = box.cell.action(at: point, in: box.frame) {
            closeChipCard()
            perform(action, on: box.cell.block)
            return
        }
        // A draft's Copy (DraftBlockCell).
        if let header = draftHeader(at: point), header.cell.isButton(at: point, in: header.frame) {
            closeChipCard()
            header.cell.copyDraft()
            setNeedsDisplay(header.frame)
            CopiedBubble.show(above: header.cell.button(in: header.frame), in: self)
            // Back to Copy once Copied has had its moment.
            let frame = header.frame
            DispatchQueue.main.asyncAfter(deadline: .now() + DraftBlockCell.copiedFor + 0.05) { [weak self] in self?.setNeedsDisplay(frame) }
            return
        }
        // A press on a link (a file, a web page, an asks card's link
        // button) that moves drags it out (FileDrag); let go first and
        // it's a click as before.
        if let link = peek(at: point), FileDrag.writer(for: link.peek.url) != nil, FileDrag.isDrag(from: event) {
            closeChipCard()
            FileDrag.begin(link.peek.url, from: self, event: event)
            return
        }
        // After the drag above: dragged, a chip's picture goes out as its
        // file. A picture not here yet (another runner's) falls through.
        if let chip = pictureChip(at: point), pictureGrid?.open(chip) == true {
            closeChipCard()
            return
        }
        // A reply button's pill presses it (or opens what it started).
        if let id = replyButton(at: point) {
            closeChipCard()
            AppModel.shared.pressReplyButton(id, from: transcriptThreadId)
            return
        }
        if let onAction, let action = row(at: point)?.action ?? character(at: point).flatMap({ textStorage?.attribute(.tbAction, at: $0, effectiveRange: nil) as? String }) {
            closeChipCard()
            onAction(action)
            return
        }
        if let chip = chip(at: point) {
            closeChipCard()
            AppModel.shared.openThread(chip.threadId)
            return
        }
        super.mouseDown(with: event)
    }

    /// The link a middle-button press went down on, so letting go over the
    /// same link opens it (as a browser does on release) and a press that
    /// wanders off it doesn't.
    private var middlePress: NSRange?

    override func otherMouseDown(with event: NSEvent) {
        // Button 2 is the middle one; MouseNavigation takes back/forward.
        guard event.buttonNumber == 2, let press = middleTarget(at: convert(event.locationInWindow, from: nil)) else {
            middlePress = nil
            return super.otherMouseDown(with: event)
        }
        middlePress = press.range
    }

    override func otherMouseUp(with event: NSEvent) {
        let pressed = middlePress
        middlePress = nil
        guard event.buttonNumber == 2, let pressed, let target = middleTarget(at: convert(event.locationInWindow, from: nil)),
              target.range == pressed else { return super.otherMouseUp(with: event) }
        closeChipCard()
        // A middle click opens what a click would: a thread chip its
        // thread, a picture chip its picture, any other link through
        // clicked(onLink:), so work:, file and web links go where a left
        // click sends them (and ⌘ still means the browser or the app).
        if let chip = pictureChip(at: convert(event.locationInWindow, from: nil)), pictureGrid?.open(chip) == true { return }
        switch target.open {
        case .thread(let id): AppModel.shared.openThread(id)
        case .link(let link, let index): clicked(onLink: link, at: index)
        }
    }

    private enum MiddleOpen { case thread(String), link(Any, Int) }

    /// The thread chip or link under `point`, with the range a press and
    /// its release have to share.
    private func middleTarget(at point: NSPoint) -> (range: NSRange, open: MiddleOpen)? {
        if let chip = chip(at: point) { return (chip.range, .thread(chip.threadId)) }
        guard let index = character(at: point), let storage = textStorage else { return nil }
        var range = NSRange()
        guard let link = storage.attribute(.link, at: index, longestEffectiveRange: &range,
                                           in: NSRange(location: 0, length: storage.length)) else { return nil }
        return (range, .link(link, index))
    }

    /// The character under `point` (view coordinates, which already
    /// include a slice's bounds offset), if the point is on its glyph.
    // MARK: Rich blocks

    /// The ```mermaid or ```html box at `point`, and its frame in this
    /// view's coordinates (RichBlockCell).
    func richBox(at point: NSPoint) -> (cell: RichBlockCell, frame: NSRect)? {
        guard let layoutManager, let textContainer, let storage = textStorage, storage.length > 0,
              storage.string.utf16.contains(0xFFFC) else { return nil }
        let origin = textContainerOrigin
        let local = NSPoint(x: point.x - origin.x, y: point.y - origin.y)
        let glyph = layoutManager.glyphIndex(for: local, in: textContainer)
        let index = layoutManager.characterIndexForGlyph(at: glyph)
        guard index < storage.length, let cell = (storage.attribute(.attachment, at: index, effectiveRange: nil) as? NSTextAttachment)?.attachmentCell as? RichBlockCell
        else { return nil }
        let frame = richFrame(glyph: glyph)
        return frame.contains(point) ? (cell, frame) : nil
    }

    /// The draft header at `point` (DraftBlockCell), and its frame in this
    /// view's coordinates.
    func draftHeader(at point: NSPoint) -> (cell: DraftBlockCell, frame: NSRect)? {
        guard let layoutManager, let textContainer, let storage = textStorage, storage.length > 0,
              storage.string.utf16.contains(0xFFFC) else { return nil }
        let origin = textContainerOrigin
        let local = NSPoint(x: point.x - origin.x, y: point.y - origin.y)
        let glyph = layoutManager.glyphIndex(for: local, in: textContainer)
        let index = layoutManager.characterIndexForGlyph(at: glyph)
        guard index < storage.length, let cell = (storage.attribute(.attachment, at: index, effectiveRange: nil) as? NSTextAttachment)?.attachmentCell as? DraftBlockCell
        else { return nil }
        let frame = richFrame(glyph: glyph)
        return frame.insetBy(dx: 0, dy: -3).contains(point) ? (cell, frame) : nil
    }

    private func richFrame(glyph: Int) -> NSRect {
        guard let layoutManager, let textContainer else { return .zero }
        let box = layoutManager.boundingRect(forGlyphRange: NSRange(location: glyph, length: 1), in: textContainer)
        let size = layoutManager.attachmentSize(forGlyphAt: glyph)
        let origin = textContainerOrigin
        // The attachment sits on the line's baseline, at the bottom of its box.
        return NSRect(x: box.minX + origin.x, y: box.maxY - size.height + origin.y, width: size.width, height: size.height)
    }

    private func isRichButton(at point: NSPoint) -> Bool {
        if let header = draftHeader(at: point) { return header.cell.isButton(at: point, in: header.frame) }
        guard let box = richBox(at: point) else { return false }
        return box.cell.action(at: point, in: box.frame) != nil
    }

    private func perform(_ action: RichBlockCell.Action, on block: RichBlock) {
        switch action {
        case .drawn: RichBlocks.shared.setShowsSource(block.id, false)
        case .source: RichBlocks.shared.setShowsSource(block.id, true)
        case .copy:
            NSPasteboard.general.clearContents()
            NSPasteboard.general.setString(block.source, forType: .string)
        case .open:
            RichRenderer.shared.openBeside(block)
        }
    }

    /// A tip over each of the boxes' buttons, placed again whenever the
    /// text or the width changes.
    private func placeRichTips() {
        subviews.filter { $0 is RichTipAnchor }.forEach { $0.removeFromSuperview() }
        guard let layoutManager, let textContainer, let storage = textStorage, storage.length > 0,
              storage.string.utf16.contains(0xFFFC) else { return }
        layoutManager.ensureLayout(for: textContainer)
        storage.enumerateAttribute(.attachment, in: NSRange(location: 0, length: storage.length)) { value, range, _ in
            if let draft = (value as? NSTextAttachment)?.attachmentCell as? DraftBlockCell {
                let frame = richFrame(glyph: layoutManager.glyphIndexForCharacter(at: range.location))
                let anchor = RichTipAnchor(frame: draft.button(in: frame))
                anchor.text = DraftBlockCell.tip
                addSubview(anchor)
                return
            }
            guard let cell = (value as? NSTextAttachment)?.attachmentCell as? RichBlockCell else { return }
            let frame = richFrame(glyph: layoutManager.glyphIndexForCharacter(at: range.location))
            let layout = cell.layout(in: frame)
            for action in RichBlockCell.Action.allCases {
                guard let rect = layout.buttons[action] else { continue }
                let anchor = RichTipAnchor(frame: rect)
                anchor.text = action.tip(cell.block)
                addSubview(anchor)
            }
        }
    }

    override func setFrameSize(_ newSize: NSSize) {
        let changed = newSize.width != frame.width
        super.setFrameSize(newSize)
        if changed { placeRichTips() }
    }

    private func character(at point: NSPoint) -> Int? {
        guard let layoutManager, let textContainer, let storage = textStorage, storage.length > 0 else { return nil }
        let origin = textContainerOrigin
        let local = NSPoint(x: point.x - origin.x, y: point.y - origin.y)
        let glyph = layoutManager.glyphIndex(for: local, in: textContainer)
        let box = layoutManager.boundingRect(forGlyphRange: NSRange(location: glyph, length: 1), in: textContainer)
        guard box.insetBy(dx: -zoomed(4), dy: -zoomed(3)).contains(local) else { return nil }
        let index = layoutManager.characterIndexForGlyph(at: glyph)
        return index < storage.length ? index : nil
    }

    /// The `.tbRow` paragraph whose lines `point` is on, anywhere across
    /// them, so the space right of a short row is part of it too.
    private func row(at point: NSPoint) -> (range: NSRange, action: String)? {
        guard let layoutManager, let textContainer, let storage = textStorage, storage.length > 0 else { return nil }
        let origin = textContainerOrigin
        let local = NSPoint(x: point.x - origin.x, y: point.y - origin.y)
        guard local.x >= 0, local.x <= textContainer.size.width else { return nil }
        let glyph = layoutManager.glyphIndex(for: local, in: textContainer)
        let line = layoutManager.lineFragmentRect(forGlyphAt: glyph, effectiveRange: nil)
        guard local.y >= line.minY, local.y < line.maxY else { return nil }
        let index = layoutManager.characterIndexForGlyph(at: glyph)
        guard index < storage.length else { return nil }
        var range = NSRange()
        guard let action = storage.attribute(.tbRow, at: index, longestEffectiveRange: &range, in: NSRange(location: 0, length: storage.length)) as? String
        else { return nil }
        return (range, action)
    }

    /// Lights up the `.tbRow` paragraph under the pointer, or none.
    private func hoverRow(_ range: NSRange?) {
        guard let manager = layoutManager as? BackgroundLayoutManager, manager.hoveredRow != range else { return }
        manager.hoveredRow = range
        needsDisplay = true
    }

    #if DEBUG
    /// The automation hook's `hover` on a row: lights up the first
    /// `.tbRow` as if the pointer were on it. False when there's none.
    func debugHoverFirstRow(_ on: Bool) -> Bool {
        guard let storage = textStorage else { return false }
        var first: NSRange?
        storage.enumerateAttribute(.tbRow, in: NSRange(location: 0, length: storage.length)) { value, range, stop in
            if value != nil { first = range; stop.pointee = true }
        }
        guard let first else { return false }
        hoverRow(on ? first : nil)
        return true
    }
    #endif

    // MARK: Thread chips
    //
    // A thread id in a reply that names a real thread (ThreadChips) is drawn
    // as a chip: accent text on a pill (BackgroundLayoutManager), a pointing
    // hand, a card saying what the thread is on hover, and a click opens it.
    // The colour is a temporary attribute so the rendered (and cached) text
    // doesn't depend on the thread list.

    private var chips: [(range: NSRange, threadId: String)] = []
    private var chipObserver: NSObjectProtocol?
    private var chipTracking: NSTrackingArea?
    private var chipCard: ChipCardWindow?
    private var hoveredChip: NSRange?
    private var chipTimer: Timer?

    /// Works out which id-shaped words are chips now, after the text or
    /// the thread list changed.
    func refreshChips() {
        placeRichTips()
        guard let layoutManager, let storage = textStorage else { return }
        let had = !chips.isEmpty
        chips = ThreadChips.chips(in: storage)
        if had {
            layoutManager.removeTemporaryAttribute(.foregroundColor, forCharacterRange: NSRange(location: 0, length: storage.length))
        }
        for chip in chips {
            layoutManager.addTemporaryAttribute(.foregroundColor, value: Theme.chipText, forCharacterRange: chip.range)
        }
        if had || !chips.isEmpty { needsDisplay = true }
        if let hovered = hoveredChip, !chips.contains(where: { $0.range == hovered }) { closeChipCard() }
        // Only text that could hold a chip listens for new threads.
        let couldHaveChips = hasThreadRefs(storage)
        if couldHaveChips, chipObserver == nil {
            chipObserver = NotificationCenter.default.addObserver(forName: ThreadChips.changed, object: nil, queue: .main) { [weak self] _ in
                MainActor.assumeIsolated { self?.refreshChips() }
            }
        } else if !couldHaveChips, let observer = chipObserver {
            NotificationCenter.default.removeObserver(observer)
            chipObserver = nil
        }
    }

    private func hasThreadRefs(_ storage: NSTextStorage) -> Bool {
        var found = false
        storage.enumerateAttribute(.tbThreadRef, in: NSRange(location: 0, length: storage.length)) { value, _, stop in
            if value != nil { found = true; stop.pointee = true }
        }
        return found
    }

    private func chip(at point: NSPoint) -> (range: NSRange, threadId: String)? {
        guard !chips.isEmpty, let index = character(at: point) else { return nil }
        return chips.first { NSLocationInRange(index, $0.range) }
    }

    /// The chip's box on its first line, in view coordinates.
    private func chipRect(_ range: NSRange) -> NSRect? {
        guard let layoutManager, let textContainer else { return nil }
        let glyphs = layoutManager.glyphRange(forCharacterRange: range, actualCharacterRange: nil)
        var first: NSRect?
        layoutManager.enumerateEnclosingRects(forGlyphRange: glyphs, withinSelectedGlyphRange: NSRange(location: NSNotFound, length: 0),
                                              in: textContainer) { rect, stop in
            first = rect
            stop.pointee = true
        }
        let origin = textContainerOrigin
        return first.map { $0.offsetBy(dx: origin.x, dy: origin.y) }
    }

    override func updateTrackingAreas() {
        super.updateTrackingAreas()
        guard chipTracking == nil else { return }
        let area = NSTrackingArea(rect: .zero, options: [.mouseEnteredAndExited, .mouseMoved, .activeInKeyWindow, .inVisibleRect], owner: self)
        addTrackingArea(area)
        chipTracking = area
    }

    // NSTextView sets the I-beam itself as the pointer moves (cursor rects
    // added in resetCursorRects lost to it), so the hand is set after it.
    override func mouseMoved(with event: NSEvent) {
        if isOverPointerButton(event) {
            // The click goes to the button, so the row under it isn't lit
            // either, and NSTextView doesn't get to set its I-beam.
            hoverRow(nil)
            hoverChip(nil)
            NSCursor.pointingHand.set()
            return
        }
        super.mouseMoved(with: event)
        let point = convert(event.locationInWindow, from: nil)
        let chip = chip(at: point)
        let row = onAction == nil ? nil : row(at: point)
        hoverRow(row?.range)
        if chip != nil || row != nil || isAction(at: point) || pictureChip(at: point) != nil || isRichButton(at: point) { NSCursor.pointingHand.set() }
        if let chip { hoverChip(chip) } else { hoverPeek(peek(at: point)) }
    }

    /// Over a clickable run (an asks card's buttons, "Show 30 more lines",
    /// a reply button).
    private func isAction(at point: NSPoint) -> Bool {
        if replyButton(at: point) != nil { return true }
        return onAction != nil && character(at: point).flatMap { textStorage?.attribute(.tbAction, at: $0, effectiveRange: nil) } != nil
    }

    /// The id of the reply button under `point`, if it's one that can be
    /// clicked: an unknown button is drawn as plain words with no id.
    func replyButton(at point: NSPoint) -> String? {
        character(at: point).flatMap { textStorage?.attribute(.tbReplyButton, at: $0, effectiveRange: nil) as? String }
    }

    /// A `PointerButton` laid over this text (the done card's "?") is what's
    /// really under the pointer, but the text's tracking area still fires.
    private func isOverPointerButton(_ event: NSEvent) -> Bool {
        window.map { PointerButton.isUnderPointer(in: $0, at: event.locationInWindow) } ?? false
    }

    override func cursorUpdate(with event: NSEvent) {
        let point = convert(event.locationInWindow, from: nil)
        if isOverPointerButton(event) || chip(at: point) != nil || isAction(at: point) || pictureChip(at: point) != nil || isRichButton(at: point) || (onAction != nil && row(at: point) != nil) {
            NSCursor.pointingHand.set()
        } else {
            super.cursorUpdate(with: event)
        }
    }

    // NSTextView answers an enter with its I-beam as well, and the text's
    // area is entered from under the button just as from anywhere else.
    override func mouseEntered(with event: NSEvent) {
        if isOverPointerButton(event) {
            NSCursor.pointingHand.set()
            return
        }
        super.mouseEntered(with: event)
    }

    override func mouseExited(with event: NSEvent) {
        super.mouseExited(with: event)
        hoverChip(nil)
        hoverRow(nil)
    }

    override func viewWillMove(toWindow newWindow: NSWindow?) {
        super.viewWillMove(toWindow: newWindow)
        if newWindow == nil {
            closeChipCard()
            closeSelectionBar()
        }
    }

    /// The card shows after the pointer rests on a chip for a moment, like
    /// a tooltip, and goes when it leaves.
    private func hoverChip(_ chip: (range: NSRange, threadId: String)?) {
        hover(chip?.range, after: 0.35) { [weak self] in if let chip { self?.showChipCard(chip) } }
    }

    /// A link's card waits a little longer than a chip's: links are
    /// everywhere in replies, and one shouldn't pop up under every pass of
    /// the pointer while Mike reads.
    private func hoverPeek(_ link: (range: NSRange, peek: LinkPeek)?) {
        // A picture's chip is only there to be pointed at, so it's as quick as a thread's.
        hover(link?.range, after: link?.peek.pictureOnly == true ? 0.35 : 0.5) { [weak self] in if let link { self?.showPeekCard(link) } }
    }

    private func hover(_ range: NSRange?, after delay: TimeInterval, show: @escaping @MainActor () -> Void) {
        guard range != hoveredChip else { return }
        closeChipCard()
        guard let range else { return }
        hoveredChip = range
        chipTimer = Timer.scheduledTimer(withTimeInterval: delay, repeats: false) { _ in
            MainActor.assumeIsolated { show() }
        }
    }

    private func showChipCard(_ chip: (range: NSRange, threadId: String)) {
        guard let card = ThreadChipCard.make(threadId: chip.threadId) else { return }
        showCard(card, under: chip.range)
    }

    private func showPeekCard(_ link: (range: NSRange, peek: LinkPeek)) {
        showCard(LinkPeekCard(peek: link.peek), under: link.range)
    }

    private func showCard(_ card: some View, under range: NSRange) {
        guard hoveredChip == range, let window, let rect = chipRect(range) else { return }
        let pill = rect.insetBy(dx: -MarkdownRenderer.pillPad, dy: -1.5)
        let onScreen = window.convertToScreen(convert(pill, to: nil))
        chipCard = ChipCardWindow.show(card, below: onScreen, parent: window)
    }

    /// The link under `point` and where it goes: an asks card's link
    /// button (`.tbPeek`), a web link, or a file link or path in inline
    /// code that names a file.
    private func peek(at point: NSPoint) -> (range: NSRange, peek: LinkPeek)? {
        character(at: point).flatMap(peek(atCharacter:))
    }

    private func peek(atCharacter index: Int) -> (range: NSRange, peek: LinkPeek)? {
        forItsThread { peekInThread(atCharacter: index) }
    }

    private func peekInThread(atCharacter index: Int) -> (range: NSRange, peek: LinkPeek)? {
        guard let storage = textStorage, index < storage.length else { return nil }
        var range = NSRange()
        if let peek = storage.attribute(.tbPeek, at: index, effectiveRange: &range) as? LinkPeek {
            // An ask's file link in another Mac's thread: only this Mac's copy.
            guard peek.url.isFileURL else { return (range, peek) }
            guard let file = localCopy(peek.url) else { return nil }
            return (range, file == peek.url ? peek : LinkPeek(url: file, title: peek.title, pictureOnly: peek.pictureOnly))
        }
        if let chip = storage.attribute(.tbPictureChip, at: index, effectiveRange: &range) as? NSNumber {
            // The picture grid's file: the picture itself, or this Mac's
            // whole copy of one on another runner. Nothing while there's no
            // copy, or no grid to ask: the message's path is that Mac's,
            // and read here it named a file on this Mac that the drag then
            // handed out (Daybreak, 7 Nov).
            guard let file = pictureGrid?.localPath(chip.intValue) else { return nil }
            return (range, LinkPeek(url: URL(fileURLWithPath: file), title: PictureChip.label(chip.intValue + 1), pictureOnly: true))
        }
        // The longest range, as a link's words can change font part way
        // (a bold word in it) and the card belongs to the whole link.
        guard let link = storage.attribute(.link, at: index, longestEffectiveRange: &range,
                                           in: NSRange(location: 0, length: storage.length)) else { return nil }
        let words = storage.attributedSubstring(from: range).string.trimmingCharacters(in: .whitespacesAndNewlines)
        if let web = webURL(link) { return (range, LinkPeek(url: web, title: words)) }
        guard let url = link as? URL, url.isFileURL || FilePathRefs.text(of: url) != nil, let named = fileLinkTarget(url),
              let file = localCopy(named) else { return nil }
        // The file alone, for its thumbnail: a page's ?query isn't the file's.
        return (range, LinkPeek(url: URL(fileURLWithPath: file.path), title: words))
    }

    /// What a press on character `index` would drag out (FileDrag).
    func dragURL(atCharacter index: Int) -> URL? {
        peek(atCharacter: index).map(\.peek.url)
    }

    /// The index of the picture whose chip is under `point`, in Mike's bubble.
    private func pictureChip(at point: NSPoint) -> Int? {
        guard let index = character(at: point) else { return nil }
        return (textStorage?.attribute(.tbPictureChip, at: index, effectiveRange: nil) as? NSNumber)?.intValue
    }

    /// The pictures over this text in its row, which a chip's number indexes.
    private var pictureGrid: ImageGridView? {
        var view: NSView? = superview
        while let v = view, !(v is TextRowCell) { view = v.superview }
        guard let grid = (view as? TextRowCell)?.images, !grid.isHidden else { return nil }
        return grid
    }

    #if DEBUG
    func debugChips() -> [(word: String, threadId: String)] {
        guard let storage = textStorage else { return [] }
        return chips.map { (storage.attributedSubstring(from: $0.range).string, $0.threadId) }
    }

    /// Shows a chip's card as a hover would; returns its window number.
    func debugShowChip(_ word: String) -> Int? {
        guard let chip = debugChip(word) else { return nil }
        closeChipCard()
        hoveredChip = chip.range
        showChipCard(chip)
        return chipCard?.windowNumber
    }

    /// The links in this text that have a hover card: their words, then
    /// where they go.
    func debugPeeks() -> [(words: String, url: URL)] {
        guard let storage = textStorage, storage.length > 0 else { return [] }
        var found: [(String, URL)] = []
        var seen = Set<Int>()
        for index in 0..<storage.length where !seen.contains(index) {
            guard let link = peek(atCharacter: index) else { continue }
            seen.formUnion(link.range.location..<NSMaxRange(link.range))
            found.append((debugWords(link, in: storage).trimmingCharacters(in: .whitespacesAndNewlines.union(.init(charactersIn: "\u{00A0}↗"))), link.peek.url))
        }
        return found
    }

    /// Shows the card of the link whose words are `words`, as a hover
    /// would; returns its window number.
    func debugShowPeek(_ words: String) -> Int? {
        guard let storage = textStorage else { return nil }
        for index in 0..<storage.length {
            guard let link = peek(atCharacter: index),
                  // A button's title has no-break spaces.
                  debugWords(link, in: storage).replacingOccurrences(of: "\u{00A0}", with: " ").contains(words) else { continue }
            closeChipCard()
            hoveredChip = link.range
            showPeekCard(link)
            return chipCard?.windowNumber
        }
        return nil
    }

    /// A link's words; a chip's are its label, as its text is one U+FFFC.
    private func debugWords(_ link: (range: NSRange, peek: LinkPeek), in storage: NSTextStorage) -> String {
        link.peek.pictureOnly ? link.peek.title ?? "" : storage.attributedSubstring(from: link.range).string
    }

    /// A real press and release on the picture chip labelled `words`,
    /// through mouseDown: what opens, without Quick Look's panel coming up
    /// over Mike's work.
    func debugClickPictureChip(_ words: String) -> (paths: [String], index: Int)? {
        guard let storage = textStorage, let window else { return nil }
        for index in 0..<storage.length {
            guard let link = peek(atCharacter: index), link.peek.pictureOnly, link.peek.title == words,
                  let rect = chipRect(link.range) else { continue }
            let spot = convert(NSPoint(x: rect.midX, y: rect.midY), to: nil)
            func mouse(_ type: NSEvent.EventType) -> NSEvent? {
                NSEvent.mouseEvent(with: type, location: spot, modifierFlags: [], timestamp: ProcessInfo.processInfo.systemUptime,
                                   windowNumber: window.windowNumber, context: nil, eventNumber: 0, clickCount: 1, pressure: 1)
            }
            guard let down = mouse(.leftMouseDown), let up = mouse(.leftMouseUp) else { return nil }
            var opened: (paths: [String], index: Int)?
            QuickLookCoordinator.shared.debugOpened = { opened = ($0, $1) }
            defer { QuickLookCoordinator.shared.debugOpened = nil }
            window.postEvent(up, atStart: true)
            mouseDown(with: down)
            return opened
        }
        return nil
    }

    /// A middle-button press and release on the first link whose words
    /// have `words`, sent through the window so it lands wherever a real
    /// one would (the view under the pointer). False when there's no such link.
    func debugMiddleClick(_ words: String) -> Bool {
        guard let storage = textStorage, let window else { return false }
        let found = (storage.string as NSString).range(of: words)
        guard found.location != NSNotFound, let rect = chipRect(found) else { return false }
        let spot = convert(NSPoint(x: rect.midX, y: rect.midY), to: nil)
        for type in [NSEvent.EventType.otherMouseDown, .otherMouseUp] {
            // mouseEvent makes other-button events as button 0 and has no
            // way to say which; its CGEvent does, and keeps the window.
            guard let cg = NSEvent.mouseEvent(with: type, location: spot, modifierFlags: [], timestamp: ProcessInfo.processInfo.systemUptime,
                                              windowNumber: window.windowNumber, context: nil, eventNumber: 0, clickCount: 1, pressure: 1)?.cgEvent
            else { return false }
            cg.setIntegerValueField(.mouseEventButtonNumber, value: 2)
            guard let event = NSEvent(cgEvent: cg), event.buttonNumber == 2 else { return false }
            window.sendEvent(event)
        }
        return true
    }

    /// The right-click menu of the first link whose words have `words`.
    func debugLinkMenu(_ words: String) -> NSMenu? {
        guard let storage = textStorage else { return nil }
        let range = (storage.string as NSString).range(of: words)
        guard range.location != NSNotFound else { return nil }
        return fileLinkMenu(atCharacter: range.location)
    }

    func debugClickChip(_ word: String) {
        guard let chip = debugChip(word) else { return }
        closeChipCard()
        AppModel.shared.openThread(chip.threadId)
    }

    private func debugChip(_ word: String) -> (range: NSRange, threadId: String)? {
        guard let storage = textStorage else { return nil }
        return chips.first { storage.attributedSubstring(from: $0.range).string == word }
    }
    #endif

    func closeChipCard() {
        chipTimer?.invalidate()
        chipTimer = nil
        hoveredChip = nil
        chipCard?.dismiss()
        chipCard = nil
    }

    // Don't let a row's text view swallow scroll-wheel events or show an
    // insertion point; the table owns scrolling.
    override var acceptsFirstResponder: Bool { true }
    override func scrollWheel(with event: NSEvent) {
        closeChipCard()
        closeSelectionBar()
        nextResponder?.scrollWheel(with: event)
    }

    // MARK: The selection bar (SelectionBar.swift)

    /// The whole message this text is, for Explain; nil for rows that
    /// aren't a message (tools, notes, footers), which get no bar.
    var selectionMessage: String?
    private var selectionBar: SelectionBarWindow?
    /// Bumped by each selection change and bar click, so a show queued
    /// before one doesn't bring the bar back after it.
    private var selectionBarToken = 0

    override func setSelectedRanges(_ ranges: [NSValue], affinity: NSSelectionAffinity, stillSelecting: Bool) {
        super.setSelectedRanges(ranges, affinity: affinity, stillSelecting: stillSelecting)
        closeSelectionBar()
        // Once the drag or double-click has finished, after the text view
        // has drawn the selection.
        guard !stillSelecting, selectionMessage != nil, selectedRange().length > 0 else { return }
        selectionBarToken += 1
        let token = selectionBarToken
        DispatchQueue.main.async { [weak self] in
            guard let self, self.selectionBarToken == token else { return }
            self.showSelectionBar()
        }
    }

    override func resignFirstResponder() -> Bool {
        closeSelectionBar()
        return super.resignFirstResponder()
    }

    private func showSelectionBar() {
        closeSelectionBar()
        let range = selectedRange()
        guard let window, selectionMessage != nil, range.length > 0, window.firstResponder === self, !selectedText.isEmpty else { return }
        let first = firstRect(forCharacterRange: NSRange(location: range.location, length: 0), actualRange: nil)
        var last = firstRect(forCharacterRange: NSRange(location: NSMaxRange(range) - 1, length: 1), actualRange: nil)
        if last.isEmpty { last = first }
        // firstRect is in screen coordinates already; the bar sits over the
        // first line's top and drops below the last line's bottom.
        let span = NSRect(x: first.minX, y: last.minY, width: max(first.width, 1), height: first.maxY - last.minY)
        let scroller = enclosingScrollView ?? superview
        let column = scroller.map { window.convertToScreen($0.convert($0.bounds, to: nil)) } ?? .zero
        selectionBar = SelectionBarWindow.show(above: span, within: column, parent: window) { [weak self] action in
            MainActor.assumeIsolated { self?.selectionAction(action) }
        }
    }

    private var selectedText: String {
        let range = selectedRange()
        guard let storage = textStorage, range.length > 0, NSMaxRange(range) <= storage.length else { return "" }
        return Self.wordsWithCards(storage.attributedSubstring(from: range)).trimmingCharacters(in: .whitespacesAndNewlines)
    }

    /// A selection's words, with each card chip as its title, as its text is
    /// one U+FFFC.
    private static func wordsWithCards(_ selection: NSAttributedString) -> String {
        let out = NSMutableString(string: selection.string)
        selection.enumerateAttributes(in: NSRange(location: 0, length: selection.length), options: .reverse) { attributes, range, _ in
            if let title = attributes[.tbCardChip] as? String { out.replaceCharacters(in: range, with: title) }
            // A ```mermaid or ```html box copies as its fenced source.
            else if let source = attributes[.tbCopyText] as? String { out.replaceCharacters(in: range, with: source) }
        }
        return out as String
    }

    // A copy with a card chip in it is its words and card titles, as a plain
    // copy would otherwise paste an empty box for each chip. Every copy also
    // carries HTML, as Slack and the web only keep links from that.
    override func writeSelection(to pboard: NSPasteboard, types: [NSPasteboard.PasteboardType]) -> Bool {
        let range = selectedRange()
        guard let storage = textStorage, range.length > 0, NSMaxRange(range) <= storage.length else { return super.writeSelection(to: pboard, types: types) }
        let selection = storage.attributedSubstring(from: range)
        var hasCard = false
        selection.enumerateAttributes(in: NSRange(location: 0, length: selection.length)) { attributes, _, stop in
            if attributes[.tbCardChip] != nil || attributes[.tbCopyText] != nil {
                hasCard = true
                stop.pointee = true
            }
        }
        guard hasCard else {
            guard super.writeSelection(to: pboard, types: types) else { return false }
            pboard.addTypes([.html], owner: nil)
            pboard.setString(SelectionHTML.html(selection), forType: .html)
            return true
        }
        return Self.write(Self.wordsWithCards(selection), html: selection, to: pboard)
    }

    private static func write(_ text: String, html selection: NSAttributedString, to pboard: NSPasteboard) -> Bool {
        pboard.declareTypes([.string, .html], owner: nil)
        pboard.setString(SelectionHTML.html(selection), forType: .html)
        return pboard.setString(text, forType: .string)
    }

    private func selectionAction(_ action: SelectionBarWindow.Action) {
        let text = selectedText
        selectionBarToken += 1
        closeSelectionBar()
        guard !text.isEmpty else { return }
        let app = AppModel.shared
        switch action {
        case .explain:
            guard let threadId = transcriptThreadId else { return }
            app.explain(text, message: selectionMessage, in: threadId)
        case .quote:
            guard let threadId = transcriptThreadId else { return }
            app.quoteInComposer(text, in: threadId)
        case .copy:
            let range = selectedRange()
            guard let storage = textStorage, NSMaxRange(range) <= storage.length else { return }
            _ = Self.write(text, html: storage.attributedSubstring(from: range), to: .general)
        }
    }

    /// The thread whose transcript this text is in: the main panel's, or
    /// one open in a panel of its own. A reply button is only pressed from
    /// its own thread's transcript, so a `button:` link an agent copied
    /// from another thread can't press that thread's (Codex's review, 7 Nov).
    private var transcriptThreadId: String? {
        var view = superview
        while let v = view, !(v is TranscriptTableView) { view = v.superview }
        return (view as? TranscriptTableView)?.controller?.session?.threadId ?? AppModel.shared.selection
    }

    func closeSelectionBar() {
        selectionBar?.dismiss()
        selectionBar = nil
    }

    #if DEBUG
    /// Selects the first match of `words` and runs a bar action as a click
    /// would; false when they're not in this text.
    func debugSelect(_ words: String, then action: SelectionBarWindow.Action?) -> Bool {
        guard let storage = textStorage else { return false }
        let found = (storage.string as NSString).range(of: words)
        guard found.location != NSNotFound else { return false }
        window?.makeFirstResponder(self)
        setSelectedRange(found)
        if let action { selectionAction(action) } else { showSelectionBar() }
        return true
    }

    var debugSelectionBarWindow: Int? { selectionBar?.windowNumber }
    #endif

    /// The file a link names, as a file URL with any ?query kept, for its
    /// right-click menu (nil for a path that names nothing). Only asked of
    /// file links and inline code paths.
    var fileLinkTarget: (URL) -> URL? = { url in
        MainActor.assumeIsolated { AppModel.shared.transcriptLinkFile(url) }
    }
    var openFile: (URL, FileLinkAction) -> Void = { url, action in
        MainActor.assumeIsolated { _ = AppModel.shared.openTranscriptFile(url, action) }
    }

    var openWeb: (URL, WebLinkAction) -> Void = { url, action in
        MainActor.assumeIsolated { _ = AppModel.shared.openTranscriptWebLink(url, action) }
    }

    /// The file on this Mac a hover card or a drag may use for a file link
    /// (AppModel.localCopy): another Mac's only once there's a whole copy.
    var localCopy: (URL) -> URL? = { url in
        MainActor.assumeIsolated { AppModel.shared.localCopy(of: url, in: AppModel.shared.linkThread) }
    }

    /// The right-click menu for the file or web link under `point` (in
    /// this view), if there's one there.
    func fileLinkMenu(at point: NSPoint) -> NSMenu? {
        guard let storage = textStorage, let layoutManager, let container = textContainer, storage.length > 0 else { return nil }
        let inContainer = NSPoint(x: point.x - textContainerOrigin.x, y: point.y - textContainerOrigin.y)
        var fraction: CGFloat = 0
        let glyph = layoutManager.glyphIndex(for: inContainer, in: container, fractionOfDistanceThroughGlyph: &fraction)
        // glyphIndex gives the nearest glyph; only a click on it counts.
        guard layoutManager.boundingRect(forGlyphRange: NSRange(location: glyph, length: 1), in: container).contains(inContainer) else { return nil }
        return fileLinkMenu(atCharacter: layoutManager.characterIndexForGlyph(at: glyph))
    }

    func fileLinkMenu(atCharacter index: Int) -> NSMenu? {
        guard let storage = textStorage, index < storage.length, let link = storage.attribute(.link, at: index, effectiveRange: nil) else { return nil }
        if let web = webURL(link) { return WebLinkMenu(url: web, open: openWeb).menu() }
        guard let url = link as? URL, url.isFileURL || FilePathRefs.text(of: url) != nil else { return nil }
        // The menu's choice comes after this returns, so it carries the
        // thread with it.
        let threadId = linkThreadId, open = openFile
        let file = forItsThread(threadId) { fileLinkTarget(url) }
        return FileLinkMenu(file: file, open: { [weak self] url, action in
            guard let self else { return }
            self.forItsThread(threadId) { open(url, action) }
        }).menu()
    }

    override func menu(for event: NSEvent) -> NSMenu? {
        if let menu = fileLinkMenu(at: convert(event.locationInWindow, from: nil)) { return menu }
        // Defer to the table's row menu (Copy message, Copy transcript) with
        // text-specific items first when there's a selection.
        let base = super.menu(for: event) ?? NSMenu()
        if let tableMenu = enclosingTableMenu(for: event) {
            if selectedRange().length == 0 { return tableMenu }
            base.addItem(.separator())
            for item in tableMenu.items { base.addItem(item.copy() as! NSMenuItem) }
        }
        return base
    }

    private func enclosingTableMenu(for event: NSEvent) -> NSMenu? {
        var view: NSView? = superview
        while let current = view {
            if let table = current as? TranscriptTableView {
                return table.menu(for: event)
            }
            view = current.superview
        }
        return nil
    }
}


/// A tip over one of a rich box's buttons (TranscriptTextView.placeRichTips).
final class RichTipAnchor: TipAnchorView {}
