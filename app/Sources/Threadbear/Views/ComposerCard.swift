import AppKit
import SwiftUI
import ThreadbearCore

/// The open card (Needs you, or Done with its follow-ups) at the top of
/// the composer, over a line, so the card and the box it's answered in
/// read as one thing. Mike picked that from mockups on 30 Oct; it was
/// first built as a card at the end of the transcript, which he didn't
/// recognise as what he'd chosen. The card is drawn as it was in the
/// transcript: a bare TextRowCell, its clicks going to the transcript's
/// controller, which looks after the thread on show.
///
/// A card of asks can be collapsed to its heading with the chevron at its
/// top right, to read the reply behind it (Mike, 30 Oct).
struct ComposerCard: NSViewRepresentable {
    let row: TranscriptRow
    var collapsed = false
    let controller: TranscriptController

    func makeNSView(context: Context) -> ComposerCardHost {
        ComposerCardHost(controller: controller)
    }

    func updateNSView(_ view: ComposerCardHost, context: Context) {
        view.attach(controller)
        view.show(row, collapsed: collapsed)
    }

    /// SwiftUI asks this many times a layout pass, once for each stack
    /// the card sits in and for each probe, and the window asks again for
    /// its smallest size. Building the card every time (each page of it,
    /// with its symbol images) froze the app for 5 to 19 seconds (5 Nov,
    /// THREADBEAR-X), so the host answers from the card it built last.
    func sizeThatFits(_ proposal: ProposedViewSize, nsView: ComposerCardHost, context: Context) -> CGSize? {
        let width = ComposerCardHost.measuringWidth(proposal.width)
        let full = nsView.rendered(row, width: width, collapsed: collapsed).height
        return CGSize(width: width, height: min(full, nsView.maxHeight))
    }
}

final class ComposerCardHost: NSView {
    private let cell = TextRowCell()
    /// A card taller than `maxHeight` scrolls inside the box: three asks
    /// with their buttons pushed the agent's reply off the top.
    private let scroll = NSScrollView()
    private let document = FlippedView()
    private weak var controller: TranscriptController?
    private var row: TranscriptRow?
    private var collapsed = false
    /// A real button rather than a `.tbAction` run like the pager's, so it
    /// has a tooltip, and stays put while a tall card scrolls under it.
    private let toggle = NSHostingView(rootView: CardCollapseButton(collapsed: false, action: {}))
    private var shown: (row: TranscriptRow, collapsed: Bool, width: CGFloat, zoom: Int, local: Bool)?
    /// The Something else box to put the cursor in once the card has made
    /// room for it (picking it and the card growing happen a beat apart).
    private var pendingFocus: Int?
    /// The ask a paged card is showing, and the card it's for: a new card
    /// opens on its first unanswered ask.
    private(set) var page = 0
    private var pageSeq: Int?
    /// The slide between two pages, while it's going.
    private var deck: CardDeck?
    /// The card built for each width it's been asked about, for this row,
    /// page, collapse and text size; any of those changing starts afresh.
    private var built: (row: TranscriptRow, page: Int, collapsed: Bool, zoom: Int, local: Bool, renders: [CGFloat: RowRender])?

    override var isFlipped: Bool { true }

    init(controller: TranscriptController) {
        self.controller = controller
        super.init(frame: .zero)
        cell.bare = true
        cell.delegate = controller
        scroll.drawsBackground = false
        scroll.borderType = .noBorder
        scroll.hasVerticalScroller = true
        scroll.scrollerStyle = .overlay
        scroll.autohidesScrollers = true
        scroll.documentView = document
        scroll.wantsLayer = true
        document.addSubview(cell)
        addSubview(scroll)
        // It's framed by hand in layout, so it mustn't add constraints.
        toggle.sizingOptions = []
        addSubview(toggle)
        controller.composerCard = self
    }

    required init?(coder: NSCoder) { fatalError() }

    func attach(_ controller: TranscriptController) {
        if controller.composerCard !== self { controller.composerCard = self }
        guard controller !== self.controller else { return }
        self.controller = controller
        cell.delegate = controller
        // Another thread's card: nothing drawn for the last one stays up
        // (its pictures from this Mac, say), whatever the rows have in common.
        built = nil
        shown = nil
        needsLayout = true
    }

    /// Over this, a card of several asks shows one at a time, with
    /// ‹ 1 of 3 › by its heading (Mike, 30 Oct: three asks took most of
    /// the window). Two short asks still fit, and stay as one list.
    static var pagedOver: CGFloat { zoomed(240) }

