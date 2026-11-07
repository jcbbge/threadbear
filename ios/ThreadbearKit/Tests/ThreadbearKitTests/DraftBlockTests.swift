import Foundation
import Testing
@testable import ThreadbearKit

/// ```slack, ```email and ```draft blocks: text for Mike to send elsewhere,
/// shown line for line with a Copy button. The Mac's DraftBlockTests
/// (app/Tests/ThreadbearCoreTests) and the website's draft.test.ts check the
/// same cases.
@Suite struct DraftBlockTests {
    @Test func onlyTheDraftFencesCount() {
        #expect(DraftBlock.from(language: "slack", code: "hi\n")?.kind == .slack)
        #expect(DraftBlock.from(language: "Email subject=x", code: "hi")?.kind == .email)
        #expect(DraftBlock.from(language: "draft", code: "hi")?.kind == .draft)
        #expect(DraftBlock.from(language: "slackbot", code: "hi") == nil)
        #expect(DraftBlock.from(language: nil, code: "hi") == nil)
        #expect(DraftBlock.from(language: "slack", code: " \n\n") == nil)
        #expect(DraftBlock.from(language: "slack", code: "a\r\nb\n\n")?.source == "a\nb")
        #expect(DraftBlock(kind: .slack, source: "x").label == "Slack draft")
        #expect(DraftBlock(kind: .email, source: "x").label == "Email draft")
        #expect(DraftBlock(kind: .draft, source: "x").label == "Draft")
    }

    @Test func everyLineStaysALine() {
        let draft = DraftBlock(kind: .draft, source: "*Threadbear, 6 Nov*\n• one\n• two\n\nThanks")
        #expect(draft.lines.map { $0.spans.map(\.text).joined() } == ["*Threadbear, 6 Nov*", "• one", "• two", "", "Thanks"])
        // Only a Slack draft reads Slack's formatting.
        #expect(!draft.lines[0].spans[0].bold)
        #expect(draft.plainText == draft.source)
    }

    @Test func slackFormatting() {
        let spans = DraftBlock.slackSpans("*Shipped* _today_: ~old~ `tb land` and *_both_*")
        #expect(spans == [
            .init("Shipped", bold: true), .init(" "), .init("today", italic: true), .init(": "),
            .init("old", strike: true), .init(" "), .init("tb land", code: true), .init(" and "),
            .init("both", bold: true, italic: true),
        ])
    }

    @Test(arguments: ["2*3*4", "snake_case_name", "a * b * c", "*open only", "price: $5_000_"])
    func markersInsideWordsAndLoneOnesStayAsWritten(text: String) {
        #expect(DraftBlock.slackSpans(text) == [.init(text)])
    }

    @Test func markdownBoldIsSlackBoldWithAStarEitherSide() {
        // Markdown's **bold** is Slack's *bold* with a star either side,
        // which is how Slack shows it too.
        #expect(DraftBlock.slackSpans("**x**") == [.init("*"), .init("x", bold: true), .init("*")])
    }

    @Test func linksAndMentions() {
        let spans = DraftBlock.slackSpans("See <https://example.com/a?b=1|the docs>, <https://x.dev> or <mailto:m@x.dev>; cc <@U123> in <#C9|general> <!here> & 1 < 2 &amp; <b>")
        let links = spans.compactMap(\.link).map(\.absoluteString)
        #expect(links == ["https://example.com/a?b=1", "https://x.dev", "mailto:m@x.dev"])
        #expect(spans.map(\.text).joined() == "See the docs, https://x.dev or m@x.dev; cc @U123 in #general @here & 1 < 2 & <b>")
        // Other schemes aren't links.
        #expect(DraftBlock.slackSpans("<javascript:alert(1)|x>").first?.link == nil)
        #expect(DraftBlock.slackSpans("<javascript:alert(1)|x>").map(\.text).joined() == "<javascript:alert(1)|x>")
    }

    @Test func copyKeepsSlacksMarkersButSpellsOutLinks() {
        let draft = DraftBlock(kind: .slack, source: "*Done* <https://x.dev/pr/1|the PR>\n<https://x.dev>\n> quoted &lt;tag&gt;")
        #expect(draft.plainText == "*Done* the PR (https://x.dev/pr/1)\nhttps://x.dev\n> quoted <tag>")
        #expect(draft.html == "<meta charset=\"utf-8\"><div><b>Done</b> <a href=\"https://x.dev/pr/1\">the PR</a><br><a href=\"https://x.dev\">https://x.dev</a><blockquote>quoted &lt;tag&gt;</blockquote></div>")
        #expect(draft.lines[2].quote)
    }

    @Test func htmlIsEscaped() {
        let draft = DraftBlock(kind: .email, source: "Hi <script>alert(\"x\")</script> & bye")
        #expect(draft.html == "<meta charset=\"utf-8\"><div>Hi &lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; bye</div>")
    }

    // Cross-lab review, 6 Nov.
    @Test func tokensInsideCodeStayAsWrittenAndALinkCanBeBold() {
        #expect(DraftBlock.slackSpans("`<@U123>` and `a < b`") == [.init("<@U123>", code: true), .init(" and "), .init("a < b", code: true)])
        let url = URL(string: "https://x.dev")!
        #expect(DraftBlock.slackSpans("*See <https://x.dev|docs>*") == [.init("See ", bold: true), .init("docs", bold: true, link: url)])
        #expect(DraftBlock.slackSpans("<https://x.dev|a>_b_") == [.init("a", link: url), .init("b", italic: true)])
        // Copied as plain text, code keeps its tokens as typed too.
        #expect(DraftBlock(kind: .slack, source: "`<@U1>` <@U1> `<https://x.dev|docs>` <https://x.dev|docs>").plainText
            == "`<@U1>` @U1 `<https://x.dev|docs>` docs (https://x.dev)")
    }

    @Test func hostileLinesStayQuick() {
        let start = Date()
        _ = DraftBlock.slackSpans(String(repeating: "<", count: DraftBlock.maxFormattedLine))
        _ = DraftBlock.slackSpans(String(repeating: " *a", count: DraftBlock.maxFormattedLine / 3))
        _ = DraftBlock(kind: .slack, source: String(repeating: "<", count: DraftBlock.maxSource)).plainText
        _ = DraftBlock(kind: .slack, source: String(repeating: "<", count: DraftBlock.maxSource - 1) + ">").plainText
        #expect(Date().timeIntervalSince(start) < 2)
        // A line past the limit is shown as written; a draft past its limit stays code.
        let long = "*" + String(repeating: "a", count: DraftBlock.maxFormattedLine) + "*"
        #expect(DraftBlock.slackSpans(long) == [.init(long)])
        #expect(DraftBlock.from(language: "slack", code: String(repeating: "a", count: DraftBlock.maxSource + 1)) == nil)
        // A placeholder character in the text itself turns formatting off for the line.
        #expect(DraftBlock.slackSpans("*a* \u{E000}") == [.init("*a* \u{E000}")])
    }

    @Test func copiedHTMLKeepsIndentsAndLinedUpSpaces() {
        let draft = DraftBlock(kind: .email, source: "    • nested\nA    B")
        #expect(draft.html == "<meta charset=\"utf-8\"><div>&nbsp;&nbsp;&nbsp;&nbsp;• nested<br>A &nbsp;&nbsp;&nbsp;B</div>")
    }
}
