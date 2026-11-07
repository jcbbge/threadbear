import AppKit
import Network
import ThreadbearCore
import WebKit

/// Draws ```mermaid and ```html blocks into pictures for the transcript,
/// in two web views made the first time one is needed (so a thread
/// without any costs nothing) and kept off screen.
///
/// - Diagrams: the app's own page with Pele (pele.run, bundled, MIT) in a
///   content world of its own. The agent's source goes in as a string
///   argument, never as markup; Pele's SVG has no scripts or handlers,
///   and links and pictures are off.
/// - Pages: the agent's HTML written to its own folder under the cache and
///   loaded through the preview scheme, locked down like a mockup in the
///   side pane (PreviewSandbox): its scripts don't run, nothing reaches
///   the network, it can't navigate or open anything, and a
///   Content-Security-Policy in front of it allows only inline styles and
///   data: pictures.
///
/// Each is drawn in both looks, snapshotted, and handed to RichBlocks.
@MainActor
final class RichRenderer: NSObject, WKNavigationDelegate, WKUIDelegate {
    static let shared = RichRenderer()

    /// Where a page's connections would go: nowhere (as WebPanelPool's).
    var proxy: NWEndpoint = .hostPort(host: "127.0.0.1", port: 9)
    /// The width a page is laid out at, in CSS pixels; the box scales it
    /// to the reading column.
    static let pageWidth: CGFloat = 720
    /// The tallest a page is drawn; past it the box fades out.
    static let pageMaxHeight: CGFloat = 1600
    static let timeout: Duration = .seconds(15)
    static let snapshotPoints: CGFloat = 1_000_000

    private let world = WKContentWorld.world(name: "threadbear-rich")
    private var diagramView: WKWebView?
    private var pageView: WKWebView?
    private let previews = LocalPreviewSchemeHandler()
    private var loads: [ObjectIdentifier: CheckedContinuation<Void, Error>] = [:]
    /// One drawing at a time: the views are shared.
    private var tail: Task<Void, Never>?

    enum Failure: LocalizedError {
        case unavailable(String)
        case timedOut
        var errorDescription: String? {
            switch self {
            case .unavailable(let why): return why
            case .timedOut: return "it took too long"
            }
        }
    }

    /// A drawing: its size, and its pictures in each look.
    struct Rendered: @unchecked Sendable {
        let drawn: RichBlocks.Drawn
        let pictures: RichBlocks.Pictures
    }

    enum Outcome {
        case drawn(Rendered)
        case failed(String)
    }

    func draw(_ block: RichBlock, zoom: Int, key: String) {
        Task { [weak self] in
            guard let self else { return }
            switch await self.render(block, zoom: zoom) {
            case .drawn(let rendered):
                RichDiskCache.save(key, rendered.drawn, rendered.pictures)
                RichBlocks.shared.keep(rendered.pictures, for: key)
                RichBlocks.shared.finish(key, .drawn(rendered.drawn))
            case .failed(let why):
                RichBlocks.shared.finish(key, .failed(why))
            }
        }
    }

    /// Draws one block, after any before it (the views are shared).
    func render(_ block: RichBlock, zoom: Int) async -> Outcome {
        let previous = tail
        let job = Task { [weak self] () -> Outcome in
            await previous?.value
            guard let self else { return .failed("the app is closing") }
            do {
                return .drawn(try await self.withTimeout {
                    block.kind == .mermaid ? try await self.drawDiagram(block, zoom: zoom) : try await self.drawPage(block, zoom: zoom)
                })
            } catch {
                AppLog.write("rich", "couldn't draw a \(block.kind.rawValue) block: \(error.localizedDescription)")
                return .failed(error.localizedDescription)
            }
        }
        tail = Task { _ = await job.value }
        return await job.value
    }

