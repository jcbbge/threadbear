import AppKit

/// The little "Copied" bubble with a green tick that pops up over a button
/// after it copies something (a draft's Copy, DraftBlockCell). Mike, 7 Nov:
/// the button changing alone was easy to miss. It pops in, waits and fades,
/// all in Core Animation, so a busy main thread can't stall it, then takes
/// itself out of the view.
final class CopiedBubble: NSView {
    static let shown: TimeInterval = 1.1

    /// Shows one centred above `rect` (in `view`'s coordinates), replacing
    /// any bubble already there.
    @discardableResult
    static func show(above rect: NSRect, in view: NSView) -> CopiedBubble {
        view.subviews.compactMap { $0 as? CopiedBubble }.forEach { $0.removeFromSuperview() }
        let bubble = CopiedBubble()
        let size = bubble.fittingSize
        let gap = zoomed(4)
        let y = view.isFlipped ? rect.minY - gap - size.height : rect.maxY + gap
        // Kept inside the view, so the right-hand edge of a box doesn't cut it off.
        let x = min(max(rect.midX - size.width / 2, view.bounds.minX), view.bounds.maxX - size.width)
        bubble.frame = NSRect(x: x, y: max(view.bounds.minY, y), width: size.width, height: size.height)
        view.addSubview(bubble)
        bubble.play()
        return bubble
    }

    private init() {
        super.init(frame: .zero)
        wantsLayer = true
        let layer = self.layer!
        layer.cornerRadius = zoomed(8)
        layer.borderWidth = 0.5
        layer.shadowOpacity = 0.18
        layer.shadowRadius = zoomed(6)
        layer.shadowOffset = CGSize(width: 0, height: -1)
        setAccessibilityElement(true)
        setAccessibilityRole(.staticText)
        setAccessibilityLabel("Copied to clipboard")

        let tick = NSImageView()
        let config = NSImage.SymbolConfiguration(pointSize: TypeScale.detail, weight: .semibold).applying(.init(paletteColors: [.white, .systemGreen]))
        tick.image = NSImage(systemSymbolName: "checkmark.circle.fill", accessibilityDescription: nil)?.withSymbolConfiguration(config)
        let label = NSTextField(labelWithString: "Copied to clipboard")
        label.font = .systemFont(ofSize: TypeScale.detail, weight: .medium)
        label.textColor = .labelColor
        let row = NSStackView(views: [tick, label])
        row.spacing = zoomed(5)
        row.edgeInsets = NSEdgeInsets(top: zoomed(4), left: zoomed(8), bottom: zoomed(4), right: zoomed(10))
        row.translatesAutoresizingMaskIntoConstraints = false
        addSubview(row)
        NSLayoutConstraint.activate([
            row.leadingAnchor.constraint(equalTo: leadingAnchor), row.trailingAnchor.constraint(equalTo: trailingAnchor),
            row.topAnchor.constraint(equalTo: topAnchor), row.bottomAnchor.constraint(equalTo: bottomAnchor),
        ])
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    override func updateLayer() {
        // Colours follow the look, read when the layer's drawn.
        layer?.backgroundColor = NSColor.windowBackgroundColor.cgColor
        layer?.borderColor = Theme.cardBorder.cgColor
    }

    override var wantsUpdateLayer: Bool { true }
    // Clicks go through to the text under it.
    override func hitTest(_ point: NSPoint) -> NSView? { nil }

    private func play() {
        guard let layer else { return }
        // A small rise as it appears (a scale would grow from the layer's
        // corner, where AppKit puts its anchor).
        let pop = CABasicAnimation(keyPath: "transform.translation.y")
        pop.fromValue = zoomed(-4)
        pop.toValue = 0
        pop.duration = 0.18
        pop.timingFunction = CAMediaTimingFunction(name: .easeOut)
        let appear = CABasicAnimation(keyPath: "opacity")
        appear.fromValue = 0
        appear.toValue = 1
        appear.duration = 0.12
        let fade = CABasicAnimation(keyPath: "opacity")
        fade.fromValue = 1
        fade.toValue = 0
        fade.beginTime = Self.shown - 0.25
        fade.duration = 0.25
        let all = CAAnimationGroup()
        all.animations = [pop, appear, fade]
        all.duration = Self.shown
        all.fillMode = .forwards
        all.isRemovedOnCompletion = false
        CATransaction.begin()
        CATransaction.setCompletionBlock { [weak self] in self?.removeFromSuperview() }
        layer.add(all, forKey: "copied")
        CATransaction.commit()
    }
}
