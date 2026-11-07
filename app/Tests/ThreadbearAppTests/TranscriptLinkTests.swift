import AppKit
import XCTest
@testable import Threadbear
import ThreadbearCore

@MainActor
final class TranscriptLinkTests: XCTestCase {
    private func link(_ markdown: String) throws -> URL {
        let text = MarkdownRenderer.render(markdown).string
        return try XCTUnwrap(text.attribute(.link, at: 0, effectiveRange: nil) as? URL)
    }

    func testAbsoluteHTMLAndOrdinaryFilesAreFileURLs() throws {
        let path = "/Users/m5-mike/dev/me/threadbear/docs/options-review-design/index.html"
        let html = try link("[Open both mockups and the recommendation](\(path))")
        XCTAssertTrue(html.isFileURL)
        XCTAssertEqual(html.path, path)
        let text = try link("[Notes](/tmp/notes.txt)")
        XCTAssertTrue(text.isFileURL)
        XCTAssertEqual(text.path, "/tmp/notes.txt")
    }

    /// end_turn's links take ~ paths, and the ask's words link to the same.
    func testHomePathsAreFileURLs() throws {
        let home = FileManager.default.homeDirectoryForCurrentUser.path
        for destination in ["~/shots/pair one.png", "~/shots/pair%20one.png"] {
            let url = try link("[the pairing screenshot](<\(destination)>)")
            XCTAssertTrue(url.isFileURL)
            XCTAssertEqual(url.path, home + "/shots/pair one.png")
        }
    }

    /// A page's ?query is for its own script, so the link keeps it but
    /// the file it names is the path alone.
    func testQueriesStayOnFileLinks() throws {
        let home = FileManager.default.homeDirectoryForCurrentUser.path
        let tilde = try link("[grow](~/misc/grow.html?clean&s=45)")
        XCTAssertEqual(tilde.path, home + "/misc/grow.html")
        XCTAssertEqual(tilde.query, "clean&s=45")
        let absolute = try link("[grow](/tmp/grow.html?clean#end)")
        XCTAssertEqual(absolute.path, "/tmp/grow.html")
        XCTAssertEqual(absolute.query, "clean")
        XCTAssertEqual(absolute.fragment, "end")
        let code = try XCTUnwrap(MarkdownRenderer.render("`~/misc/grow.html?clean&s=45`").string.attribute(.link, at: 0, effectiveRange: nil) as? URL)
        XCTAssertEqual(FilePathRefs.text(of: code), "~/misc/grow.html?clean&s=45")
    }

    func testSpacesAndPercentEscapesAreDecodedOnce() throws {
        for destination in ["/tmp/Review Files/index.html", "/tmp/Review%20Files/index.html"] {
            let url = try link("[Review](<\(destination)>)")
            XCTAssertTrue(url.isFileURL)
            XCTAssertEqual(url.path, "/tmp/Review Files/index.html")
        }
        XCTAssertEqual(try link("[Review](/tmp/100%25%20done.html)").path, "/tmp/100% done.html")
        let escaped = try link("[Notes](/tmp/literal%2520name.txt)")
        XCTAssertEqual(escaped.path, "/tmp/literal%20name.txt")
    }

    func testHTMLFragmentAndExistingURLsArePreserved() throws {
        let html = try link("[Section](/tmp/review.html#recommendation)")
        XCTAssertTrue(html.isFileURL)
        XCTAssertEqual(html.path, "/tmp/review.html")
        XCTAssertEqual(html.fragment, "recommendation")
        for destination in ["https://example.com/a%20b?q=hello#section", "file:///tmp/Review%20Files/index.html"] {
            XCTAssertEqual(try link("[Open](\(destination))"), URL(string: destination))
        }
    }

    func testLocalImageFallbackIsAlsoAFileLink() throws {
        let url = try link("![Preview](/tmp/preview.png)")
        XCTAssertTrue(url.isFileURL)
        XCTAssertEqual(url.path, "/tmp/preview.png")
    }

    func testColonSuffixIsNotTreatedAsAnEditorLineNumber() throws {
        // There is no editor/line dispatch in the transcript. Colons can
        // belong to a real filename, so the URL conversion preserves them.
        let url = try link("[Source](/tmp/source.swift:12)")
        XCTAssertTrue(url.isFileURL)
        XCTAssertEqual(url.path, "/tmp/source.swift:12")
    }

