import AppKit
import Synchronization
import ThreadbearCore

/// What's known of each ```mermaid and ```html block in the transcript:
/// drawn (a picture for each look), still drawing, or failed. Read from
/// any thread (rows are rendered across cores); drawing happens on the main
/// thread in RichRenderer, and each finish bumps `generation` and posts
/// `changed`, so the rows holding that block render again.
///
/// Pictures are also kept on disk (`<caches>/Threadbear/rich`), so a
/// thread opened after a restart shows its diagrams straight away rather
/// than its source for a moment.
final class RichBlocks: @unchecked Sendable {
    static let shared = RichBlocks()
    static let changed = Notification.Name("RichBlocks.changed")

    /// What a row needs to lay a drawn block out. The pictures themselves
    /// are kept apart (`pictures`), so cached renders don't hold them.
    struct Drawn: Sendable {
        /// In points, at the zoom it was drawn for.
        let size: CGSize
        /// A page taller than we draw: the box shows its top and fades out.
        let clipped: Bool
    }

    /// A block's picture in each look.
    final class Pictures: @unchecked Sendable {
        let dark: CGImage
        let light: CGImage
        init(dark: CGImage, light: CGImage) { self.dark = dark; self.light = light }
        var bytes: Int { dark.bytesPerRow * dark.height + light.bytesPerRow * light.height }
    }

    /// Pictures in memory, by what they take up: past it the oldest go,
    /// and are read back from disk when drawn again (cross-lab review,
    /// 6 Nov: a count let many tall pages take gigabytes).
    static let pictureBytes = 160 * 1024 * 1024
    private let pictures: NSCache<NSString, Pictures> = {
        let cache = NSCache<NSString, Pictures>()
        cache.totalCostLimit = RichBlocks.pictureBytes
        return cache
    }()

    func keep(_ pictures: Pictures, for key: String) {
        self.pictures.setObject(pictures, forKey: key as NSString, cost: pictures.bytes)
    }

    /// The block's pictures, read from disk if they've left memory.
    func pictures(_ key: String) -> Pictures? {
        if let kept = pictures.object(forKey: key as NSString) { return kept }
        guard let loaded = RichDiskCache.pictures(key) else { return nil }
        keep(loaded, for: key)
        return loaded
    }

    enum State {
        case drawing
        case drawn(Drawn)
        case failed(String)
    }

    private struct Inner {
        var states: [String: State] = [:]
        /// Oldest first, for dropping pictures once there are many.
        var order: [String] = []
        var showingSource: Set<String> = []
        var generation = 0
    }

    private let inner = Mutex(Inner())
    /// How many blocks' states stay in memory (sizes only, small).
    static let memoryLimit = 2000

    /// Part of a rich row's render key: changes whenever a block is drawn,
    /// fails, or flips between its picture and its source.
    var generation: Int { inner.withLock { $0.generation } }

    static func key(_ block: RichBlock, zoom: Int = TypeScale.percent) -> String { "\(block.id)-\(zoom)" }

    /// The block's state, starting it drawing if it's new.
    func state(_ block: RichBlock) -> State {
        let key = Self.key(block)
        if let known = inner.withLock({ $0.states[key] }) { return known }
        if let saved = RichDiskCache.load(key) {
            remember(key, .drawn(saved))
            return .drawn(saved)
        }
        let start = inner.withLock { inner -> Bool in
            guard inner.states[key] == nil else { return false }
            inner.states[key] = .drawing
            return true
        }
        if start {
            let zoom = TypeScale.percent
            Task { @MainActor in RichRenderer.shared.draw(block, zoom: zoom, key: key) }
        }
        return .drawing
    }

    func showsSource(_ id: String) -> Bool { inner.withLock { $0.showingSource.contains(id) } }

    @MainActor
    func setShowsSource(_ id: String, _ show: Bool) {
        let changed = inner.withLock { inner -> Bool in
            guard inner.showingSource.contains(id) != show else { return false }
            if show { inner.showingSource.insert(id) } else { inner.showingSource.remove(id) }
            inner.generation += 1
            return true
        }
        if changed { NotificationCenter.default.post(name: Self.changed, object: nil) }
    }

