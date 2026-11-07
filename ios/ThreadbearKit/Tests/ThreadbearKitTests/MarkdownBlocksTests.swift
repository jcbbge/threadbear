import Foundation
import Testing
@testable import ThreadbearKit

@Suite struct MarkdownBlocksTests {
    @Test func aPictureOnItsOwnLineOrAmongWords() {
        #expect(MarkdownBlock.parse("![Back screws](/Users/m/guide/back.png)") == [.image(alt: "Back screws", src: "/Users/m/guide/back.png")])
        #expect(MarkdownBlock.parse("Before ![a](<~/a b.png> \"title\") after") == [
            .paragraph("Before"), .image(alt: "a", src: "~/a b.png"), .paragraph("after"),
        ])
    }

    @Test func aPictureInAListGoesUnderItsItem() {
        #expect(MarkdownBlock.parse("""
        - First ![a](/a.png)
        - ![b](/b.png)
        - Third

          ![c](/c.png)
        """) == [
            .listItem(text: "First", marker: "•", depth: 0, task: nil),
            .image(alt: "a", src: "/a.png"),
            .image(alt: "b", src: "/b.png"),
            .listItem(text: "Third", marker: "•", depth: 0, task: nil),
            .image(alt: "c", src: "/c.png"),
        ])
    }

    @Test func aPictureBeingTalkedAboutStaysWords() {
        let inSpan = "Write `![alt](/a.png)` like that"
        #expect(MarkdownBlock.parse(inSpan) == [.paragraph(inSpan)])
        #expect(MarkdownBlock.parse("```\n![alt](/a.png)\n```") == [.code("![alt](/a.png)")])
        #expect(MarkdownBlock.parse("A [link](/a.png) isn't one") == [.paragraph("A [link](/a.png) isn't one")])
    }

    @Test func mermaidAndHTMLFencesAreRichBlocks() {
        #expect(MarkdownBlock.parse("```mermaid\nflowchart TD\n  A --> B\n```") == [.rich(kind: .mermaid, source: "flowchart TD\n  A --> B")])
        #expect(MarkdownBlock.parse("~~~ HTML title=x\n<b>hi</b>\n~~~") == [.rich(kind: .html, source: "<b>hi</b>")])
        #expect(MarkdownBlock.parse("```Mermaid\npie\n```") == [.rich(kind: .mermaid, source: "pie")])
        // Anything else, or a word that only starts the same, stays code.
        #expect(MarkdownBlock.parse("```swift\nlet a = 1\n```") == [.code("let a = 1")])
        #expect(MarkdownBlock.parse("```htmlx\n<b>\n```") == [.code("<b>")])
        #expect(MarkdownBlock.parse("```\nmermaid\n```") == [.code("mermaid")])
    }

    @Test func slackEmailAndDraftFencesAreDrafts() {
        // Every line kept, blank ones too: none of it is joined up.
        #expect(MarkdownBlock.parse("Here it is:\n\n```slack\n*Update*\n• one\n• two\n\nThanks\n```\nSend it?") == [
            .paragraph("Here it is:"),
            .draft(DraftBlock(kind: .slack, source: "*Update*\n• one\n• two\n\nThanks")),
            .paragraph("Send it?"),
        ])
        #expect(MarkdownBlock.parse("~~~Email to=x\nHi,\nBye\n~~~") == [.draft(DraftBlock(kind: .email, source: "Hi,\nBye"))])
        #expect(MarkdownBlock.parse("```draft\nhi\n```") == [.draft(DraftBlock(kind: .draft, source: "hi"))])
        // Still streaming in, empty, or only starting the same: code.
        #expect(MarkdownBlock.parse("```slack\n*Update*\n• one") == [.code("*Update*\n• one")])
        #expect(MarkdownBlock.parse("```slack\n\n```") == [.code("")])
        #expect(MarkdownBlock.parse("```slackbot\nhi\n```") == [.code("hi")])
    }

    @Test func aDraftNeedsItsOwnClosingFence() {
        // Only a fence on its own closes it, at any indent.
        #expect(MarkdownBlock.parse("```slack\nhello\n> ```") == [.code("hello\n> ```")])
        #expect(MarkdownBlock.parse("```slack\nhello\n   ```") == [.draft(DraftBlock(kind: .slack, source: "hello"))])
        #expect(MarkdownBlock.parse("```slack\nhello\n    ```") == [.draft(DraftBlock(kind: .slack, source: "hello"))])
        #expect(MarkdownBlock.parse("```slack\nhello\n``` x") == [.code("hello\n``` x")])
        // A fence opening on a list item's own line: the block, in the item.
        #expect(MarkdownBlock.parse("- ```slack\n  hello\n  ```") == [.draft(DraftBlock(kind: .slack, source: "hello"))])
        #expect(MarkdownBlock.parse("- Run:\n1. ```sh\n   tb land\n   ```") == [
            .listItem(text: "Run:", marker: "•", depth: 0, task: nil), .code("tb land"),
        ])
        // A different fence character, or a shorter run, doesn't close it.
        #expect(MarkdownBlock.parse("```slack\nhello\n~~~") == [.code("hello\n~~~")])
        #expect(MarkdownBlock.parse("````slack\nhello\n```") == [.code("hello\n```")])
        #expect(MarkdownBlock.parse("````slack\nhello\n````") == [.draft(DraftBlock(kind: .slack, source: "hello"))])
        #expect(MarkdownBlock.parse("```slack\r\nhi\r\nthere\r\n```\r\n") == [.draft(DraftBlock(kind: .slack, source: "hi\nthere"))])
        #expect(MarkdownBlock.parse("> ```slack\n> hello\n> ```") == [.quote([.draft(DraftBlock(kind: .slack, source: "hello"))])])
        // Too big to be a message: code.
        let big = String(repeating: "a", count: DraftBlock.maxSource + 1)
        #expect(MarkdownBlock.parse("```slack\n\(big)\n```") == [.code(big)])
    }

    // Cross-lab review, round three (6 Nov).
    @Test func backticksAfterABacktickFenceMakeItWords() {
        #expect(MarkdownBlock.parse("- ```literal```\n- next") == [
            .listItem(text: "```literal```", marker: "•", depth: 0, task: nil),
            .listItem(text: "next", marker: "•", depth: 0, task: nil),
        ])
        #expect(MarkdownBlock.parse("```a``` b\nnext") == [.paragraph("```a``` b next")])
        // A tilde fence's info string may have backticks.
        #expect(MarkdownBlock.parse("~~~slack `x`\nhi\n~~~") == [.draft(DraftBlock(kind: .slack, source: "hi"))])
    }

    @Test func aClosingFenceClosesAtAnyIndent() {
        #expect(MarkdownBlock.parse("   ```slack\n   hello\n    ```") == [.draft(DraftBlock(kind: .slack, source: "hello"))])
        #expect(MarkdownBlock.parse("  ```slack\n  hello\n```") == [.draft(DraftBlock(kind: .slack, source: "hello"))])
        #expect(MarkdownBlock.parse("- ```slack\n  hello\n```") == [.draft(DraftBlock(kind: .slack, source: "hello"))])
        #expect(MarkdownBlock.parse("- ```slack\n  hello\n     ```") == [.draft(DraftBlock(kind: .slack, source: "hello"))])
        #expect(MarkdownBlock.parse("- Steps:\n\n  ```slack\n  hello\n  ```") == [
            .listItem(text: "Steps:", marker: "•", depth: 0, task: nil),
            .draft(DraftBlock(kind: .slack, source: "hello")),
        ])
        #expect(MarkdownBlock.parse("- a\n  - b\n\n    ```\n    code\n    ```") == [
            .listItem(text: "a", marker: "•", depth: 0, task: nil),
            .listItem(text: "b", marker: "•", depth: 1, task: nil),
            .code("code"),
        ])
        // Round four: a reply's words after the block stay words, under a
        // nested list or after a heading that ended one.
        #expect(MarkdownBlock.parse("- root\n  - middle\n    - child\n\n    ```swift\n    let x = 1\n    ```\n\nAfter.") == [
            .listItem(text: "root", marker: "•", depth: 0, task: nil),
            .listItem(text: "middle", marker: "•", depth: 1, task: nil),
            .listItem(text: "child", marker: "•", depth: 2, task: nil),
            .code("let x = 1"),
            .paragraph("After."),
        ])
        #expect(MarkdownBlock.parse("- item\n\n# Heading\n\n  ```swift\n  let x = 1\n```\n\nAfter.") == [
            .listItem(text: "item", marker: "•", depth: 0, task: nil),
            .heading(level: 1, text: "Heading"),
            .code("let x = 1"),
            .paragraph("After."),
        ])
    }

    @Test func aFencedItemKeepsTheListsDepths() {
        #expect(MarkdownBlock.parse("- ```sh\n  echo hi\n  ```\n  - child\n- sibling") == [
            .code("echo hi"),
            .listItem(text: "child", marker: "•", depth: 1, task: nil),
            .listItem(text: "sibling", marker: "•", depth: 0, task: nil),
        ])
    }

    @Test func ordinaryListsAndCodeAreAsBefore() {
        #expect(MarkdownBlock.parse("- one\n  - two\n- three") == [
            .listItem(text: "one", marker: "•", depth: 0, task: nil),
            .listItem(text: "two", marker: "•", depth: 1, task: nil),
            .listItem(text: "three", marker: "•", depth: 0, task: nil),
        ])
        #expect(MarkdownBlock.parse("```swift\nlet a = 1\n```\nafter") == [.code("let a = 1"), .paragraph("after")])
        #expect(MarkdownBlock.parse("````\n```\ninner\n```\n````") == [.code("```\ninner\n```")])
        #expect(MarkdownBlock.parse("Use `a` and ``b``") == [.paragraph("Use `a` and ``b``")])
    }

    @Test func aFenceStillStreamingInOrTooBigStaysCode() {
        // The reply so far, its fence not closed yet: drawn once it is.
        #expect(MarkdownBlock.parse("```mermaid\nflowchart TD\n  A -->") == [.code("flowchart TD\n  A -->")])
        let big = String(repeating: "a", count: MarkdownBlock.maxRichSource + 1)
        #expect(MarkdownBlock.parse("```html\n\(big)\n```") == [.code(big)])
        #expect(MarkdownBlock.parse("```mermaid\n\n```") == [.code("")])
    }

    @Test func aRichBlockInAListKeepsItsSource() {
        #expect(MarkdownBlock.parse("- Steps:\n\n  ```mermaid\n  flowchart LR\n    A --> B\n  ```") == [
            .listItem(text: "Steps:", marker: "•", depth: 0, task: nil),
            .rich(kind: .mermaid, source: "flowchart LR\n  A --> B"),
        ])
    }

    @Test func aPictureInAQuoteStaysInTheQuote() {
        #expect(MarkdownBlock.parse("> ![a](/a.png)") == [.quote([.image(alt: "a", src: "/a.png")])])
    }

    @Test func tablesBecomeRowsAndCells() {
        let blocks = MarkdownBlock.parse("""
        Here's the spread:

        | Option | Cost | Notes |
        |:--|:-:|--:|
        | **A** | $5 | fast \\| cheap |
        | B | $9 |
        """)
        #expect(blocks == [
            .paragraph("Here's the spread:"),
            .table(header: ["Option", "Cost", "Notes"], alignments: [.leading, .center, .trailing], rows: [
                ["**A**", "$5", "fast | cheap"],
                ["B", "$9", ""],
            ]),
        ])
    }

    @Test func aPipeInProseIsNotATable() {
        #expect(MarkdownBlock.parse("Use a | b here\nand carry on") == [.paragraph("Use a | b here and carry on")])
    }

    @Test func nestedListsKeepTheirDepth() {
        let blocks = MarkdownBlock.parse("""
        - one
          - one a
            - one a i
        - two
        1. first
        2) second
        + plus
        """)
        #expect(blocks == [
            .listItem(text: "one", marker: "•", depth: 0, task: nil),
            .listItem(text: "one a", marker: "•", depth: 1, task: nil),
            .listItem(text: "one a i", marker: "•", depth: 2, task: nil),
            .listItem(text: "two", marker: "•", depth: 0, task: nil),
            .listItem(text: "first", marker: "1.", depth: 0, task: nil),
            .listItem(text: "second", marker: "2.", depth: 0, task: nil),
            .listItem(text: "plus", marker: "•", depth: 0, task: nil),
        ])
    }

    @Test func aWrappedListItemStaysOneItem() {
        let blocks = MarkdownBlock.parse("""
        - **Tables** show up as raw
          pipes on the phone.
        - Quotes too.

          A second paragraph in it.

        After the list.
        """)
        #expect(blocks == [
            .listItem(text: "**Tables** show up as raw pipes on the phone.", marker: "•", depth: 0, task: nil),
            .listItem(text: "Quotes too.\n\nA second paragraph in it.", marker: "•", depth: 0, task: nil),
            .paragraph("After the list."),
        ])
    }

    @Test func taskListsHaveTheirBoxes() {
        #expect(MarkdownBlock.parse("- [ ] todo\n- [x] done") == [
            .listItem(text: "todo", marker: "•", depth: 0, task: false),
            .listItem(text: "done", marker: "•", depth: 0, task: true),
        ])
    }

    @Test func quotesRulesAndHeadings() {
        let blocks = MarkdownBlock.parse("""
        ## What I found ##
        > It's **broken**
        > - on the phone
        ---
        * * *
        Done
        """)
        #expect(blocks == [
            .heading(level: 2, text: "What I found"),
            .quote([.paragraph("It's **broken**"), .listItem(text: "on the phone", marker: "•", depth: 0, task: nil)]),
            .rule,
            .rule,
            .paragraph("Done"),
        ])
    }

    @Test func codeFencesKeepTheirInsides() {
        let blocks = MarkdownBlock.parse("""
        1. Run it:
           ```sh
           tb land
             --dry-run
           ```
        ~~~
        | not a table |
        |---|
        ~~~
        """)
        #expect(blocks == [
            .listItem(text: "Run it:", marker: "1.", depth: 0, task: nil),
            .code("tb land\n  --dry-run"),
            .code("| not a table |\n|---|"),
        ])
    }

    @Test func paragraphsJoinSoftBreaksAndKeepHardOnes() {
        #expect(MarkdownBlock.parse("one\ntwo  \nthree\\\nfour\n\nnext") == [
            .paragraph("one two\nthree\nfour"),
            .paragraph("next"),
        ])
    }

    @Test func anUnclosedFenceWhileStreamingIsStillCode() {
        #expect(MarkdownBlock.parse("Look:\n```\nlet a = 1") == [.paragraph("Look:"), .code("let a = 1")])
    }
}

@Suite struct ThreadPicturesTests {
    private let at = Date(timeIntervalSince1970: 0)
    private func reply(_ seq: Int) -> ThreadItem { .message(PhoneMessage(seq: seq, role: .assistant, text: "", at: at)) }

    @Test func aMessagesOwnPictureComesFirst() {
        let old = MessageImage(seq: 5, src: "/a.png", url: "https://x/old")
        let new = MessageImage(seq: 9, src: "/a.png", url: "https://x/new")
        let pictures = ThreadPictures([old, new, MessageImage(seq: 9, src: "/b.png", url: "https://x/b")])
        #expect(pictures.image(src: "/a.png", seq: 5) == old)
        #expect(pictures.image(src: "/a.png", seq: 9) == new)
        #expect(pictures.image(src: "/a.png", seq: 7) == old)
        #expect(pictures.image(src: "/a.png", seq: 1) == new)
        #expect(pictures.image(src: "/a.png", seq: nil) == new)
        #expect(pictures.image(src: "/missing.png", seq: 9) == nil)
    }

    @Test func onlyAWebPictureNeedsNoUpload() {
        #expect(ThreadPictures.webURL("https://x.io/a.png")?.host() == "x.io")
        #expect(ThreadPictures.webURL("/Users/m/a.png") == nil)
        #expect(ThreadPictures.webURL("http://x.io/a.png") == nil)
    }

    @Test func aPinGoesUnderTheNextReplyOnShow() {
        let first = MessageImage(seq: 3, pinned: true, url: "https://x/first")
        let second = MessageImage(seq: 8, pinned: true, url: "https://x/second")
        let notYet = MessageImage(seq: 20, pinned: true, url: "https://x/late")
        // A shared thread's tool picture is neither, and doesn't show.
        let tool = MessageImage(seq: 4, url: "https://x/tool")
        let items: [ThreadItem] = [
            .message(PhoneMessage(seq: 1, role: .user, text: "", at: at)),
            .tools([PhoneMessage(seq: 3, role: .tool, text: "", at: at)]),
            reply(5),
            .tools([PhoneMessage(seq: 8, role: .tool, text: "", at: at)]),
            reply(10),
        ]
        let placed = ThreadPictures([first, tool, second, notYet]).pinned(in: items)
        #expect(placed.under == [5: [first], 10: [second]])
        #expect(placed.trailing == [notYet])
    }

    @Test func aPageFromAnOlderBackendHasNoPictures() throws {
        let json = #"{"messages":[],"hasMore":false}"#
        #expect(try JSONDecoder().decode(MessagePage.self, from: Data(json.utf8)).images == [])
        let with = #"{"messages":[],"hasMore":false,"images":[{"seq":4,"src":"/a.png","url":"https://x/a","width":400,"height":300,"somethingNew":1}]}"#
        let image = try JSONDecoder().decode(MessagePage.self, from: Data(with.utf8)).images.first
        #expect(image == MessageImage(seq: 4, src: "/a.png", url: "https://x/a", width: 400, height: 300))
    }
}
