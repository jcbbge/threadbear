import AppKit
import SwiftUI

extension View {
    /// A tooltip, shown after a short hover, and VoiceOver's hint. Use this
    /// rather than `.help` everywhere outside a menu. `.help` set its text
    /// (the accessibility tree had it on every activity bar icon) but the
    /// tooltip never came up in this window on macOS 26, so these are drawn
    /// here: a tracking area on a view behind the control, and one small
    /// panel. Menu items keep `.help`, which AppKit shows for them itself.
    func tip(_ text: String) -> some View {
        modifier(TipModifier(text: text))
    }
}

/// A small ⓘ with the explanation behind it, so the visible text stays short.
/// Clicking opens it in a popover (Mike's preference: a hover is easy to miss
/// and doesn't work for everyone), and the text can be selected there; hovering
/// still shows it as a tip, for a quick look.
struct InfoTip: View {
    let text: String
    @State private var open = false

    init(_ text: String) { self.text = text }

    var body: some View {
        Button { open.toggle() } label: {
            Image(systemName: "info.circle")
                .font(.system(size: 11))
                .foregroundStyle(.secondary)
                // A little bigger than the icon, as it's small to aim at.
                .padding(2)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        // No tip over its own popover saying the same thing.
        .tip(open ? "" : text)
        .accessibilityLabel(text)
        .popover(isPresented: $open, arrowEdge: .bottom) {
            Text(text)
                .font(.system(size: zoomed(12)))
                .textSelection(.enabled)
                .frame(width: zoomed(280), alignment: .leading)
                .fixedSize(horizontal: false, vertical: true)
                .padding(12)
        }
    }
}

private struct TipModifier: ViewModifier {
    let text: String

    func body(content: Content) -> some View {
        content
            // Behind the control, and never hit: tracking areas fire
            // whatever is on top, so clicks still reach the control.
            .background(TipAnchor(text: text).allowsHitTesting(false))
            .accessibilityHint(text)
    }
}

private struct TipAnchor: NSViewRepresentable {
    let text: String

    func makeNSView(context: Context) -> TipAnchorView {
        let view = TipAnchorView()
        view.text = text
        return view
    }

    func updateNSView(_ view: TipAnchorView, context: Context) {
        view.text = text
    }

    static func dismantleNSView(_ view: TipAnchorView, coordinator: ()) {
        Tips.shared.exit(view)
    }
}

class TipAnchorView: NSView {
    /// Changes while a tip is up are shown in it ("Working 12s").
    var text = "" {
        didSet { if text != oldValue { Tips.shared.textChanged(self) } }
    }

    private var tracking: NSTrackingArea?

    override func hitTest(_ point: NSPoint) -> NSView? { nil }

    override func updateTrackingAreas() {
        super.updateTrackingAreas()
        if let tracking { removeTrackingArea(tracking) }
        // Always, not only in the key window: Mike often points at the
        // sidebar while typing in another app. `Tips` checks the window is
        // the one under the pointer before showing anything.
        let area = NSTrackingArea(rect: .zero, options: [.mouseEnteredAndExited, .activeAlways, .inVisibleRect], owner: self)
        addTrackingArea(area)
        tracking = area
    }

    override func mouseEntered(with event: NSEvent) { Tips.shared.enter(self) }
    override func mouseExited(with event: NSEvent) { Tips.shared.exit(self) }

    override func viewWillMove(toWindow newWindow: NSWindow?) {
        super.viewWillMove(toWindow: newWindow)
        if newWindow == nil { Tips.shared.exit(self) }
    }

    override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        Tips.shared.placed(self)
    }
}

extension NSView {
    /// `.tip` for the transcript's AppKit views, in place of `toolTip`, so
    /// they come up and look like every other tip in the app. Empty takes
    /// it away.
    func setTip(_ text: String) {
        let anchor = subviews.lazy.compactMap { $0 as? TipAnchorView }.first ?? {
            let anchor = TipAnchorView(frame: bounds)
            anchor.autoresizingMask = [.width, .height]
            addSubview(anchor)
            return anchor
        }()
        anchor.text = text
        setAccessibilityHelp(text.isEmpty ? nil : text)
    }

    /// Puts this view's tip up straight away, for a mark whose click is
    /// asking what it means. The click itself took any tip down first.
    func showTipNow() {
        guard let anchor = subviews.lazy.compactMap({ $0 as? TipAnchorView }).first else { return }
        Tips.shared.showNow(anchor)
    }
}

