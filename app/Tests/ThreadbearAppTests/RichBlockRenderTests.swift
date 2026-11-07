import AppKit
import Network
import XCTest
@testable import Threadbear
@testable import ThreadbearCore

/// ```mermaid and ```html blocks in replies: drawn in a box (RichBlockCell)
/// once their fence is closed, by RichRenderer's sandboxed web views.
@MainActor
final class RichBlockRenderTests: XCTestCase {
    override func setUp() {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("RichBlockRenderTests-\(UUID().uuidString)")
        RichDiskCache.folderOverride = dir
        addTeardownBlock {
            RichDiskCache.folderOverride = nil
            try? FileManager.default.removeItem(at: dir)
        }
    }

    private func cell(_ text: NSAttributedString) -> (RichBlockCell, NSRange)? {
        var found: (RichBlockCell, NSRange)?
        text.enumerateAttribute(.attachment, in: NSRange(location: 0, length: text.length)) { value, range, stop in
            if let cell = (value as? NSTextAttachment)?.attachmentCell as? RichBlockCell { found = (cell, range); stop.pointee = true }
        }
        return found
    }

    func testAClosedMermaidFenceIsABoxThatCopiesAsItsSource() throws {
        let text = MarkdownRenderer.render("Here:\n\n```mermaid\nflowchart TD\n  A --> B\n```\n\nDone.").string
        let (box, range) = try XCTUnwrap(cell(text))
        XCTAssertEqual(box.block.kind, .mermaid)
        XCTAssertEqual(box.block.source, "flowchart TD\n  A --> B")
        XCTAssertEqual(text.attribute(.tbCopyText, at: range.location, effectiveRange: nil) as? String, "```mermaid\nflowchart TD\n  A --> B\n```")
        XCTAssertTrue(text.string.contains("Done."))
    }

    func testAFenceStillStreamingInStaysCode() {
        // The reply so far: the fence isn't closed yet.
        let open = MarkdownRenderer.render("Here:\n\n```mermaid\nflowchart TD\n  A --> ").string
        XCTAssertNil(cell(open))
        XCTAssertTrue(open.string.contains("A -->"))
        XCTAssertNil(cell(MarkdownRenderer.render("```swift\nlet x = 1\n```").string))
    }

    func testTheBoxIsAsWideAsTheLineAndItsButtonsAreFound() throws {
        let block = RichBlock(kind: .html, source: "<b>hi</b>\n<i>there</i>")
        let box = RichBlockCell(block: block, state: .failed("nope"), showsSource: false)
        let container = NSTextContainer(size: NSSize(width: 600, height: 1000))
        let frame = box.cellFrame(for: container, proposedLineFragment: NSRect(x: 0, y: 0, width: 600, height: 20), glyphPosition: .zero, characterIndex: 0)
        XCTAssertEqual(frame.width, 600)
        // Header, the error and two lines of source.
        XCTAssertGreaterThan(frame.height, RichBlockCell.headerHeight + Theme.codeLine * 2)
        let layout = box.layout(in: frame)
        for action in RichBlockCell.Action.allCases {
            let rect = try XCTUnwrap(layout.buttons[action])
            XCTAssertEqual(box.action(at: NSPoint(x: rect.midX, y: rect.midY), in: frame), action)
            XCTAssertFalse(action.tip(block).isEmpty)
        }
        XCTAssertNil(box.action(at: NSPoint(x: 20, y: frame.maxY - 5), in: frame))
    }

    func testADiagramIsDrawnInBothLooksAndABrokenOneSaysWhy() async throws {
        let renderer = RichRenderer()
        let block = RichBlock(kind: .mermaid, source: "flowchart TD\n  A[Start] --> B{Done?}\n  B -- no --> A")
        let outcome = await renderer.render(block, zoom: 100)
        guard case .drawn(let rendered) = outcome else { return XCTFail("not drawn: \(outcome)") }
        let drawn = rendered.drawn
        XCTAssertGreaterThan(drawn.size.width, 50)
        XCTAssertGreaterThan(drawn.size.height, 100)
        XCTAssertGreaterThanOrEqual(rendered.pictures.dark.width, Int(drawn.size.width))
        XCTAssertEqual(rendered.pictures.dark.width, rendered.pictures.light.width)
        // Its page for the side pane, with the diagram in both looks.
        let page = try String(contentsOf: RichDiskCache.panePage(block), encoding: .utf8)
        XCTAssertEqual(page.components(separatedBy: "<svg").count - 1, 2)

        // One that asks to be enormous is drawn within the budget.
        let chains = (0..<12).map { c in (0..<12).map { "C\(c)N\($0)" }.joined(separator: " --> ") }.joined(separator: "\n  ")
        let huge = RichBlock(kind: .mermaid, source: "%%{init: {\"flowchart\": {\"nodeSpacing\": 2000, \"rankSpacing\": 2000}}}%%\nflowchart LR\n  \(chains)")
        let big = await renderer.render(huge, zoom: 100)
        guard case .drawn(let bounded) = big else { return XCTFail("not drawn: \(big)") }
        XCTAssertLessThanOrEqual(bounded.drawn.size.width, CGFloat(RichPages.diagramMaxSide + 8))
        XCTAssertLessThanOrEqual(bounded.drawn.size.height, CGFloat(RichPages.diagramMaxSide + 8))
        XCTAssertLessThanOrEqual(bounded.pictures.dark.width * bounded.pictures.dark.height, 4_200_000)

        let broken = RichBlock(kind: .mermaid, source: "flowchart TD\n  A -->")
        guard case .failed(let why) = await renderer.render(broken, zoom: 100) else { return XCTFail("a broken diagram was drawn") }
        XCTAssertTrue(why.contains("line 2"), why)
    }

