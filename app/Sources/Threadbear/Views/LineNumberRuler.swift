import AppKit

/// Line numbers down the editor's left side, one for each line of the
/// file (not each wrapped row), the current line's brighter. The pane's
/// text view shows them while a file is being edited (TextFileView).
final class LineNumberRuler: NSRulerView {
    private weak var textView: NSTextView?

    init(textView: NSTextView) {
        self.textView = textView
        super.init(scrollView: textView.enclosingScrollView, orientation: .verticalRuler)
        clientView = textView
        ruleThickness = 44
        clipsToBounds = true
        NotificationCenter.default.addObserver(self, selector: #selector(redraw), name: NSView.boundsDidChangeNotification, object: textView.enclosingScrollView?.contentView)
        NotificationCenter.default.addObserver(self, selector: #selector(redraw), name: NSTextView.didChangeSelectionNotification, object: textView)
    }

    required init(coder: NSCoder) { fatalError() }

    @objc private func redraw() { needsDisplay = true }

    /// Only the numbers and a hairline on the gutter's own edge; the
    /// default border ran up past the editor.
    override func draw(_ dirtyRect: NSRect) {
        drawHashMarksAndLabels(in: dirtyRect)
        NSColor.separatorColor.setFill()
        NSRect(x: bounds.maxX - 0.5, y: bounds.minY, width: 0.5, height: bounds.height).fill()
    }

    override func drawHashMarksAndLabels(in rect: NSRect) {
        guard let textView, let layout = textView.layoutManager, let container = textView.textContainer else { return }
        NSColor.windowBackgroundColor.setFill()
        bounds.fill()
        let text = textView.string as NSString
        let font = NSFont.monospacedDigitSystemFont(ofSize: TypeScale.scaled(11), weight: .regular)
        let caret = text.lineRange(for: NSRange(location: min(textView.selectedRange().location, text.length), length: 0)).location
        let visible = textView.visibleRect
        let glyphs = layout.glyphRange(forBoundingRect: visible, in: container)
        let chars = layout.characterRange(forGlyphRange: glyphs, actualGlyphRange: nil)
        // The line number of the first visible line.
        var number = 1
        text.enumerateSubstrings(in: NSRange(location: 0, length: chars.location), options: [.byLines, .substringNotRequired]) { _, _, _, _ in number += 1 }
        var index = chars.location
        let inset = textView.textContainerInset.height
        func draw(_ n: Int, at line: NSRange, y: CGFloat) {
            let current = line.location == caret
            let label = "\(n)" as NSString
            let attributes: [NSAttributedString.Key: Any] = [.font: font, .foregroundColor: current ? NSColor.secondaryLabelColor : NSColor.tertiaryLabelColor]
            let size = label.size(withAttributes: attributes)
            label.draw(at: NSPoint(x: ruleThickness - size.width - 8, y: y), withAttributes: attributes)
        }
        while index <= NSMaxRange(chars) {
            let line = text.lineRange(for: NSRange(location: index, length: 0))
            let glyph = layout.glyphIndexForCharacter(at: min(line.location, max(text.length - 1, 0)))
            var lineRect = text.length == 0 ? NSRect(x: 0, y: 0, width: 0, height: font.boundingRectForFont.height + 4) : layout.lineFragmentRect(forGlyphAt: glyph, effectiveRange: nil)
            lineRect.origin.y += inset
            let y = convert(NSPoint(x: 0, y: lineRect.minY), from: textView).y + 3
            draw(number, at: line, y: y)
            number += 1
            if NSMaxRange(line) <= index || NSMaxRange(line) >= text.length { break }
            index = NSMaxRange(line)
        }
        // The empty last line after a final newline gets its number too.
        if text.length > 0, text.hasSuffix("\n"), NSMaxRange(chars) >= text.length {
            let rect = layout.extraLineFragmentRect
            let y = convert(NSPoint(x: 0, y: rect.minY + inset), from: textView).y + 3
            draw(number, at: NSRange(location: text.length, length: 0), y: y)
        }
    }
}