    static func isPaged(_ card: AsksCard, height: CGFloat) -> Bool {
        card.isOpen && card.asks.count > 1 && height > pagedOver
    }

    /// The card at `width`. A paged one is drawn on `page` but as tall as
    /// its tallest page, so the composer doesn't jump up and down and the
    /// arrows stay put under the pointer while he pages through.
    static func render(_ row: TranscriptRow, width: CGFloat, page: Int = 0, collapsed: Bool = false) -> RowRender {
        #if DEBUG
        renderCount += 1
        #endif
        guard case .asks(let card) = row.content else { return RowRender(height: 0) }
        let measure = { (text: NSAttributedString) in TextMeasurer.current.measure(text, width: width) }
        if collapsed {
            let heading = RowRenderer.asksText(card, width: width, collapsed: true)
            let size = measure(heading)
            // Never shorter than the chevron beside it.
            return RowRender(height: max(size.height, toggleSize), text: heading, textSize: size)
        }
        let all = RowRenderer.asksText(card, width: width)
        let full = measure(all)
        guard isPaged(card, height: full.height) else { return RowRender(height: full.height, text: all, textSize: full) }
        let shown = min(max(page, 0), card.asks.count - 1)
        var text = all
        var size = full
        var tallest: CGFloat = 0
        for index in card.asks.indices {
            let pageText = RowRenderer.asksText(card, width: width, page: index)
            let pageSize = measure(pageText)
            tallest = max(tallest, pageSize.height)
            if index == shown { (text, size) = (pageText, pageSize) }
        }
        return RowRender(height: tallest, text: text, textSize: size)
    }

    /// The width to build the card at for a proposed one: the reading
    /// column when SwiftUI leaves it open or offers no end, and never so
    /// narrow that TextKit lays the card out a letter a line (the window's
    /// smallest-size pass offers next to nothing).
    static func measuringWidth(_ proposed: CGFloat?) -> CGFloat {
        guard let proposed, proposed.isFinite else { return Theme.maxContentWidth }
        return max(proposed, zoomed(160))
    }

    /// `render`, from what was built last when nothing's changed.
    func rendered(_ row: TranscriptRow, width: CGFloat, collapsed: Bool) -> RowRender {
        let zoom = TypeScale.percent
        // Another Mac's card draws no pictures from this Mac, and what was
        // built for one thread is never handed to another.
        let local = controller?.localPictures ?? false
        if let built, built.row == row, built.page == page, built.collapsed == collapsed, built.zoom == zoom, built.local == local {
            if let render = built.renders[width] { return render }
        } else {
            built = (row, page, collapsed, zoom, local, [:])
        }
        let render = MarkdownRenderer.withLocalPictures(local) {
            Self.render(row, width: width, page: page, collapsed: collapsed)
        }
        // A few widths while the window's resized; not one for every step.
        if built!.renders.count >= 8 { built!.renders.removeAll() }
        built!.renders[width] = render
        return render
    }

    func show(_ row: TranscriptRow, collapsed: Bool = false) {
        // The same card on another Mac's thread (the transcript's controller
        // is reused across threads): drawn again, without this Mac's pictures.
        if let shown, shown.local != (controller?.localPictures ?? false) { needsLayout = true }
        guard row != self.row || collapsed != self.collapsed else { return }
        self.row = row
        self.collapsed = collapsed
        if case .asks(let card) = row.content, card.seq != pageSeq {
            pageSeq = card.seq
            page = card.asks.indices.first { card.picks[$0] == nil } ?? 0
        }
        needsLayout = true
    }

    /// ‹ and › on a paged card (`page:<n>`).
    func showPage(_ index: Int) {
        guard case .asks(let card)? = row?.content, card.asks.indices.contains(index), index != page else { return }
        deck?.finish()
        let forward = index > page
        let before = window == nil ? nil : CardDeck.Picture(of: scroll, in: self)
        let oldCounter = before == nil ? nil : counterRect()
        page = index
        shown = nil
        needsLayout = true
        guard let before else { return }
        // Now rather than at the end of this turn, for a picture of the new
        // page to slide in.
        layoutSubtreeIfNeeded()
        guard let after = CardDeck.Picture(of: scroll, in: self) else { return }
        deck = CardDeck(in: self, below: toggle, hiding: scroll, before: before, after: after,
                        heading: TypeScale.scaled(38) - scroll.contentView.bounds.minY,
                        oldCounter: oldCounter, newCounter: counterRect(), forward: forward) { [weak self] in
            self?.deck = nil
        }
    }

