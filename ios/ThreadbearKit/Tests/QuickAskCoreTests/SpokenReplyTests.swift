import Foundation
import Testing
@testable import QuickAskCore

struct SpokenReplyTests {
    @Test func markdownMarksGo() {
        let text = "## Drives\n\nIt's **CannMedia**, the `8 TB` one.\n- one\n- two\n> quoted"
        #expect(SpokenReply.text(from: text) == "Drives. It's CannMedia, the 8 TB one. one. two. quoted.")
    }

    @Test func codeBlocksAreLeftOutAndSaidSo() {
        let text = "Run this:\n```\nnpm test\n```\nThen check."
        #expect(SpokenReply.text(from: text) == "Run this: There's some code on screen. Then check.")
    }

    @Test func linksSayTheirTextAndURLsTheirHost() {
        let text = "See [the plan](https://example.com/plan) or https://bruce.tail9ef766.ts.net:9443/?thread=x."
        #expect(SpokenReply.text(from: text) == "See the plan or bruce.tail9ef766.ts.net.")
    }

    @Test func longRepliesStopAtASentence() {
        let text = String(repeating: "This is a sentence. ", count: 200)
        let spoken = SpokenReply.text(from: text, limit: 100)
        #expect(spoken.count <= 140)
        #expect(spoken.hasSuffix("The rest is on screen."))
    }

    @Test func emptyStaysEmpty() {
        #expect(SpokenReply.text(from: "  \n ") == "")
    }

    @Test func manyOpenBracketsAreQuick() {
        // Each `[` was tried to the end of the line: 4.5 s for 8,000 of them.
        // This thread's CPU time: other tests run alongside.
        func now() -> Double { Double(clock_gettime_nsec_np(CLOCK_THREAD_CPUTIME_ID)) / 1e9 }
        let start = now()
        _ = SpokenReply.text(from: String(repeating: "[", count: 8_000), limit: 100_000)
        _ = SpokenReply.text(from: String(repeating: "[a](", count: 2_000), limit: 100_000)
        #expect(now() - start < 0.1)
        #expect(SpokenReply.text(from: "See [the docs](https://x.dev/a) and [b] [c](d") == "See the docs and [b] [c](d.")
    }
}