/// Which tip is up, and the panel it's in. One for the whole app, as
/// AppKit's own tooltips are.
@MainActor
final class Tips {
    static let shared = Tips()

    /// About AppKit's own wait, a little quicker: Mike hovers to find out
    /// what something is, and a long wait reads as no tooltip at all.
    static let delay: TimeInterval = 0.7
    /// Moving straight from one tip to the next shows it at once, as
    /// AppKit's do when you run the pointer along a toolbar.
    static let scrubWindow: TimeInterval = 0.5

    /// Anchors the pointer is in, outermost first: a button's tip wins over
    /// the row it sits in.
    private var inside: [TipAnchorView] = []
    private weak var shown: TipAnchorView?
    /// Clicked or typed at: its tip stays down until the pointer leaves.
    private weak var dismissed: TipAnchorView?
    private var timer: Timer?
    private var lastHidden = Date.distantPast
    private lazy var panel = TipPanel()
    /// Every anchor in a window, so the activity log can name what's under
    /// a click (`text(at:in:)`).
    private let placedAnchors = NSHashTable<TipAnchorView>.weakObjects()

    private init() {
        // A click, a key or a scroll puts the tip away, as AppKit does.
        NSEvent.addLocalMonitorForEvents(matching: [.leftMouseDown, .rightMouseDown, .otherMouseDown, .keyDown, .scrollWheel]) { [weak self] event in
            self?.dismiss()
            return event
        }
        NotificationCenter.default.addObserver(forName: NSApplication.didResignActiveNotification, object: nil, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated { self?.dismiss() }
        }
    }

    func enter(_ anchor: TipAnchorView) {
        inside.removeAll { $0 === anchor }
        inside.append(anchor)
        refresh()
    }

    func exit(_ anchor: TipAnchorView) {
        inside.removeAll { $0 === anchor }
        if dismissed === anchor { dismissed = nil }
        refresh()
    }

    func showNow(_ anchor: TipAnchorView) {
        timer?.invalidate()
        timer = nil
        if dismissed === anchor { dismissed = nil }
        if shown !== anchor { hide() }
        // At the anchor rather than the pointer, and without hover's check
        // for the window under the pointer: the click was the asking.
        guard let window = anchor.window, window.isVisible else { return }
        let rect = window.convertToScreen(anchor.convert(anchor.bounds, to: nil))
        shown = anchor
        panel.show(anchor.text, at: NSPoint(x: rect.minX, y: rect.maxY), on: window.screen)
    }

    func placed(_ anchor: TipAnchorView) {
        if anchor.window == nil { placedAnchors.remove(anchor) } else { placedAnchors.add(anchor) }
    }

    /// The tip of what's at `point` (in the window's coordinates), for the
    /// activity log: the smallest anchor there, so a button's tip wins over
    /// the row it sits in. Found by where the anchors are rather than by
    /// the pointer's enter and exit, which a click can come before.
    func text(at point: NSPoint, in window: NSWindow) -> String? {
        var best: (area: CGFloat, text: String)?
        for anchor in placedAnchors.allObjects where anchor.window === window && !anchor.text.isEmpty && !anchor.isHiddenOrHasHiddenAncestor {
            // Its own bounds as well as what's visible of it: since macOS 14
            // views don't clip, and visibleRect then runs past the view.
            let local = anchor.convert(point, from: nil)
            guard anchor.bounds.contains(local), anchor.visibleRect.contains(local) else { continue }
            let area = anchor.bounds.width * anchor.bounds.height
            if area < best?.area ?? .infinity { best = (area, anchor.text) }
        }
        return best?.text
    }

    func textChanged(_ anchor: TipAnchorView) {
        if shown === anchor {
            if anchor.text.isEmpty { hide() } else { panel.update(anchor.text) }
        } else if inside.contains(where: { $0 === anchor }) {
            refresh()
        }
    }

    private var current: TipAnchorView? {
        inside.last { !$0.text.isEmpty && $0.window != nil }
    }

    private func refresh() {
        let target = current
        guard target !== shown else { return }
        timer?.invalidate()
        timer = nil
        if shown != nil { hide() }
        guard let target, target !== dismissed else { return }
        let wait = Date().timeIntervalSince(lastHidden) < Self.scrubWindow ? 0.05 : Self.delay
        timer = Timer.scheduledTimer(withTimeInterval: wait, repeats: false) { [weak self, weak target] _ in
            MainActor.assumeIsolated {
                guard let self, let target, self.current === target else { return }
                self.show(target)
            }
        }
    }