    @MainActor
    func finish(_ key: String, _ state: State) {
        remember(key, state)
        NotificationCenter.default.post(name: Self.changed, object: nil)
    }

    private func remember(_ key: String, _ state: State) {
        inner.withLock { inner in
            inner.states[key] = state
            inner.order.removeAll { $0 == key }
            inner.order.append(key)
            inner.generation += 1
            while inner.order.count > Self.memoryLimit {
                let oldest = inner.order.removeFirst()
                if case .drawing? = inner.states[oldest] { continue }
                inner.states[oldest] = nil
            }
        }
    }

    /// Whether a row's text could hold a rich block: only those rows'
    /// renders depend on `generation`, so a diagram drawing doesn't make
    /// every other row in the thread render again.
    static func mayHoldRich(_ text: String) -> Bool {
        guard text.contains("```") || text.contains("~~~") else { return false }
        let lowered = text.lowercased()
        return lowered.contains("mermaid") || lowered.contains("html")
    }
}

/// Drawn blocks on disk: a PNG per look and a line with the size, under
/// the user's Caches folder. Rebuilt by drawing again if it's gone.
enum RichDiskCache {
    /// Tests put it in a temporary folder.
    nonisolated(unsafe) static var folderOverride: URL?
    static var folder: URL {
        folderOverride ?? FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("Threadbear/rich", isDirectory: true)
    }

    static func load(_ key: String) -> RichBlocks.Drawn? {
        let base = folder.appendingPathComponent(key)
        guard let line = try? String(contentsOf: base.appendingPathExtension("size"), encoding: .utf8) else { return nil }
        let parts = line.split(separator: " ").compactMap { Double($0) }
        guard parts.count == 3, FileManager.default.fileExists(atPath: base.path + "-dark.png"),
              FileManager.default.fileExists(atPath: base.path + "-light.png") else { return nil }
        return RichBlocks.Drawn(size: CGSize(width: parts[0], height: parts[1]), clipped: parts[2] != 0)
    }

    static func pictures(_ key: String) -> RichBlocks.Pictures? {
        let base = folder.appendingPathComponent(key)
        guard let dark = image(base.path + "-dark.png"), let light = image(base.path + "-light.png") else { return nil }
        return RichBlocks.Pictures(dark: dark, light: light)
    }

    private static func image(_ path: String) -> CGImage? {
        guard let source = CGImageSourceCreateWithURL(URL(fileURLWithPath: path) as CFURL, nil) else { return nil }
        return CGImageSourceCreateImageAtIndex(source, 0, [kCGImageSourceShouldCacheImmediately: true] as CFDictionary)
    }

    static func save(_ key: String, _ drawn: RichBlocks.Drawn, _ pictures: RichBlocks.Pictures) {
        let manager = FileManager.default
        try? manager.createDirectory(at: folder, withIntermediateDirectories: true)
        let base = folder.appendingPathComponent(key)
        for (image, look) in [(pictures.dark, "dark"), (pictures.light, "light")] {
            guard let data = NSBitmapImageRep(cgImage: image).representation(using: .png, properties: [:]) else { return }
            try? data.write(to: URL(fileURLWithPath: base.path + "-\(look).png"), options: .atomic)
        }
        try? "\(drawn.size.width) \(drawn.size.height) \(drawn.clipped ? 1 : 0)".write(to: base.appendingPathExtension("size"), atomically: true, encoding: .utf8)
        prune()
    }

    /// The page or diagram the side pane shows for a block, in a folder
    /// of its own: the preview scheme lets a page read what's beside it.
    static func panePage(_ block: RichBlock) -> URL {
        folder.appendingPathComponent("page-\(block.id)", isDirectory: true).appendingPathComponent("index.html")
    }

    /// Keeps the folder to the newest few hundred files.
    private static func prune() {
        let manager = FileManager.default
        guard let files = try? manager.contentsOfDirectory(at: folder, includingPropertiesForKeys: [.contentModificationDateKey]),
              files.count > 1200 else { return }
        let dated = files.map { ($0, (try? $0.resourceValues(forKeys: [.contentModificationDateKey]).contentModificationDate) ?? .distantPast) }
        for (file, _) in dated.sorted(by: { $0.1 < $1.1 }).prefix(files.count - 900) {
            try? manager.removeItem(at: file)
        }
    }
}