    /// Where the page number of ‹ 2 of 3 › is, in this view.
    private func counterRect() -> NSRect? {
        cell.pageNumberRect().map { convert($0, from: cell) }
    }

    /// Ask `index` in front on a paged card; false if the card isn't paged
    /// (every ask is in sight already).
    func showAsk(_ index: Int) -> Bool {
        guard case .asks(let card)? = row?.content, bounds.width > 0 else { return false }
        let full = MarkdownRenderer.withLocalPictures(controller?.localPictures ?? false) {
            TextMeasurer.current.measure(RowRenderer.asksText(card, width: bounds.width), width: bounds.width)
        }
        guard Self.isPaged(card, height: full.height) else { return false }
        showPage(index)
        return true
    }

    /// After an answer's picked on a paged card, on to the next ask still
    /// waiting for one, a beat later so the tick shows first. Stays put
    /// once they're all answered, so he can look over the last one.
    func pagePast(_ index: Int) {
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) { [weak self] in
            guard let self, self.page == index, case .asks(let card)? = self.row?.content,
                  let next = Decisions.nextUnanswered(after: index, count: card.asks.count, picks: card.picks) else { return }
            _ = self.showAsk(next)
        }
    }

    /// Under half the window, so the reply it answers stays in sight.
    var maxHeight: CGFloat {
        max(zoomed(200), (window?.contentLayoutRect.height ?? 800) * 0.45)
    }

    override func layout() {
        super.layout()
        scroll.frame = bounds
        guard let row, bounds.width > 0 else { return }
        let zoom = TypeScale.percent
        let local = controller?.localPictures ?? false
        if let shown, shown.row == row, shown.collapsed == collapsed, shown.width == bounds.width, shown.zoom == zoom, shown.local == local { return }
        shown = (row, collapsed, bounds.width, zoom, local)
        placeToggle(row)
        let render = rendered(row, width: bounds.width, collapsed: collapsed)
        document.frame = NSRect(x: 0, y: 0, width: bounds.width, height: render.height)
        cell.frame = document.bounds
        cell.configure(row: row, render: render, tableWidth: bounds.width, expanded: false)
        if let ask = pendingFocus, cell.focusAnswerBox(ask) { pendingFocus = nil }
        settleIfArriving(row)
    }

    /// A card that's just turned up while he watches: the box has taken its
    /// height at once (animating it would step the transcript's table from
    /// the main thread), and what's in it rises 6 pt and fades in, as the
    /// sidebar row's tick draws on for the same moment, so does the done
    /// card's. Mike picked it from a mockup, 7 Nov. Never for a card that
    /// was already there when the thread opened. All on layers, so it runs
    /// whatever the main thread's doing at the end of a turn.
    private func settleIfArriving(_ row: TranscriptRow) {
        guard case .asks(let card) = row.content, let session = controller?.session, session.arrivingCard == card.seq else { return }
        session.arrivingCard = nil
        Self.settle(scroll)
        if card.isDone, !collapsed, !Juice.reduceMotion { cell.drawDoneTickOn() }
    }

    static func settle(_ view: NSView) {
        guard let layer = view.layer else { return }
        let fade = CABasicAnimation(keyPath: "opacity")
        fade.fromValue = 0
        fade.toValue = 1
        guard !Juice.reduceMotion else {
            fade.duration = 0.15
            layer.add(fade, forKey: settleKey)
            return
        }
        // Additive, so it leaves the layer's own geometry to AppKit.
        let rise = CABasicAnimation(keyPath: "transform.translation.y")
        rise.isAdditive = true
        rise.fromValue = view.downward(zoomed(6))
        rise.toValue = 0
        let group = CAAnimationGroup()
        group.animations = [fade, rise]
        group.duration = 0.2
        group.timingFunction = CAMediaTimingFunction(controlPoints: 0, 0, 0.2, 1)
        layer.add(group, forKey: settleKey)
    }

    static let settleKey = "settle"

    #if DEBUG
    /// How many times a card's been built, for tests.
    nonisolated(unsafe) static var renderCount = 0
    #endif

    static var toggleSize: CGFloat { zoomed(22) }

    /// The chevron, at the right of the heading line and centred on it,
    /// which is a button tall on a paged card. Only asks collapse: a done
    /// card has Archive there, and is short already.
    private func placeToggle(_ row: TranscriptRow) {
        guard case .asks(let card) = row.content, !card.isDone else {
            toggle.isHidden = true
            return
        }
        let width = bounds.width
        let full = MarkdownRenderer.withLocalPictures(controller?.localPictures ?? false) {
            TextMeasurer.current.measure(RowRenderer.asksText(card, width: width), width: width)
        }
        let line = !collapsed && Self.isPaged(card, height: full.height) ? TypeScale.scaled(38) : TypeScale.workLine
        let size = Self.toggleSize
        toggle.frame = NSRect(x: width - size, y: max(0, (line - size) / 2), width: size, height: size)
        toggle.isHidden = false
        toggle.rootView = CardCollapseButton(collapsed: collapsed) { [weak self] in
            guard let self, case .asks(let card)? = self.row?.content else { return }
            self.controller?.askAction(card, action: "collapse")
        }
    }

    func focusAnswerBox(_ ask: Int) {
        if !cell.focusAnswerBox(ask) { pendingFocus = ask }
    }

    #if DEBUG
    func debugHover(_ on: Bool) -> Bool { cell.debugHover(on) }
    #endif
}