    private func show(_ anchor: TipAnchorView) {
        guard let window = anchor.window, window.isVisible else { return }
        let mouse = NSEvent.mouseLocation
        // Only in the window that's actually under the pointer, so a tip
        // never comes up through another app's window on top of ours.
        guard NSWindow.windowNumber(at: mouse, belowWindowWithWindowNumber: 0) == window.windowNumber else { return }
        shown = anchor
        panel.show(anchor.text, at: mouse, on: window.screen)
        ActivityRecorder.shared.hover(anchor.text, in: window)
    }

    private func hide() {
        guard shown != nil else { return }
        shown = nil
        lastHidden = Date()
        panel.orderOut(nil)
    }

    private func dismiss() {
        timer?.invalidate()
        timer = nil
        dismissed = shown ?? current
        hide()
        // Not a scrub: the next tip waits its turn.
        lastHidden = .distantPast
    }
}

/// AppKit's tooltip look: the tooltip material, its font, a hairline edge,
/// under the pointer and kept on screen.
private final class TipPanel: NSPanel {
    private let label = NSTextField(wrappingLabelWithString: "")
    private let padding = NSSize(width: 7, height: 3)
    private static let maxWidth: CGFloat = 320

    init() {
        super.init(contentRect: .zero, styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: true)
        isOpaque = false
        backgroundColor = .clear
        hasShadow = true
        ignoresMouseEvents = true
        isReleasedWhenClosed = false
        hidesOnDeactivate = false
        // Over popovers and the sidebar's menus, like AppKit's.
        level = .popUpMenu
        collectionBehavior = [.transient, .ignoresCycle, .fullScreenAuxiliary]

        let background = NSVisualEffectView()
        background.material = .toolTip
        background.state = .active
        background.wantsLayer = true
        background.layer?.cornerRadius = 5
        background.layer?.masksToBounds = true
        background.layer?.borderWidth = 0.5
        background.layer?.borderColor = NSColor.separatorColor.cgColor
        label.isSelectable = false
        label.textColor = .labelColor
        background.addSubview(label)
        contentView = background
    }

    /// Where the pointer was when the tip came up, so new text in it
    /// ("Working 12s") keeps it in place.
    private var pointer = NSPoint.zero

    func show(_ text: String, at mouse: NSPoint, on screen: NSScreen?) {
        pointer = mouse
        update(text, at: mouse, on: screen)
        orderFrontRegardless()
    }

    /// New text in the tip that's up, where it is.
    func update(_ text: String) {
        update(text, at: pointer, on: screen)
    }

    /// Below the pointer's arrow, as AppKit puts them.
    private static let belowPointer: CGFloat = 22

    private func update(_ text: String, at mouse: NSPoint, on screen: NSScreen?) {
        label.font = .toolTipsFont(ofSize: zoomed(NSFont.smallSystemFontSize))
        label.stringValue = text
        let fits = label.cell?.cellSize(forBounds: NSRect(x: 0, y: 0, width: Self.maxWidth, height: .greatestFiniteMagnitude)) ?? label.fittingSize
        let textSize = NSSize(width: ceil(min(fits.width, Self.maxWidth)), height: ceil(fits.height))
        let size = NSSize(width: textSize.width + padding.width * 2, height: textSize.height + padding.height * 2)
        label.frame = NSRect(origin: NSPoint(x: padding.width, y: padding.height), size: textSize)

        var origin = NSPoint(x: mouse.x, y: mouse.y - Self.belowPointer - size.height)
        if let visible = (screen ?? NSScreen.main)?.visibleFrame {
            origin.x = min(max(origin.x, visible.minX + 4), visible.maxX - size.width - 4)
            // No room below: above the pointer instead.
            if origin.y < visible.minY + 4 { origin.y = mouse.y + 6 }
        }
        setFrame(NSRect(origin: origin, size: size), display: true)
        // The border colour is a dynamic colour; resolve it for this look.
        effectiveAppearance.performAsCurrentDrawingAppearance {
            contentView?.layer?.borderColor = NSColor.separatorColor.cgColor
        }
    }
}
