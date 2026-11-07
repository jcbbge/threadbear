import Foundation
import Testing
@testable import ThreadbearKit

struct CardMentionsTests {
    @Test func onlyNotionLinksAreCards() {
        let text = "Look at [Fix \\[the\\] button](https://app.notion.com/p/abc123) and [Docs](https://example.com/x)"
        let found = CardMentions.find(in: text)
        #expect(found.map(\.title) == ["Fix [the] button"])
        #expect(found.first?.url == "https://app.notion.com/p/abc123")
        #expect(CardMentions.find(in: "![a picture](https://www.notion.so/t3)").isEmpty)
        #expect(CardMentions.find(in: "[c](https://notion.so.evil.com/t3) [d](http://www.notion.so/t3)").isEmpty)
    }

    @Test func threadLinksAreChipsToo() {
        let found = CardMentions.find(in: "See [Fix the chip](thread:0cf430ac-f429) and [x](thread:a b)")
        #expect(found.map(\.title) == ["Fix the chip"])
        #expect(found.first?.isThread == true)
    }

    @Test func aPastedThreadIdGoesInAsALink() {
        let known: Set = ["0cf430ac-f429-4b1e-9d8a-1c2b3d4e5f60"]
        let id = "0cf430ac-f429-4b1e-9d8a-1c2b3d4e5f60"
        #expect(CardMentions.pastedThreadId("  \(id)\n", known: known.contains) == id)
        #expect(CardMentions.pastedThreadId("thread:\(id)", known: known.contains) == id)
        #expect(CardMentions.pastedThreadId(id.uppercased(), known: known.contains) == id)
        // Not one of his threads, or not only an id: the words as they are.
        #expect(CardMentions.pastedThreadId("11111111-2222-3333-4444-555555555555", known: known.contains) == nil)
        #expect(CardMentions.pastedThreadId("see \(id)", known: known.contains) == nil)
        let link = CardMentions.threadReference(id: id, title: "Fix [the] chip")
        #expect(link == "[Fix \\[the\\] chip](thread:\(id))")
        #expect(CardMentions.find(in: link).first?.title == "Fix [the] chip")
        #expect(CardMentions.threadReference(id: id, title: "") == "[Thread](thread:\(id))")
    }
}