/// Points where the card will go: down to tuck it into the composer, up
/// to bring it back.
private struct CardCollapseButton: View {
    let collapsed: Bool
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Image(systemName: collapsed ? "chevron.up" : "chevron.down")
                .font(.system(size: zoomed(11), weight: .semibold))
        }
        .buttonStyle(RowIconButtonStyle())
        .accessibilityLabel(collapsed ? "Expand" : "Collapse")
        .tip(collapsed ? "Expand" : "Collapse")
        // Its own hosting view, outside RootView's (FirstClick.swift).
        .allowsWindowActivationEvents()
    }
}

private final class FlippedView: NSView {
    override var isFlipped: Bool { true }
}

/// The asks on a paged card sliding like a deck (Mike picked it from a
/// mockup, 7 Nov): the next ask pushes in from the right as the old one goes
/// off left, going back the other way, and the page number rolls. The heading
/// line stays put, and it's part of the same text as the ask, so a transition
/// on the card would push that too. So for a moment what's shown is pictures:
/// the two asks sliding in a box of their own, the heading from the new page,
/// and the old and new numbers. The real card sits underneath, already on the
/// new page and taking clicks, and comes back when they've gone. It's all
/// layers, so the render server runs it, and it's short enough not to get in
/// the way of a click: clicking on goes straight to the page after.
@MainActor
final class CardDeck {
    static let duration: CFTimeInterval = 0.18

    /// A view as it looks now, in its parent's coordinates.
    struct Picture {
        let image: CGImage
        let frame: NSRect
        let scale: CGFloat

        init?(of view: NSView, in parent: NSView) {
            guard view.bounds.width > 1, view.bounds.height > 1,
                  let rep = view.bitmapImageRepForCachingDisplay(in: view.bounds) else { return nil }
            view.cacheDisplay(in: view.bounds, to: rep)
            guard let image = rep.cgImage else { return nil }
            self.image = image
            frame = view.convert(view.bounds, to: parent)
            scale = CGFloat(image.width) / view.bounds.width
        }

        /// A layer showing this part of it, `rect` in the parent's coordinates.
        func layer(_ rect: NSRect) -> CALayer? {
            let pixels = CGRect(x: (rect.minX - frame.minX) * scale, y: (rect.minY - frame.minY) * scale,
                                width: rect.width * scale, height: rect.height * scale).integral
            guard let part = image.cropping(to: pixels) else { return nil }
            let layer = CALayer()
            layer.contents = part
            layer.contentsScale = scale
            layer.frame = rect
            return layer
        }
    }

    private final class Overlay: NSView {
        override var isFlipped: Bool { true }
        override func hitTest(_ point: NSPoint) -> NSView? { nil }
    }

    private let overlay = Overlay()
    private weak var hidden: NSView?
    private var done: (() -> Void)?

