import XCTest
@testable import ThreadbearCore

/// Which fences are drawn as diagrams and pages, and the pages the app's
/// sandboxed web views are given.
final class RichBlockTests: XCTestCase {
    func testOnlyMermaidAndHTMLFencesCount() {
        XCTAssertEqual(RichBlock.from(language: "mermaid", code: "flowchart TD\n  A --> B\n")?.kind, .mermaid)
        XCTAssertEqual(RichBlock.from(language: "Mermaid", code: "graph LR\nA-->B")?.kind, .mermaid)
        XCTAssertEqual(RichBlock.from(language: "HTML title=chart", code: "<b>hi</b>")?.kind, .html)
        XCTAssertNil(RichBlock.from(language: "swift", code: "let x = 1"))
        XCTAssertNil(RichBlock.from(language: "htmlbars", code: "x"))
        XCTAssertNil(RichBlock.from(language: nil, code: "flowchart TD"))
        XCTAssertNil(RichBlock.from(language: "mermaid", code: "  \n"))
        XCTAssertNil(RichBlock.from(language: "html", code: String(repeating: "a", count: RichBlock.maxSource + 1)))
    }

    func testTheSourceLosesItsTrailingNewlineAndTheIdIsStable() throws {
        let a = try XCTUnwrap(RichBlock.from(language: "mermaid", code: "graph LR\nA-->B\n\n"))
        let b = try XCTUnwrap(RichBlock.from(language: "mermaid", code: "graph LR\nA-->B"))
        XCTAssertEqual(a.source, "graph LR\nA-->B")
        XCTAssertEqual(a.id, b.id)
        XCTAssertEqual(a.id.count, 20)
        XCTAssertNotEqual(a.id, RichBlock(kind: .html, source: a.source).id)
    }

    func testAPageGetsThePolicyBeforeAnythingOfTheAgents() {
        let page = RichPages.htmlPage("<!doctype html><html><head><meta http-equiv=\"Content-Security-Policy\" content=\"default-src *\"></head><body>x</body></html>")
        XCTAssertTrue(page.hasPrefix("<!doctype html><meta http-equiv=\"Content-Security-Policy\""))
        // A second, looser policy from the agent can only narrow it further.
        XCTAssertLessThan(page.range(of: "default-src 'none'")!.lowerBound, page.range(of: "default-src *")!.lowerBound)
        XCTAssertFalse(RichPages.policy.contains("script-src"), "scripts fall under default-src 'none'")
        XCTAssertTrue(RichPages.policy.contains("default-src 'none'"))
    }

    func testTheDiagramPageCarriesBothPalettesAndNoAgentText() {
        let page = RichPages.diagramPage
        XCTAssertTrue(page.contains(RichPalette.dark.fg))
        XCTAssertTrue(page.contains(RichPalette.light.fg))
        XCTAssertTrue(page.contains("Content-Security-Policy"))
        // Links and pictures off; the source only ever goes in as an argument.
        XCTAssertTrue(RichPages.drawScript.contains("links: false"))
        XCTAssertTrue(RichPages.drawScript.contains("images: false"))
        XCTAssertTrue(RichPages.drawScript.contains("textContent = ''"))
    }
}