/// The box a rich block is drawn in, as one attachment in the reply's
/// text: a header with the block's language, a Diagram / Source switch,
/// Copy and Open beside, and under it the picture or the source.
/// Everything it shows is fixed when the row renders; a change renders the
/// row again with a new cell.
final class RichBlockCell: NSTextAttachmentCell {
    enum Action: String, CaseIterable {
        case drawn, source, copy, open

        func tip(_ block: RichBlock) -> String {
            switch self {
            case .drawn: return block.kind == .mermaid ? "Show the diagram" : "Show the page"
            case .source: return "Show the source"
            case .copy: return "Copy the source"
            case .open: return "Open it beside the thread, full size"
            }
        }
    }

    let block: RichBlock
    /// Where its pictures are kept (RichBlocks.key, at the zoom it rendered at).
    let key: String
    let blockState: RichBlocks.State
    let showsSource: Bool
    private let code: NSAttributedString

    init(block: RichBlock, state: RichBlocks.State, showsSource: Bool) {
        self.block = block
        key = RichBlocks.key(block)
        self.blockState = state
        self.showsSource = showsSource
        code = NSAttributedString(string: block.source, attributes: [
            .font: Theme.codeFont, .foregroundColor: NSColor.labelColor,
            .paragraphStyle: { let s = NSMutableParagraphStyle(); s.lineBreakMode = .byCharWrapping; s.minimumLineHeight = Theme.codeLine; s.maximumLineHeight = Theme.codeLine; return s }(),
        ])
        super.init()
    }