    init(in parent: NSView, below top: NSView, hiding view: NSView, before: Picture, after: Picture, heading: CGFloat,
         oldCounter: NSRect?, newCounter: NSRect?, forward: Bool, done: @escaping () -> Void) {
        self.done = done
        hidden = view
        let bounds = after.frame
        let split = min(max(0, heading), bounds.height)
        let page = NSRect(x: bounds.minX, y: bounds.minY + split, width: bounds.width, height: bounds.height - split)
        overlay.frame = parent.bounds
        overlay.wantsLayer = true
        overlay.layer?.masksToBounds = true
        parent.addSubview(overlay, positioned: .below, relativeTo: top)
        guard let root = overlay.layer else { return }

        CATransaction.begin()
        CATransaction.setDisableActions(true)
        // Before any animation's added: it waits only for those added after.
        CATransaction.setCompletionBlock { [weak self] in
            MainActor.assumeIsolated { self?.finish() }
        }
        let moving = !Juice.reduceMotion
        // The heading, with a gap for the number while it rolls.
        let counter = moving ? newCounter.map { oldCounter.map($0.union) ?? $0 }?.insetBy(dx: -1, dy: 0) : nil
        let headingRect = NSRect(x: bounds.minX, y: bounds.minY, width: bounds.width, height: split)
        for part in Self.around(counter, in: headingRect) { after.layer(part).map { Self.add($0, to: root) } }

        // A box of their own, so they're clipped to it.
        let box = CALayer()
        box.frame = page
        box.masksToBounds = true
        Self.add(box, to: root)
        let inBox = NSRect(origin: .zero, size: page.size)
        let width = page.width
        let old = before.layer(NSRect(x: page.minX, y: page.minY, width: page.width, height: page.height))
        let new = after.layer(page)
        for (layer, from, to, opacity) in [(old, 0.0, forward ? -width : width, (1.0, 0.0)), (new, forward ? width : -width, 0.0, (0.0, 1.0))] {
            guard let layer else { continue }
            layer.frame = inBox
            Self.add(layer, to: box)
            if moving {
                layer.add(Self.basic("transform.translation.x", from, to), forKey: "slide")
            } else {
                // Reduce Motion: one page fades into the other, where it is.
                let fade = Self.basic("opacity", opacity.0, opacity.1)
                fade.duration = 0.12
                layer.add(fade, forKey: "slide")
            }
        }
        // Old up and out, new up from below.
        if moving, let oldCounter, let newCounter, let counter {
            let clip = CALayer()
            clip.frame = counter
            clip.masksToBounds = true
            Self.add(clip, to: root)
            let travel = zoomed(10)
            for (rect, picture, range, fade) in [(oldCounter, before, (0.0, -travel), (1.0, 0.0)), (newCounter, after, (travel, 0.0), (0.0, 1.0))] {
                guard let digit = picture.layer(rect) else { continue }
                digit.frame = rect.offsetBy(dx: -counter.minX, dy: -counter.minY)
                Self.add(digit, to: clip)
                let group = CAAnimationGroup()
                group.animations = [Self.basic("transform.translation.y", range.0, range.1), Self.basic("opacity", fade.0, fade.1)]
                group.duration = Self.duration
                Self.hold(group)
                digit.add(group, forKey: "roll")
            }
        }
        view.alphaValue = 0
        CATransaction.commit()
        // Sends it now, whatever the main thread does next.
        CATransaction.flush()
    }

    /// The real card back, and the pictures gone.
    func finish() {
        guard let done else { return }
        self.done = nil
        hidden?.alphaValue = 1
        overlay.removeFromSuperview()
        done()
    }

    private static func add(_ layer: CALayer, to parent: CALayer) {
        parent.addSublayer(layer)
        // In a flipped view's layer a picture comes out upside down. Only the
        // pictures: turning a box over would turn what's in it over too.
        if layer.contents != nil, layer.contentsAreFlipped() { layer.isGeometryFlipped.toggle() }
    }

    private static func basic(_ keyPath: String, _ from: Double, _ to: Double) -> CABasicAnimation {
        let animation = CABasicAnimation(keyPath: keyPath)
        animation.fromValue = from
        animation.toValue = to
        animation.duration = duration
        animation.timingFunction = CAMediaTimingFunction(name: .easeOut)
        hold(animation)
        return animation
    }

    /// Holds the last frame until the pictures are taken away.
    private static func hold(_ animation: CAAnimation) {
        animation.fillMode = .forwards
        animation.isRemovedOnCompletion = false
    }

    /// `rect` with a gap cut out across it for `gap`.
    static func around(_ gap: NSRect?, in rect: NSRect) -> [NSRect] {
        guard let gap, gap.intersects(rect), rect.height > 0 else { return rect.height > 0 ? [rect] : [] }
        return [NSRect(x: rect.minX, y: rect.minY, width: max(0, gap.minX - rect.minX), height: rect.height),
                NSRect(x: gap.maxX, y: rect.minY, width: max(0, rect.maxX - gap.maxX), height: rect.height)]
            .filter { $0.width > 0 }
    }
}