    func testBareURLsAreLinked() throws {
        let text = MarkdownRenderer.render("The preview is running again at http://localhost:5176, so refresh it.").string
        let start = (text.string as NSString).range(of: "http://").location
        var range = NSRange()
        let url = try XCTUnwrap(text.attribute(.link, at: start, effectiveRange: &range) as? URL)
        XCTAssertEqual(url, URL(string: "http://localhost:5176"))
        XCTAssertEqual((text.string as NSString).substring(with: range), "http://localhost:5176")
        let underscored = MarkdownRenderer.render("See https://example.com/a_b_c/page for more").string
        let at = (underscored.string as NSString).range(of: "https").location
        XCTAssertEqual(underscored.attribute(.link, at: at, effectiveRange: nil) as? URL, URL(string: "https://example.com/a_b_c/page"))
        let code = MarkdownRenderer.render("Open `https://example.com` now").string
        let codeAt = (code.string as NSString).range(of: "https").location
        XCTAssertEqual(code.attribute(.link, at: codeAt, effectiveRange: nil) as? URL, URL(string: "https://example.com"))
    }

    func testWordsAndCodeBlocksAreNotLinked() {
        let text = MarkdownRenderer.render("Read CLAUDE.md and example.com first").string
        text.enumerateAttribute(.link, in: NSRange(location: 0, length: text.length)) { value, _, _ in XCTAssertNil(value) }
        let block = MarkdownRenderer.render("```\ncurl https://example.com\n```").string
        block.enumerateAttribute(.link, in: NSRange(location: 0, length: block.length)) { value, _, _ in XCTAssertNil(value) }
    }

    func testMarkdownLinkKeepsItsDestination() throws {
        let url = try link("[https://shown.example](https://real.example)")
        XCTAssertEqual(url, URL(string: "https://real.example"))
    }

    func testTextViewOpensLocalFileThroughWorkspace() throws {
        let text = MarkdownRenderer.render("[Review](</tmp/Review Files/index.html>)").string
        let view = TranscriptTextView()
        view.show(text, width: 500)
        var opened: URL?
        view.openFileLink = { opened = $0; return true }
        let value = try XCTUnwrap(view.textStorage?.attribute(.link, at: 0, effectiveRange: nil))
        view.clicked(onLink: value, at: 0)
        let clicked = try XCTUnwrap(opened)
        XCTAssertTrue(clicked.isFileURL)
        XCTAssertEqual(clicked.path, "/tmp/Review Files/index.html")
    }

    func testHTTPSKeepsAppKitClickHandling() throws {
        let view = TranscriptTextView()
        let delegate = LinkDelegate()
        view.delegate = delegate
        view.openFileLink = { _ in XCTFail("HTTPS must keep AppKit's normal handling"); return false }
        let url = try XCTUnwrap(URL(string: "https://example.com/path#section"))
        view.openWebLink = { _ in false }
        view.clicked(onLink: url, at: 0)
        XCTAssertEqual(delegate.clicked, url)
    }

    func testWebLinkSetToThePanelSkipsAppKit() throws {
        let view = TranscriptTextView()
        let delegate = LinkDelegate()
        view.delegate = delegate
        var opened: URL?
        view.openWebLink = { opened = $0; return true }
        let url = try XCTUnwrap(URL(string: "http://localhost:5176/"))
        view.clicked(onLink: url, at: 0)
        XCTAssertEqual(opened, url)
        XCTAssertNil(delegate.clicked)
    }
}

private final class LinkDelegate: NSObject, NSTextViewDelegate {
    var clicked: URL?

    func textView(_ textView: NSTextView, clickedOnLink link: Any, at charIndex: Int) -> Bool {
        clicked = link as? URL
        return true // Observe AppKit's click without launching another app in a unit test.
    }
}

@MainActor
final class TranscriptPathRefTests: XCTestCase {
    func testPathInInlineCodeOpensThroughPathRef() throws {
        let text = MarkdownRenderer.render("The change is in `app/Sources/A.swift`, see `npm test`.").string
        let at = (text.string as NSString).range(of: "app/").location
        let url = try XCTUnwrap(text.attribute(.link, at: at, effectiveRange: nil) as? URL)
        XCTAssertEqual(FilePathRefs.text(of: url), "app/Sources/A.swift")
        XCTAssertNil(text.attribute(.link, at: (text.string as NSString).range(of: "npm").location, effectiveRange: nil))
        let view = TranscriptTextView()
        var opened: String?
        view.openPathRef = { opened = $0; return true }
        view.openFileLink = { _ in XCTFail("a path ref resolves first"); return false }
        view.clicked(onLink: url, at: at)
        XCTAssertEqual(opened, "app/Sources/A.swift")
    }