    /// The HTML box: the agent's scripts don't run, and nothing it names
    /// reaches the network, by markup or a refresh, through the proxy or round it.
    func testAPageIsDrawnWithItsScriptsOffAndNothingGetsOut() async throws {
        let server = try Listener()
        try await server.start()
        let sink = try Listener()
        try await sink.start()
        let out = "http://127.0.0.1:\(server.port)"
        let named = "http://exfil.invalid:\(server.port)"
        let (_, response) = try await URLSession.shared.data(from: URL(string: out + "/ping")!)
        XCTAssertEqual((response as? HTTPURLResponse)?.statusCode, 200)
        try await Task.sleep(for: .milliseconds(100))
        let before = server.hits

        let renderer = RichRenderer()
        renderer.proxy = .hostPort(host: "127.0.0.1", port: NWEndpoint.Port(rawValue: sink.port)!)
        let block = RichBlock(kind: .html, source: """
        <meta http-equiv="Content-Security-Policy" content="default-src *">
        <link rel="stylesheet" href="\(out)/css"><style>@import url("\(named)/import"); body{background:url(\(out)/bg)}</style>
        <div id="x" style="width:300px;height:80px;background:#3b82f6">static</div>
        <img src="\(out)/img"><img src="\(named)/img2"><iframe src="\(out)/frame"></iframe>
        <video src="\(out)/video" autoplay></video><object data="\(out)/object"></object>
        <script>document.getElementById('x').style.height = '900px'; fetch('\(out)/fetch'); location.href = '\(out)/location';</script>
        <meta http-equiv="refresh" content="0;url=\(out)/refresh">
        <form action="\(out)/form"><input autofocus></form>
        """)
        let outcome = await renderer.render(block, zoom: 100)
        guard case .drawn(let rendered) = outcome else { return XCTFail("not drawn: \(outcome)") }
        let drawn = rendered.drawn
        // The script would have made it 900 tall.
        XCTAssertLessThan(drawn.size.height, 400)
        try await Task.sleep(for: .seconds(2))
        XCTAssertEqual(server.hits, before, "a request got out of the box: \(server.requests)")
        XCTAssertTrue(sink.requests.allSatisfy { $0.hasPrefix("CONNECT ") }, "\(sink.requests)")
    }

    /// A server on this Mac standing in for an attacker's (as LocalPreviewTests).
    private final class Listener: @unchecked Sendable {
        let listener: NWListener
        private let lock = NSLock()
        private var _hits = 0
        private var _requests: [String] = []
        var hits: Int { lock.withLock { _hits } }
        var requests: [String] { lock.withLock { _requests } }
        var port: UInt16 { listener.port?.rawValue ?? 0 }

        init() throws {
            listener = try NWListener(using: .tcp, on: .any)
            listener.newConnectionHandler = { [weak self] connection in
                self?.lock.withLock { self?._hits += 1 }
                connection.start(queue: .global())
                connection.receive(minimumIncompleteLength: 1, maximumLength: 4096) { data, _, _, _ in
                    let line = data.flatMap { String(data: $0, encoding: .utf8)?.components(separatedBy: "\r\n").first } ?? "(nothing)"
                    self?.lock.withLock { self?._requests.append(line) }
                    connection.send(content: Data("HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n".utf8), completion: .contentProcessed { _ in connection.cancel() })
                }
            }
        }

        func start() async throws {
            listener.start(queue: .global())
            for _ in 0..<50 where listener.port == nil || listener.state != .ready { try await Task.sleep(for: .milliseconds(20)) }
        }

        deinit { listener.cancel() }
    }
}