    /// Open beside: the block's page in the side pane, drawn first if
    /// it hasn't been (a diagram's page is written as it's drawn).
    func openBeside(_ block: RichBlock) {
        let file = RichDiskCache.panePage(block)
        let title = block.kind == .mermaid ? "Diagram" : "Page"
        if FileManager.default.fileExists(atPath: file.path) {
            AppModel.shared.previewRichBlock(file, title: title)
            return
        }
        if block.kind == .html {
            if (try? writePanePage(RichPages.htmlPage(block.source), for: block)) != nil { AppModel.shared.previewRichBlock(file, title: title) }
            return
        }
        Task { @MainActor in
            _ = await render(block, zoom: TypeScale.percent)
            if FileManager.default.fileExists(atPath: file.path) { AppModel.shared.previewRichBlock(file, title: title) }
        }
    }

    /// Gives up on a drawing after `timeout` without waiting for it: a
    /// hung WebKit call never returns, so the views are dropped (new ones
    /// are made for the next block) and the queue moves on (cross-lab
    /// review, 6 Nov: a group's timeout still waited on the stuck child).
    private func withTimeout<T: Sendable>(_ work: @escaping @MainActor () async throws -> T) async throws -> T {
        let once = RenderOnce()
        return try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<T, Error>) in
            let worker = Task { @MainActor in
                do {
                    let value = try await work()
                    guard !once.done else { return }
                    once.done = true
                    continuation.resume(returning: value)
                } catch {
                    guard !once.done else { return }
                    once.done = true
                    continuation.resume(throwing: error)
                }
            }
            Task { @MainActor [weak self] in
                try? await Task.sleep(for: Self.timeout)
                guard !once.done else { return }
                once.done = true
                worker.cancel()
                self?.reset()
                continuation.resume(throwing: Failure.timedOut)
            }
        }
    }

    /// Drops both views and fails anything waiting on them.
    private func reset() {
        for (_, waiting) in loads { waiting.resume(throwing: Failure.timedOut) }
        loads = [:]
        for view in [diagramView, pageView].compactMap({ $0 }) {
            view.stopLoading()
            view.navigationDelegate = nil
            view.uiDelegate = nil
        }
        diagramView = nil
        pageView = nil
        // A page given up on mid-way never reached its own forget.
        previews.forgetAll()
    }

    // MARK: Diagrams

    private static var peleSource: String? = {
        let name = "Threadbear_Threadbear.bundle"
        // The app's bundle, or beside the test bundle in `swift test`.
        let bundle = [Bundle.main.resourceURL, Bundle.main.bundleURL, Bundle.main.executableURL?.deletingLastPathComponent(),
                      Bundle(for: RichRenderer.self).bundleURL.deletingLastPathComponent()]
            .compactMap { $0?.appendingPathComponent(name) }
            .first { FileManager.default.fileExists(atPath: $0.path) }
            .flatMap(Bundle.init(url:))
        guard let url = bundle?.url(forResource: "pele", withExtension: "js", subdirectory: "Rich") else { return nil }
        return try? String(contentsOf: url, encoding: .utf8)
    }()

    private func makeDiagramView() async throws -> WKWebView {
        if let diagramView { return diagramView }
        guard let pele = Self.peleSource else { throw Failure.unavailable("the diagram library is missing from the app") }
        let config = WKWebViewConfiguration()
        // Scripts on for the app's own page; it never loads anything else
        // (the navigation policy), and the lockdown keeps it off the network.
        PreviewSandbox.lockDown(config, proxy: proxy, pageScripts: true)
        config.userContentController.addUserScript(WKUserScript(source: pele, injectionTime: .atDocumentStart, forMainFrameOnly: true, in: world))
        guard let rules = await PreviewSandbox.rules() else { throw Failure.unavailable("its sandbox couldn't be set up") }
        config.userContentController.add(rules)
        let view = makeView(config)
        try await load(view) { $0.loadHTMLString(RichPages.diagramPage, baseURL: nil) }
        diagramView = view
        return view
    }

    private struct DiagramPicture { var image: CGImage; var size: CGSize; var svg: String }

    private func drawDiagram(_ block: RichBlock, zoom: Int) async throws -> Rendered {
        let view = try await makeDiagramView()
        var looks: [Bool: DiagramPicture] = [:]
        for dark in [true, false] {
            // Room to lay out at its own size: in a smaller view the page
            // was cut at the view's edge before the snapshot was sized.
            view.frame = NSRect(x: 0, y: 0, width: 3000, height: 3000)
            let result = try await view.callAsyncJavaScript(
                RichPages.drawScript + "\n", arguments: ["source": block.source, "dark": dark, "fontSize": 14.0 * Double(zoom) / 100,
                                                     "maxSide": RichPages.diagramMaxSide, "maxArea": RichPages.diagramMaxArea],
                in: nil, contentWorld: world)
            guard let answer = result as? [String: Any] else { throw Failure.unavailable("the diagram library gave nothing back") }
            if let error = answer["error"] as? String { throw Failure.unavailable(error) }
            let width = (answer["width"] as? NSNumber)?.doubleValue ?? 0
            let height = (answer["height"] as? NSNumber)?.doubleValue ?? 0
            guard width > 0, height > 0 else { throw Failure.unavailable("the diagram came out empty") }
            let svg = (try? await view.callAsyncJavaScript("return document.getElementById('out').innerHTML", arguments: [:], in: nil, contentWorld: world) as? String) ?? ""
            let size = CGSize(width: width, height: height)
            looks[dark] = DiagramPicture(image: try await snapshot(view, size: size), size: size, svg: svg)
        }
        guard let dark = looks[true], let light = looks[false] else { throw Failure.unavailable("the diagram came out empty") }
        let page = RichPages.diagramPanePage(darkSVG: dark.svg, lightSVG: light.svg, title: "Diagram")
        try? writePanePage(page, for: block)
        return Rendered(drawn: RichBlocks.Drawn(size: dark.size, clipped: false), pictures: RichBlocks.Pictures(dark: dark.image, light: light.image))
    }

    // MARK: Pages

    private func makePageView() async throws -> WKWebView {
        if let pageView { return pageView }
        let config = WKWebViewConfiguration()
        config.setURLSchemeHandler(previews, forURLScheme: LocalPreviewSchemeHandler.scheme)
        PreviewSandbox.lockDown(config, proxy: proxy, pageScripts: false)
        guard let rules = await PreviewSandbox.rules() else { throw Failure.unavailable("its sandbox couldn't be set up") }
        config.userContentController.add(rules)
        let view = makeView(config)
        pageView = view
        return view
    }

    private func drawPage(_ block: RichBlock, zoom: Int) async throws -> Rendered {
        let file = try writePanePage(RichPages.htmlPage(block.source), for: block)
        let view = try await makePageView()
        guard let address = previews.address(for: file) else { throw Failure.unavailable("the page couldn't be opened") }
        // Its site holds the folder open; done with, it's let go.
        defer { previews.forget(file) }
        let width = Self.pageWidth
        view.pageZoom = CGFloat(zoom) / 100
        var looks: [Bool: (CGImage, CGSize, Bool)] = [:]
        for dark in [true, false] {
            view.appearance = NSAppearance(named: dark ? .darkAqua : .aqua)
            // A short view, as scrollHeight is never less than the view's
            // own height: in a tall one a short page measured that tall.
            view.frame = NSRect(x: 0, y: 0, width: width, height: 1)
            try await load(view) { $0.load(URLRequest(url: address)) }
            // The page's own scripts are off; this one runs in the app's world.
            let measured = try await view.callAsyncJavaScript(
                "return Math.max(document.documentElement.scrollHeight, document.body ? document.body.scrollHeight : 0)",
                arguments: [:], in: nil, contentWorld: .defaultClient)
            let height = max(1, CGFloat((measured as? NSNumber)?.doubleValue ?? 1))
            let shown = min(height, Self.pageMaxHeight)
            let size = CGSize(width: width, height: ceil(shown))
            looks[dark] = (try await snapshot(view, size: size), size, height > Self.pageMaxHeight)
        }
        view.loadHTMLString("", baseURL: nil)
        guard let dark = looks[true], let light = looks[false] else { throw Failure.unavailable("the page came out empty") }
        let size = CGSize(width: dark.1.width, height: max(dark.1.height, light.1.height))
        return Rendered(drawn: RichBlocks.Drawn(size: size, clipped: dark.2 || light.2), pictures: RichBlocks.Pictures(dark: dark.0, light: light.0))
    }

    /// The block's page, in a folder of its own (so the preview scheme,
    /// which lets a page read what's beside it, finds nothing else there),
    /// for drawing it and for Open beside.
    @discardableResult
    private func writePanePage(_ html: String, for block: RichBlock) throws -> URL {
        let file = RichDiskCache.panePage(block)
        try FileManager.default.createDirectory(at: file.deletingLastPathComponent(), withIntermediateDirectories: true)
        try html.write(to: file, atomically: true, encoding: .utf8)
        return file
    }

    // MARK: Views

    private func makeView(_ config: WKWebViewConfiguration) -> WKWebView {
        let view = WKWebView(frame: NSRect(x: 0, y: 0, width: Self.pageWidth, height: 200), configuration: config)
        view.navigationDelegate = self
        view.uiDelegate = self
        // See-through, so a diagram sits on the box's own fill.
        view.setValue(false, forKey: "drawsBackground")
        return view
    }

    private func load(_ view: WKWebView, _ start: (WKWebView) -> Void) async throws {
        // A drawing given up on doesn't start another load on its way out.
        try Task.checkCancellation()
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            loads[ObjectIdentifier(view)]?.resume(throwing: CancellationError())
            loads[ObjectIdentifier(view)] = continuation
            start(view)
        }
    }

    private func snapshot(_ view: WKWebView, size: CGSize) async throws -> CGImage {
        view.frame = NSRect(origin: .zero, size: size)
        let config = WKSnapshotConfiguration()
        config.rect = CGRect(origin: .zero, size: size)
        // At most about a million points (four million pixels on Retina):
        // more than the box ever shows, and the pane draws the SVG itself.
        let scale = min(1, (Self.snapshotPoints / max(size.width * size.height, 1)).squareRoot())
        config.snapshotWidth = NSNumber(value: Double(floor(size.width * scale)))
        config.afterScreenUpdates = true
        let image = try await view.takeSnapshot(configuration: config)
        try Task.checkCancellation()
        guard let cgImage = image.cgImage(forProposedRect: nil, context: nil, hints: nil) else { throw Failure.unavailable("the picture came out empty") }
        return cgImage
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        loads.removeValue(forKey: ObjectIdentifier(webView))?.resume()
    }

    /// The page's process died (a page too big, say): fail what waits on
    /// it and start afresh next time.
    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        loads.removeValue(forKey: ObjectIdentifier(webView))?.resume(throwing: Failure.unavailable("its web view stopped"))
        if webView === diagramView { diagramView = nil }
        if webView === pageView { pageView = nil }
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        loads.removeValue(forKey: ObjectIdentifier(webView))?.resume(throwing: error)
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        loads.removeValue(forKey: ObjectIdentifier(webView))?.resume(throwing: error)
    }

    /// Only the app's own loads: the diagram page (about:blank) and a
    /// block's page on the preview scheme. Never a link, a form, a
    /// download or a script's navigation, in any frame.
    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction,
                 decisionHandler: @escaping @MainActor (WKNavigationActionPolicy) -> Void) {
        let url = navigationAction.request.url
        let ownLoad = navigationAction.navigationType == .other && navigationAction.targetFrame?.isMainFrame == true
        let allowed = ownLoad && !navigationAction.shouldPerformDownload
            && (url?.absoluteString == "about:blank" || (webView === pageView && url?.scheme == LocalPreviewSchemeHandler.scheme))
        decisionHandler(allowed ? .allow : .cancel)
    }

    func webView(_ webView: WKWebView, decidePolicyFor navigationResponse: WKNavigationResponse,
                 decisionHandler: @escaping @MainActor (WKNavigationResponsePolicy) -> Void) {
        decisionHandler(navigationResponse.canShowMIMEType && navigationResponse.isForMainFrame ? .allow : .cancel)
    }

    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
                 for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? { nil }
}

/// Whichever of a drawing and its timeout finishes first (RichRenderer.withTimeout).
private final class RenderOnce: @unchecked Sendable { var done = false }