    /// `[plan](shorts-plan/candidates.md)` went to AppKit as a scheme-less
    /// URL and Finder said "can't be opened. -50" (6 Nov).
    func testRelativeMarkdownLinkIsAPathRef() throws {
        let cases = [
            "[candidates.md](shorts-plan/candidates.md)": "shorts-plan/candidates.md",
            "[clip](exports/series-examples/example-no-project-picker.mp4)": "exports/series-examples/example-no-project-picker.mp4",
            "[launch](exports/Threadbear%20Launch.mp4)": "exports/Threadbear Launch.mp4",
            "[launch](<exports/Threadbear Launch.mp4>)": "exports/Threadbear Launch.mp4",
            "[up](../notes.md)": "../notes.md",
            "[page](site/grow.html?clean#top)": "site/grow.html?clean#top",
        ]
        for (markdown, path) in cases {
            let url = try link(markdown)
            XCTAssertEqual(FilePathRefs.text(of: url), path, markdown)
        }
        XCTAssertNil(MarkdownRenderer.render("[below](#usage)").string.attribute(.link, at: 0, effectiveRange: nil))
        XCTAssertEqual(try link("[mail](mailto:a@b.co)").scheme, "mailto")

        let view = TranscriptTextView()
        let delegate = LinkDelegate()
        view.delegate = delegate
        var opened: [String] = []
        view.openPathRef = { opened.append($0); return true }
        view.clicked(onLink: try link("[c](shorts-plan/candidates.md)"), at: 0)
        // One with no scheme that got here some other way doesn't reach AppKit either.
        view.clicked(onLink: try XCTUnwrap(URL(string: "shorts-plan/a%20b.md")), at: 0)
        XCTAssertEqual(opened, ["shorts-plan/candidates.md", "shorts-plan/a b.md"])
        XCTAssertNil(delegate.clicked)
    }

    private func link(_ markdown: String) throws -> URL {
        try XCTUnwrap(MarkdownRenderer.render(markdown).string.attribute(.link, at: 0, effectiveRange: nil) as? URL)
    }
}

@MainActor
final class FileLinkMenuTests: XCTestCase {
    private var saved: String?

    override func setUp() async throws {
        saved = UserDefaults.standard.string(forKey: "transcriptFileLinkClick")
        // A menu item's action goes nowhere until there's an NSApp.
        _ = NSApplication.shared
    }

    override func tearDown() async throws {
        UserDefaults.standard.set(saved, forKey: "transcriptFileLinkClick")
    }

    private func view(_ markdown: String) -> TranscriptTextView {
        let view = TranscriptTextView()
        view.show(MarkdownRenderer.render(markdown).string, width: 500)
        return view
    }

    /// A point on the character at `index`, in the view's coordinates.
    private func point(_ view: TranscriptTextView, at index: Int) throws -> NSPoint {
        let layout = try XCTUnwrap(view.layoutManager), container = try XCTUnwrap(view.textContainer)
        let glyphs = layout.glyphRange(forCharacterRange: NSRange(location: index, length: 1), actualCharacterRange: nil)
        let rect = layout.boundingRect(forGlyphRange: glyphs, in: container)
        return NSPoint(x: rect.midX + view.textContainerOrigin.x, y: rect.midY + view.textContainerOrigin.y)
    }

    /// Mike's Default is the panel, which could only show a project as JSON.
    func testAClickOnAProjectFileOpensItsAppWhateverDefaultSays() {
        let saved = FileLinkAction.click
        defer { FileLinkAction.click = saved }
        FileLinkAction.click = .panel
        let tandem: (URL) -> URL? = { _ in URL(fileURLWithPath: "/Applications/Tandem.app") }
        func action(_ path: String, command: Bool = false, remote: Bool = false, app: @escaping (URL) -> URL? = tandem) -> FileLinkAction {
            FileLinkAction.forClick(on: path, commandKey: command, remote: remote, appFor: app)
        }
        XCTAssertEqual(action("/v/Pebble Index mic test.tandem"), .app)
        XCTAssertEqual(action("/v/notes.md"), .panel)
        XCTAssertEqual(action("/v/notes.md", command: true), .app)
        // Another Mac's project is only a copy, without its media.
        XCTAssertEqual(action("/v/a.tandem", remote: true), .panel)
        // Missing, or no app for it: the pane says so.
        XCTAssertEqual(action("/v/a.tandem", app: { _ in nil }), .panel)
        XCTAssertNil(FileLinkAction.defaultApp(URL(fileURLWithPath: "/nowhere/missing.tandem")))
    }

