import AppKit
import ImageIO
import Quartz
import ThreadbearCore
import UniformTypeIdentifiers

/// Decodes image thumbnails off the main thread at the size they're drawn,
/// and keeps them in an `NSCache`.
final class ThumbnailLoader: @unchecked Sendable {
    static let shared = ThumbnailLoader()

    private let cache: NSCache<NSString, CGImageBox> = {
        let cache = NSCache<NSString, CGImageBox>()
        // Thumbnails are decoded at drawn size, about 0.3 MB each; 24 MB
        // covers several screens of images. More only grows the footprint.
        cache.totalCostLimit = 24 * 1024 * 1024
        return cache
    }()
    private let queue: OperationQueue = {
        let queue = OperationQueue()
        queue.maxConcurrentOperationCount = 4
        queue.qualityOfService = .userInitiated
        return queue
    }()

    final class CGImageBox {
        let image: CGImage
        init(_ image: CGImage) { self.image = image }
    }

    private func key(_ path: String, _ pixels: Int) -> NSString { "\(path)|\(pixels)" as NSString }

    func cached(path: String, maxPixels: Int) -> CGImage? {
        cache.object(forKey: key(path, maxPixels))?.image
    }

    /// Calls back on the main thread; immediately if it's cached.
    func load(path: String, maxPixels: Int, completion: @escaping @MainActor (CGImage?) -> Void) {
        let cacheKey = key(path, maxPixels)
        if let hit = cache.object(forKey: cacheKey) {
            MainActor.assumeIsolated { completion(hit.image) }
            return
        }
        queue.addOperation { [cache] in
            let image = Self.decode(path: path, maxPixels: maxPixels)
            // A long page decoded whole for zooming is bigger than the cache's
            // whole limit, and NSCache would hang on to it anyway. Its view
            // holds it for as long as it's on show.
            if let image, image.bytesPerRow * image.height <= cache.totalCostLimit {
                cache.setObject(CGImageBox(image), forKey: cacheKey, cost: image.bytesPerRow * image.height)
            }
            DispatchQueue.main.async {
                MainActor.assumeIsolated { completion(image) }
            }
        }
    }

    static func decode(path: String, maxPixels: Int) -> CGImage? {
        let url = URL(fileURLWithPath: path) as CFURL
        guard let source = CGImageSourceCreateWithURL(url, [kCGImageSourceShouldCache: false] as CFDictionary) else { return nil }
        let options: [CFString: Any] = [
            kCGImageSourceCreateThumbnailFromImageAlways: true,
            kCGImageSourceCreateThumbnailWithTransform: true,
            kCGImageSourceShouldCacheImmediately: true,
            kCGImageSourceThumbnailMaxPixelSize: maxPixels,
        ]
        return CGImageSourceCreateThumbnailAtIndex(source, 0, options as CFDictionary)
    }
}

/// Shows images in Quick Look. The transcript table forwards the panel's
/// responder-chain calls here.
final class QuickLookCoordinator: NSObject, QLPreviewPanelDataSource, QLPreviewPanelDelegate {
    static let shared = QuickLookCoordinator()

    private var urls: [URL] = []
    private(set) var isActive = false

    #if DEBUG
    /// Set by the scripted app: it notes what would open, as the real panel
    /// comes to the front of Mike's work.
    var debugOpened: (([String], Int) -> Void)?
    #endif

    func show(paths: [String], index: Int, from view: NSView) {
        #if DEBUG
        if let debugOpened {
            debugOpened(paths, index)
            return
        }
        #endif
        urls = paths.map { URL(fileURLWithPath: $0) }
        if let table = sequence(first: view, next: { $0.superview }).first(where: { $0 is TranscriptTableView }) {
            view.window?.makeFirstResponder(table)
        }
        guard let panel = QLPreviewPanel.shared() else { return }
        if panel.isVisible {
            panel.reloadData()
        } else {
            panel.makeKeyAndOrderFront(nil)
        }
        panel.currentPreviewItemIndex = min(max(0, index), max(0, urls.count - 1))
    }

    func begin(_ panel: QLPreviewPanel) {
        isActive = true
        panel.dataSource = self
        panel.delegate = self
    }

    func end(_ panel: QLPreviewPanel) {
        isActive = false
        panel.dataSource = nil
        panel.delegate = nil
    }

    func numberOfPreviewItems(in panel: QLPreviewPanel!) -> Int { urls.count }

