import AppKit
import XCTest
@testable import Threadbear

/// Deeply nested quotes, lists, emphasis and pictures never run the
/// transcript's worker threads out of stack (MarkdownRenderer.maxNesting
/// and maxInlineMarks; Daybreak, 7 Nov 2026, and the cross-lab review).
final class MarkdownNestingRenderTests: XCTestCase {
    /// Renders on a thread with a worker's 512 KB stack, as
    /// `concurrentPerform` in RowRenderer does.
    private func renderOnSmallStack(_ text: String) -> NSAttributedString? {
        let done = DispatchSemaphore(value: 0)
        nonisolated(unsafe) var result: NSAttributedString?
        let thread = Thread {
            result = MarkdownRenderer.render(text).string
            done.signal()
        }
        thread.stackSize = 512 * 1024
        thread.start()
        return done.wait(timeout: .now() + 30) == .success ? result : nil
    }

    func testDeepBlocksAreWords() throws {
        let cases: [(String, String)] = [
            (String(repeating: ">", count: 7_999) + "x", ">>>>"),
            (String(repeating: "- ", count: 4_000) + "x", "- - -"),
            ((0..<1_000).map { String(repeating: "  ", count: $0) + "- x" }.joined(separator: "\n"), "- x"),
            // Empty items, one a line, each indented more.
            ((0..<1_000).map { String(repeating: "  ", count: $0) + "-" }.joined(separator: "\n") + "\n" + String(repeating: "  ", count: 1_000) + "x", "-"),
            ((0..<1_000).map { String(repeating: "  ", count: $0) + "-" }.joined(separator: "\r") + "\r" + String(repeating: "  ", count: 1_000) + "x", "-"),
            (String(repeating: "> - 1. ", count: 1_000) + "x", "> - 1."),
            (String(repeating: "*a ", count: 3_000) + String(repeating: "a* ", count: 3_000) + "x", "*a"),
            // A table padded to 1.6 million cells.
            (String(repeating: "x|", count: 800) + "\n" + String(repeating: "-|", count: 800) + "\n" + String(repeating: "x|\n", count: 2_000), "-|-|"),
            // Escaping work: links decodes %2A into `*` before the parser
            // sees it, so the marks are counted after (cross-lab review).
            ("](work:" + String(repeating: "%2Aa/", count: 2_500) + String(repeating: "a%2A/", count: 2_500) + ")", "%2Aa/"),
        ]
        for (text, literal) in cases {
            let start = clock()
            let rendered = try XCTUnwrap(renderOnSmallStack(text), "\(text.prefix(20))")
            XCTAssertLessThan(Double(clock() - start) / Double(CLOCKS_PER_SEC), 2)
            XCTAssertTrue(rendered.string.contains(literal), "drawn as words: \(text.prefix(20))")
        }
    }

    func testDeepInlinesUnderTheLimitStillDraw() throws {
        // Under maxInlineMarks: parsed on a thread with room for each level.
        for text in [String(repeating: "![", count: 3_000) + "x" + String(repeating: "](u)", count: 3_000),
                     String(repeating: "*a ", count: 1_500) + String(repeating: "a* ", count: 1_500) + "x",
                     String(repeating: "[", count: 3_900) + "x" + String(repeating: "](u)", count: 3_900)] {
            XCTAssertNotNil(renderOnSmallStack(text), "\(text.prefix(20))")
        }
    }

    func testOrdinaryNestingIsStillMarkdown() throws {
        let rendered = try XCTUnwrap(renderOnSmallStack("> a\n> - b\n>   - c\n\nSome **bold** and *it* [link](https://x.dev)."))
        XCTAssertFalse(rendered.string.contains(">"))
        XCTAssertFalse(rendered.string.contains("**"))
        XCTAssertTrue(rendered.string.contains("•"))
    }
}
