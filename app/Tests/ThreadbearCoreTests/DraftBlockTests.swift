import XCTest
@testable import ThreadbearCore

/// ```slack, ```email and ```draft blocks: text for Mike to send elsewhere,
/// shown line for line with a Copy button. The phone's DraftBlockTests and the
/// website's draft.test.ts check the same cases.
final class DraftBlockTests: XCTestCase {
    func testOnlyTheDraftFencesCount() {
        XCTAssertEqual(DraftBlock.from(language: "slack", code: "hi\n")?.kind, .slack)
        XCTAssertEqual(DraftBlock.from(language: "Email subject=x", code: "hi")?.kind, .email)
        XCTAssertEqual(DraftBlock.from(language: "draft", code: "hi")?.kind, .draft)
        XCTAssertNil(DraftBlock.from(language: "slackbot", code: "hi"))
        XCTAssertNil(DraftBlock.from(language: nil, code: "hi"))
        XCTAssertNil(DraftBlock.from(language: "slack", code: " \n\n"))
        XCTAssertEqual(DraftBlock.from(language: "slack", code: "a\r\nb\n\n")?.source, "a\nb")
        XCTAssertEqual(DraftBlock(kind: .slack, source: "x").label, "Slack draft")
        XCTAssertEqual(DraftBlock(kind: .draft, source: "x").label, "Draft")
    }

    func testEveryLineStaysALine() {
        let draft = DraftBlock(kind: .draft, source: "*Threadbear, 6 Nov*\n• one\n• two\n\nThanks")
        XCTAssertEqual(draft.lines.map { $0.spans.map(\.text).joined() }, ["*Threadbear, 6 Nov*", "• one", "• two", "", "Thanks"])
        // Only a Slack draft reads Slack's formatting.
        XCTAssertFalse(draft.lines[0].spans[0].bold)
        XCTAssertEqual(draft.plainText, draft.source)
    }

    func testSlackFormatting() {
        let spans = DraftBlock.slackSpans("*Shipped* _today_: ~old~ `tb land` and *_both_*")
        XCTAssertEqual(spans, [
            .init("Shipped", bold: true), .init(" "), .init("today", italic: true), .init(": "),
            .init("old", strike: true), .init(" "), .init("tb land", code: true), .init(" and "),
            .init("both", bold: true, italic: true),
        ])
    }

    func testMarkersInsideWordsAndLoneOnesStayAsWritten() {
        for text in ["2*3*4", "snake_case_name", "a * b * c", "*open only", "price: $5_000_"] {
            XCTAssertEqual(DraftBlock.slackSpans(text), [.init(text)], text)
        }
        // Markdown's **bold** is Slack's *bold* with a star either side,
        // which is how Slack shows it too.
        XCTAssertEqual(DraftBlock.slackSpans("**x**"), [.init("*"), .init("x", bold: true), .init("*")])
    }

    func testLinksAndMentions() throws {
        let spans = DraftBlock.slackSpans("See <https://example.com/a?b=1|the docs>, <https://x.dev> or <mailto:m@x.dev>; cc <@U123> in <#C9|general> <!here> & 1 < 2 &amp; <b>")
        let links = spans.compactMap(\.link).map(\.absoluteString)
        XCTAssertEqual(links, ["https://example.com/a?b=1", "https://x.dev", "mailto:m@x.dev"])
        XCTAssertEqual(spans.map(\.text).joined(), "See the docs, https://x.dev or m@x.dev; cc @U123 in #general @here & 1 < 2 & <b>")
        // Other schemes aren't links.
        XCTAssertNil(DraftBlock.slackSpans("<javascript:alert(1)|x>").first?.link)
        XCTAssertEqual(DraftBlock.slackSpans("<javascript:alert(1)|x>").map(\.text).joined(), "<javascript:alert(1)|x>")
    }

    func testCopyKeepsSlacksMarkersButSpellsOutLinks() {
        let draft = DraftBlock(kind: .slack, source: "*Done* <https://x.dev/pr/1|the PR>\n<https://x.dev>\n> quoted &lt;tag&gt;")
        XCTAssertEqual(draft.plainText, "*Done* the PR (https://x.dev/pr/1)\nhttps://x.dev\n> quoted <tag>")
        XCTAssertEqual(draft.html, "<meta charset=\"utf-8\"><div><b>Done</b> <a href=\"https://x.dev/pr/1\">the PR</a><br><a href=\"https://x.dev\">https://x.dev</a><blockquote>quoted &lt;tag&gt;</blockquote></div>")
        XCTAssertTrue(draft.lines[2].quote)
    }

    func testHTMLIsEscaped() {
        let draft = DraftBlock(kind: .email, source: "Hi <script>alert(\"x\")</script> & bye")
        XCTAssertEqual(draft.html, "<meta charset=\"utf-8\"><div>Hi &lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; bye</div>")
    }

    // Cross-lab review, 6 Nov.
    func testTokensInsideCodeStayAsWrittenAndALinkCanBeBold() {
        XCTAssertEqual(DraftBlock.slackSpans("`<@U123>` and `a < b`"), [.init("<@U123>", code: true), .init(" and "), .init("a < b", code: true)])
        let url = URL(string: "https://x.dev")!
        XCTAssertEqual(DraftBlock.slackSpans("*See <https://x.dev|docs>*"), [.init("See ", bold: true), .init("docs", bold: true, link: url)])
        XCTAssertEqual(DraftBlock.slackSpans("<https://x.dev|a>_b_"), [.init("a", link: url), .init("b", italic: true)])
        // Copied as plain text, code keeps its tokens as typed too.
        XCTAssertEqual(DraftBlock(kind: .slack, source: "`<@U1>` <@U1> `<https://x.dev|docs>` <https://x.dev|docs>").plainText,
                       "`<@U1>` @U1 `<https://x.dev|docs>` docs (https://x.dev)")
    }

    func testHostileLinesStayQuick() {
        let start = Date()
        _ = DraftBlock.slackSpans(String(repeating: "<", count: DraftBlock.maxFormattedLine))
        _ = DraftBlock.slackSpans(String(repeating: " *a", count: DraftBlock.maxFormattedLine / 3))
        _ = DraftBlock(kind: .slack, source: String(repeating: "<", count: DraftBlock.maxSource)).plainText
        _ = DraftBlock(kind: .slack, source: String(repeating: "<", count: DraftBlock.maxSource - 1) + ">").plainText
        XCTAssertLessThan(Date().timeIntervalSince(start), 2)
        // A line past the limit is shown as written; a draft past its limit stays code.
        let long = "*" + String(repeating: "a", count: DraftBlock.maxFormattedLine) + "*"
        XCTAssertEqual(DraftBlock.slackSpans(long), [.init(long)])
        XCTAssertNil(DraftBlock.from(language: "slack", code: String(repeating: "a", count: DraftBlock.maxSource + 1)))
        // A placeholder character in the text itself turns formatting off for the line.
        XCTAssertEqual(DraftBlock.slackSpans("*a* \u{E000}"), [.init("*a* \u{E000}")])
    }

    func testCopiedHTMLKeepsIndentsAndLinedUpSpaces() {
        let draft = DraftBlock(kind: .email, source: "    • nested\nA    B")
        XCTAssertEqual(draft.html, "<meta charset=\"utf-8\"><div>&nbsp;&nbsp;&nbsp;&nbsp;• nested<br>A &nbsp;&nbsp;&nbsp;B</div>")
    }
}