    required init(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    // MARK: Sizes

    static var headerHeight: CGFloat { zoomed(34) }
    static var pad: CGFloat { zoomed(12) }
    static var radius: CGFloat { zoomed(8) }
    /// The tallest a picture is drawn in the reply; Open beside shows all of it.
    static var maxBody: CGFloat { zoomed(560) }
    private static var labelFont: NSFont { .monospacedSystemFont(ofSize: TypeScale.detail, weight: .regular) }
    private static var switchFont: NSFont { .systemFont(ofSize: TypeScale.detail, weight: .medium) }
    private static var errorFont: NSFont { .systemFont(ofSize: TypeScale.detail) }

    /// Whether the body shows the picture, rather than the source.
    var showsPicture: Bool {
        guard !showsSource, case .drawn = blockState else { return false }
        return true
    }

    private var failure: String? {
        guard !showsSource, case .failed(let message) = blockState else { return nil }
        return message
    }

    private func pictureSize(width: CGFloat) -> CGSize {
        guard case .drawn(let drawn) = blockState else { return .zero }
        let room = width - (block.kind == .mermaid ? Self.pad * 2 : 0)
        let natural = drawn.size
        guard natural.width > 0, natural.height > 0 else { return .zero }
        if block.kind == .html {
            // A page fills the width, and past maxBody it's cut and faded.
            let scale = room / natural.width
            return CGSize(width: room, height: (natural.height * scale).rounded())
        }
        let scale = min(1, room / natural.width, (Self.maxBody - Self.pad * 2) / natural.height)
        return CGSize(width: (natural.width * scale).rounded(), height: (natural.height * scale).rounded())
    }

    private func errorHeight(width: CGFloat) -> CGFloat {
        guard let failure else { return 0 }
        let text = NSAttributedString(string: "Couldn't draw this: \(failure)", attributes: [.font: Self.errorFont])
        return ceil(text.boundingRect(with: NSSize(width: width - Self.pad * 2, height: .greatestFiniteMagnitude), options: [.usesLineFragmentOrigin]).height) + zoomed(8)
    }

    private func bodyHeight(width: CGFloat) -> CGFloat {
        if showsPicture {
            let size = pictureSize(width: width)
            if block.kind == .html { return min(size.height, Self.maxBody) }
            return size.height + Self.pad * 2
        }
        let text = code.boundingRect(with: NSSize(width: width - Self.pad * 2, height: .greatestFiniteMagnitude), options: [.usesLineFragmentOrigin])
        return ceil(text.height) + Self.pad * 2 + errorHeight(width: width)
    }

    override func cellFrame(for textContainer: NSTextContainer, proposedLineFragment lineFrag: NSRect, glyphPosition position: NSPoint, characterIndex charIndex: Int) -> NSRect {
        let width = max(zoomed(160), floor(lineFrag.width - position.x))
        return NSRect(x: 0, y: 0, width: width, height: Self.headerHeight + bodyHeight(width: width))
    }

    override func cellSize() -> NSSize { NSSize(width: zoomed(600), height: Self.headerHeight + zoomed(120)) }
    override func cellBaselineOffset() -> NSPoint { .zero }
    override func wantsToTrackMouse() -> Bool { false }

    // MARK: Layout

    struct Layout {
        var box: NSRect
        var header: NSRect
        var body: NSRect
        var buttons: [Action: NSRect]
        var switchBox: NSRect
    }

    func layout(in frame: NSRect) -> Layout {
        let box = frame.insetBy(dx: 0.5, dy: 0.5)
        let header = NSRect(x: box.minX, y: box.minY, width: box.width, height: Self.headerHeight)
        let body = NSRect(x: box.minX, y: header.maxY, width: box.width, height: box.maxY - header.maxY)
        var buttons: [Action: NSRect] = [:]
        let icon = zoomed(24)
        var right = header.maxX - zoomed(8)
        for action in [Action.open, .copy] {
            buttons[action] = NSRect(x: right - icon, y: header.midY - icon / 2, width: icon, height: icon)
            right -= icon + zoomed(2)
        }
        right -= zoomed(6)
        let segmentHeight = zoomed(22)
        let attributes: [NSAttributedString.Key: Any] = [.font: Self.switchFont]
        let sourceWidth = ceil(("Source" as NSString).size(withAttributes: attributes).width) + zoomed(18)
        let drawnWidth = ceil((block.drawnTitle as NSString).size(withAttributes: attributes).width) + zoomed(18)
        let total = sourceWidth + drawnWidth + zoomed(4)
        let switchBox = NSRect(x: right - total, y: header.midY - segmentHeight / 2, width: total, height: segmentHeight)
        buttons[.drawn] = NSRect(x: switchBox.minX + zoomed(2), y: switchBox.minY + zoomed(2), width: drawnWidth, height: segmentHeight - zoomed(4))
        buttons[.source] = NSRect(x: switchBox.minX + zoomed(2) + drawnWidth, y: switchBox.minY + zoomed(2), width: sourceWidth, height: segmentHeight - zoomed(4))
        return Layout(box: box, header: header, body: body, buttons: buttons, switchBox: switchBox)
    }

    /// The button at `point`, in the same coordinates as `frame`.
    func action(at point: NSPoint, in frame: NSRect) -> Action? {
        let layout = layout(in: frame)
        return Action.allCases.first { layout.buttons[$0]?.insetBy(dx: -2, dy: -3).contains(point) == true }
    }

    // MARK: Drawing

    override func draw(withFrame cellFrame: NSRect, in controlView: NSView?) {
        let layout = layout(in: cellFrame)
        let flipped = controlView?.isFlipped ?? true
        let path = NSBezierPath(roundedRect: layout.box, xRadius: Self.radius, yRadius: Self.radius)
        Theme.codeBackground.setFill()
        path.fill()
        Theme.cardBorder.setStroke()
        path.lineWidth = 0.5
        path.stroke()
        Theme.hairline.setFill()
        NSRect(x: layout.box.minX, y: layout.header.maxY - 0.5, width: layout.box.width, height: 0.5).fill()

        // The language, at the left of the header.
        let label = NSAttributedString(string: block.label, attributes: [.font: Self.labelFont, .foregroundColor: NSColor.secondaryLabelColor])
        let labelSize = label.size()
        label.draw(at: NSPoint(x: layout.header.minX + Self.pad, y: layout.header.midY - labelSize.height / 2))

        // The switch.
        let track = NSBezierPath(roundedRect: layout.switchBox, xRadius: zoomed(6), yRadius: zoomed(6))
        Theme.switchTrack.setFill()
        track.fill()
        let selected: Action = showsSource ? .source : .drawn
        for action in [Action.drawn, .source] {
            guard let rect = layout.buttons[action] else { continue }
            if action == selected {
                Theme.switchThumb.setFill()
                NSBezierPath(roundedRect: rect, xRadius: zoomed(5), yRadius: zoomed(5)).fill()
            }
            let title = NSAttributedString(string: action == .drawn ? block.drawnTitle : "Source", attributes: [
                .font: Self.switchFont, .foregroundColor: action == selected ? NSColor.labelColor : NSColor.secondaryLabelColor,
            ])
            let size = title.size()
            title.draw(at: NSPoint(x: rect.midX - size.width / 2, y: rect.midY - size.height / 2))
        }
        for (action, symbol) in [(Action.copy, "doc.on.doc"), (.open, "arrow.up.left.and.arrow.down.right")] {
            guard let rect = layout.buttons[action] else { continue }
            drawSymbol(symbol, in: rect)
        }

        // The body.
        NSGraphicsContext.saveGraphicsState()
        let bodyClip = NSBezierPath(roundedRect: layout.box, xRadius: Self.radius, yRadius: Self.radius)
        bodyClip.addClip()
        NSBezierPath(rect: layout.body).addClip()
        if showsPicture, case .drawn(let drawn) = blockState, let pictures = RichBlocks.shared.pictures(key) {
            let dark = NSAppearance.currentDrawing().bestMatch(from: [.darkAqua, .aqua]) == .darkAqua
            let image = dark ? pictures.dark : pictures.light
            let size = pictureSize(width: layout.box.width)
            let x = block.kind == .html ? layout.body.minX : layout.body.midX - size.width / 2
            let y = layout.body.minY + (block.kind == .html ? 0 : Self.pad)
            let rect = NSRect(x: x, y: y, width: size.width, height: size.height)
            NSImage(cgImage: image, size: drawn.size).draw(in: rect, from: .zero, operation: .sourceOver, fraction: 1, respectFlipped: flipped, hints: [.interpolation: NSImageInterpolation.high])
            if block.kind == .html, size.height > layout.body.height || drawn.clipped {
                // Cut off: fade into the box, so it's clear there's more.
                let fade = zoomed(48)
                let gradient = NSGradient(starting: Theme.codeBackgroundOpaque.withAlphaComponent(0), ending: Theme.codeBackgroundOpaque)
                gradient?.draw(in: NSRect(x: layout.body.minX, y: layout.body.maxY - fade, width: layout.body.width, height: fade), angle: flipped ? 90 : -90)
            }
        } else {
            var top = layout.body.minY + Self.pad
            if let failure {
                let text = NSAttributedString(string: "Couldn't draw this: \(failure)", attributes: [.font: Self.errorFont, .foregroundColor: NSColor.systemOrange])
                let height = errorHeight(width: layout.box.width)
                text.draw(with: NSRect(x: layout.body.minX + Self.pad, y: top, width: layout.body.width - Self.pad * 2, height: height), options: [.usesLineFragmentOrigin])
                top += height
            }
            code.draw(with: NSRect(x: layout.body.minX + Self.pad, y: top, width: layout.body.width - Self.pad * 2, height: layout.body.maxY - top),
                      options: [.usesLineFragmentOrigin])
        }
        NSGraphicsContext.restoreGraphicsState()
    }

    private func drawSymbol(_ name: String, in rect: NSRect) {
        let config = NSImage.SymbolConfiguration(pointSize: TypeScale.detail, weight: .regular)
            .applying(.init(paletteColors: [.secondaryLabelColor]))
        guard let image = NSImage(systemSymbolName: name, accessibilityDescription: nil)?.withSymbolConfiguration(config) else { return }
        let size = image.size
        image.draw(in: NSRect(x: rect.midX - size.width / 2, y: rect.midY - size.height / 2, width: size.width, height: size.height),
                   from: .zero, operation: .sourceOver, fraction: 1, respectFlipped: true, hints: nil)
    }
}
