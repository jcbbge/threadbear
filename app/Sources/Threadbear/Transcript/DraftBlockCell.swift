import AppKit
import ThreadbearCore

/// The header of a ```slack, ```email or ```draft box (DraftBlock): what it
/// is on the left, Copy on the right. Only the header is an attachment;
/// the draft's lines under it are ordinary text in the same box
/// (MarkdownRenderer.draftBlock), so they can be selected and their links
/// clicked like the rest of the reply.
final class DraftBlockCell: NSTextAttachmentCell {
    let draft: DraftBlock

    init(draft: DraftBlock) {
        self.draft = draft
        super.init()
    }

    required init(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    static var height: CGFloat { zoomed(22) }
    static let tip = "Copy the draft, with its links and formatting"
    private static var labelFont: NSFont { .systemFont(ofSize: TypeScale.detail, weight: .medium) }
    private static var buttonFont: NSFont { .systemFont(ofSize: TypeScale.detail) }

    // MARK: Copied

    /// When each draft was last copied, by its source, so the button says
    /// Copied for a moment. Read when drawing, so no render is needed.
    // Only touched on the main thread (clicks and drawing).
    nonisolated(unsafe) private static var copied: [String: Date] = [:]
    static let copiedFor: TimeInterval = 1.5
    /// Where a click's Copy goes; tests give it a pasteboard of their own.
    nonisolated(unsafe) static var pasteboard: NSPasteboard = .general

    func wasJustCopied(now: Date = Date()) -> Bool {
        guard let at = Self.copied[draft.source] else { return false }
        return now.timeIntervalSince(at) < Self.copiedFor
    }

    /// Puts the draft on the clipboard as plain text and as HTML, so a
    /// paste into Slack or Mail keeps its links and bold.
    /// Not `copy(to:)`: called with no pasteboard, that name is NSCell's
    /// own copy(), which makes a shallow copy of the cell whose release
    /// crashed the app on the first click of Copy (7 Nov).
    func copyDraft(to pasteboard: NSPasteboard = DraftBlockCell.pasteboard) {
        pasteboard.clearContents()
        pasteboard.declareTypes([.html, .string], owner: nil)
        pasteboard.setString(draft.html, forType: .html)
        pasteboard.setString(draft.plainText, forType: .string)
        Self.copied[draft.source] = Date()
    }

    // MARK: Layout

    override func cellFrame(for textContainer: NSTextContainer, proposedLineFragment lineFrag: NSRect, glyphPosition position: NSPoint, characterIndex charIndex: Int) -> NSRect {
        let width = max(zoomed(160), floor(lineFrag.width - position.x))
        return NSRect(x: 0, y: 0, width: width, height: Self.height)
    }

    override func cellSize() -> NSSize { NSSize(width: zoomed(600), height: Self.height) }
    override func cellBaselineOffset() -> NSPoint { .zero }
    override func wantsToTrackMouse() -> Bool { false }

    private func buttonTitle(copied: Bool) -> NSAttributedString {
        NSAttributedString(string: copied ? "Copied" : "Copy", attributes: [.font: Self.buttonFont, .foregroundColor: copied ? NSColor.systemGreen : NSColor.secondaryLabelColor])
    }

    /// The Copy button, at the right of `frame` (as wide as "Copied", so
    /// it doesn't move when it changes).
    func button(in frame: NSRect) -> NSRect {
        let text = ceil(buttonTitle(copied: true).size().width)
        let width = zoomed(14) + zoomed(5) + text + zoomed(12)
        let height = zoomed(20)
        return NSRect(x: frame.maxX - width + zoomed(6), y: frame.midY - height / 2, width: width, height: height)
    }

    func isButton(at point: NSPoint, in frame: NSRect) -> Bool {
        button(in: frame).insetBy(dx: -2, dy: -3).contains(point)
    }

    // MARK: Drawing

    override func draw(withFrame cellFrame: NSRect, in controlView: NSView?) {
        let label = NSAttributedString(string: draft.label, attributes: [.font: Self.labelFont, .foregroundColor: NSColor.secondaryLabelColor])
        let size = label.size()
        label.draw(at: NSPoint(x: cellFrame.minX, y: cellFrame.midY - size.height / 2))

        let rect = button(in: cellFrame)
        let copied = wasJustCopied()
        let title = buttonTitle(copied: copied)
        // Green with a tick for a moment after a click (Mike, 7 Nov).
        let symbol = copied ? "checkmark" : "doc.on.doc"
        let config = NSImage.SymbolConfiguration(pointSize: TypeScale.detail - 1, weight: copied ? .bold : .regular)
            .applying(.init(paletteColors: [copied ? .systemGreen : .secondaryLabelColor]))
        var x = rect.minX + zoomed(6)
        if let image = NSImage(systemSymbolName: symbol, accessibilityDescription: nil)?.withSymbolConfiguration(config) {
            let s = image.size
            image.draw(in: NSRect(x: x + (zoomed(14) - s.width) / 2, y: rect.midY - s.height / 2, width: s.width, height: s.height),
                       from: .zero, operation: .sourceOver, fraction: 1, respectFlipped: true, hints: nil)
        }
        x += zoomed(14) + zoomed(5)
        let titleSize = title.size()
        title.draw(at: NSPoint(x: x, y: rect.midY - titleSize.height / 2))
    }
}