    func previewPanel(_ panel: QLPreviewPanel!, previewItemAt index: Int) -> (any QLPreviewItem)! {
        urls[index] as NSURL
    }
}

/// Thumbnails laid out from precomputed frames, drawn as layers. Click one
/// to open it in Quick Look.
final class ImageGridView: NSView {
    // Clicks count while Threadbear isn't the app in front (FirstClick.swift).
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }

    private var paths: [String] = []
    private var frames: [NSRect] = []
    private var tiles: [CALayer] = []
    /// Set for another runner's thread ("bruce"): the pictures are files on
    /// that Mac, fetched through it and then shown from this Mac's copy.
    /// Each tile says so quietly while it comes, or if it couldn't.
    var remote: RemoteImages?
    private var labels: [CATextLayer] = []
    /// Fetches this view has asked for and not heard back about.
    private var fetching: Set<String> = []
    /// Remote pictures that couldn't be fetched, with why.
    private var failures: [String: String] = [:]
    private var shownTip = ""

    override var isFlipped: Bool { true }

    override init(frame frameRect: NSRect) {
        super.init(frame: frameRect)
        wantsLayer = true
    }

    required init?(coder: NSCoder) { fatalError() }

    /// The file a tile draws and opens: the picture itself, or this Mac's
    /// copy of one on another runner's Mac. Nil while there's no copy, or
    /// when its runner sent only the start of it (too big to draw).
    func localPath(_ index: Int) -> String? {
        guard paths.indices.contains(index) else { return nil }
        guard let remote else { return paths[index] }
        guard let copy = remote.ready(paths[index]), !copy.truncated else { return nil }
        return copy.path
    }

    func show(paths: [String], frames: [NSRect]) {
        if paths != self.paths { failures = [:] }
        self.paths = paths
        self.frames = frames
        while tiles.count < frames.count {
            let tile = CALayer()
            tile.cornerRadius = zoomed(8)
            tile.cornerCurve = .continuous
            tile.masksToBounds = true
            tile.borderWidth = 0.5
            tile.contentsGravity = .resizeAspectFill
            layer?.addSublayer(tile)
            tiles.append(tile)
        }
        let scale = window?.backingScaleFactor ?? 2
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        for (index, tile) in tiles.enumerated() {
            guard index < frames.count else {
                tile.isHidden = true
                continue
            }
            tile.isHidden = false
            tile.frame = frames[index]
            tile.borderColor = Theme.cardBorder.resolvedCGColor(for: self)
            // A faint placeholder while the thumbnail decodes, and no box
            // behind the image once it's there.
            let placeholder = Theme.codeBackground.resolvedCGColor(for: self)
            guard let path = localPath(index) else {
                // Another runner's picture with no copy here yet.
                tile.contents = nil
                tile.backgroundColor = placeholder
                tile.name = nil
                label(remoteWords(index), for: index, in: tile)
                fetchIfNeeded(index)
                continue
            }
            label(nil, for: index, in: tile)
            let pixels = Int(max(frames[index].width, frames[index].height) * scale)
            if let image = ThumbnailLoader.shared.cached(path: path, maxPixels: pixels) {
                tile.contents = image
                tile.backgroundColor = nil
            } else {
                tile.contents = nil
                tile.backgroundColor = placeholder
                tile.name = path
                ThumbnailLoader.shared.load(path: path, maxPixels: pixels) { [weak tile] image in
                    guard let tile, tile.name == path else { return }
                    tile.contents = image
                    if image != nil { tile.backgroundColor = nil }
                }
            }
            tile.name = path
        }
        CATransaction.commit()
        // Why one couldn't be fetched, on hover; the tile itself just says
        // so. Set only on a change, so grids that never fail get no tip view.
        let tip = failures.isEmpty ? "" : Set(failures.values).sorted().joined(separator: "\n")
        if tip != shownTip {
            setTip(tip)
            shownTip = tip
        }
        window?.invalidateCursorRects(for: self)
    }

    /// What a remote tile with no picture says: that it's on its way, that
    /// it couldn't be got, or (too big to send whole) just where it is.
    private func remoteWords(_ index: Int) -> String? {
        guard let remote, paths.indices.contains(index) else { return nil }
        let path = paths[index]
        if failures[path] != nil { return "Couldn't get it from \(remote.name)" }
        if remote.ready(path)?.truncated == true { return "On \(remote.name)" }
        return "Loading…"
    }

    private func fetchIfNeeded(_ index: Int) {
        guard let remote, paths.indices.contains(index) else { return }
        let path = paths[index]
        guard remote.ready(path) == nil, failures[path] == nil, fetching.insert(path).inserted else { return }
        remote.fetch(path) { [weak self] result in
            guard let self else { return }
            self.fetching.remove(path)
            // A cell the table has since given another row ignores it.
            guard self.paths.contains(path) else { return }
            if case .failure(let error) = result { self.failures[path] = AppModel.remoteFileReason(error) }
            self.show(paths: self.paths, frames: self.frames)
        }
    }

    /// Words in the middle of a tile with no picture; hidden otherwise.
    private func label(_ words: String?, for index: Int, in tile: CALayer) {
        while labels.count <= index {
            let text = CATextLayer()
            text.alignmentMode = .center
            text.truncationMode = .end
            text.contentsScale = window?.backingScaleFactor ?? 2
            tile.addSublayer(text)
            labels.append(text)
        }
        let text = labels[index]
        if text.superlayer !== tile { tile.addSublayer(text) }
        guard let words else {
            text.isHidden = true
            return
        }
        let font = NSFont.systemFont(ofSize: TypeScale.work - 1)
        text.isHidden = false
        text.string = words
        text.font = font
        text.fontSize = font.pointSize
        text.foregroundColor = Theme.faintText.resolvedCGColor(for: self)
        let height = ceil(font.ascender - font.descender + font.leading) + 2
        text.frame = NSRect(x: 4, y: (tile.bounds.height - height) / 2, width: max(0, tile.bounds.width - 8), height: height)
    }

    override func viewDidChangeEffectiveAppearance() {
        super.viewDidChangeEffectiveAppearance()
        // Layer colours don't follow appearance changes on their own.
        let border = Theme.cardBorder.resolvedCGColor(for: self)
        for tile in tiles { tile.borderColor = border }
        if remote != nil, !frames.isEmpty { show(paths: paths, frames: frames) }
    }

    /// Drops the decoded images, for a cell the table has parked off screen.
    /// Layer contents hold their own copy of each image.
    func clear() {
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        for tile in tiles {
            tile.contents = nil
            tile.name = nil
        }
        CATransaction.commit()
        paths = []
        frames = []
    }

    override func mouseDown(with event: NSEvent) {
        let point = convert(event.locationInWindow, from: nil)
        guard let index = frames.firstIndex(where: { $0.contains(point) }) else { return super.mouseDown(with: event) }
        guard let path = localPath(index) else {
            // Nothing here yet to look at or drag. A click on one that
            // couldn't be got tries again.
            if remote != nil, paths.indices.contains(index), failures.removeValue(forKey: paths[index]) != nil {
                show(paths: paths, frames: frames)
            }
            return super.mouseDown(with: event)
        }
        // Dragged, the picture goes out as the file itself (FileDrag).
        if FileDrag.isDrag(from: event) {
            FileDrag.begin(URL(fileURLWithPath: path), from: self, event: event)
            return
        }
        open(index)
    }

    /// Quick Look on one picture, for a click on its tile or its chip in
    /// the words. False when there's nothing here yet to look at.
    @discardableResult
    func open(_ index: Int) -> Bool {
        guard let path = localPath(index), quickLooks(path) else { return false }
        // Quick Look steps through the pictures there are copies of.
        let shown = paths.indices.compactMap { localPath($0) }.filter(quickLooks)
        QuickLookCoordinator.shared.show(paths: shown, index: shown.firstIndex(of: path) ?? 0, from: self)
        return true
    }

    /// A tile goes to Quick Look only when it's really a picture: Quick
    /// Look's Open with button would hand anything else (a `.love` game
    /// or a `.command` posing as one) to its app (Codex review, 7 Nov).
    private func quickLooks(_ path: String) -> Bool {
        guard UTType(filenameExtension: (path as NSString).pathExtension)?.conforms(to: .image) == true,
              ThumbnailLoader.decode(path: path, maxPixels: 64) != nil else { return false }
        let app = OpenGate.appFor(URL(fileURLWithPath: path))
        return !LinkPolicy.isCodeRunner(bundleId: app.flatMap(OpenGate.appBundleId))
    }

    override func resetCursorRects() {
        for (index, frame) in frames.enumerated() where localPath(index) != nil || failures[paths[safe: index] ?? ""] != nil {
            addCursorRect(frame, cursor: .pointingHand)
        }
    }
}

private extension Array {
    subscript(safe index: Int) -> Element? { indices.contains(index) ? self[index] : nil }
}