    func testRightClickOnAPathOffersWaysToOpenIt() throws {
        let view = view("Changed `app/A.swift` today")
        view.fileLinkTarget = { url in FilePathRefs.text(of: url) == "app/A.swift" ? URL(fileURLWithPath: "/repo/app/A.swift") : nil }
        var opened: [(URL, FileLinkAction)] = []
        view.openFile = { opened.append(($0, $1)) }
        let at = (view.string as NSString).range(of: "app/").location
        let menu = try XCTUnwrap(view.fileLinkMenu(at: point(view, at: at)))
        let titles = menu.items.map(\.title)
        XCTAssertEqual(titles.first, "Open in Panel")
        XCTAssertTrue(titles.contains("Show in Finder"))
        XCTAssertTrue(titles.contains("Copy Path"))
        XCTAssertTrue(titles.contains { $0.hasPrefix("Open in ") && $0 != "Open in Panel" })

        let finder = try XCTUnwrap(menu.items.first { $0.title == "Show in Finder" })
        menu.performActionForItem(at: menu.index(of: finder))
        XCTAssertEqual(opened.first?.0.path, "/repo/app/A.swift")
        XCTAssertEqual(opened.first?.1, .finder)

        // "Default" sets what a plain click does, and ticks it.
        let clickOpens = try XCTUnwrap(menu.items.first { $0.title == "Default" }?.submenu)
        let panel = try XCTUnwrap(clickOpens.items.first { $0.title == "Open in Panel" })
        clickOpens.performActionForItem(at: clickOpens.index(of: panel))
        XCTAssertEqual(FileLinkAction.click, .panel)
        let again = try XCTUnwrap(view.fileLinkMenu(at: point(view, at: at))?.items.first { $0.title == "Default" }?.submenu)
        XCTAssertEqual(again.items.filter { $0.state == .on }.map(\.title), ["Open in Panel"])
    }

    func testAPathWithAQueryPeeksAtTheFileAndOpensWithTheQuery() throws {
        let view = view("Open `~/misc/grow.html?clean&s=45` to watch")
        let target = try XCTUnwrap(URL(string: "file:///tmp/misc/grow.html?clean&s=45"))
        view.fileLinkTarget = { url in FilePathRefs.text(of: url) == "~/misc/grow.html?clean&s=45" ? target : nil }
        var opened: [URL] = []
        view.openFile = { url, _ in opened.append(url) }
        let menu = try XCTUnwrap(view.fileLinkMenu(at: point(view, at: (view.string as NSString).range(of: "grow").location)))
        for title in ["Open in Panel", "Show in Finder"] {
            let item = try XCTUnwrap(menu.items.first { $0.title == title })
            menu.performActionForItem(at: menu.index(of: item))
        }
        XCTAssertEqual(opened, [target, target])
        XCTAssertEqual(view.debugPeeks().map(\.url), [URL(fileURLWithPath: "/tmp/misc/grow.html")])

    }

    func testMissingFileAndPlainTextMenus() throws {
        let view = view("Changed `app/Gone.swift` today")
        view.fileLinkTarget = { _ in nil }
        let at = (view.string as NSString).range(of: "app/").location
        XCTAssertEqual(try XCTUnwrap(view.fileLinkMenu(at: point(view, at: at))).items.map(\.title), ["Couldn't Find This File"])
        XCTAssertNil(view.fileLinkMenu(at: try point(view, at: 2)))
    }

    func testFileLinksGetAPlainTip() {
        let text = MarkdownRenderer.render("See `app/A.swift` and [x](https://example.com)").string
        let path = (text.string as NSString).range(of: "app/").location
        XCTAssertEqual(text.attribute(.toolTip, at: path, effectiveRange: nil) as? String, "Click to open, right-click for more")
        XCTAssertNil(text.attribute(.toolTip, at: text.length - 1, effectiveRange: nil))
    }
}
