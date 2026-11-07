import Compression
import CoreGraphics
import Foundation
import ImageIO
import Testing
@testable import ThreadbearKit

/// What a runner writes or a model says reaches the phone through Convex,
/// and a pasted picture comes from anywhere: none of it may trap, run out
/// of stack or take seconds. Daybreak's findings of 7 Nov 2026, each played
/// here.
// One at a time: several of these are heavy on purpose and don't suspend, and
// all together they held every pool thread, so the other suites' short
// sleeps and fake turns ran late and their tests failed.
@Suite(.serialized) struct UntrustedValuesTests {
    /// CPU time, as the Mac running these is often busy.
    private func cpuSeconds(_ work: () -> Void) -> Double {
        // This thread's own time: Swift Testing runs other tests alongside,
        // and clock() would count theirs too.
        func now() -> Double { Double(clock_gettime_nsec_np(CLOCK_THREAD_CPUTIME_ID)) / 1e9 }
        let start = now()
        work()
        return now() - start
    }

    private func decode<T: Decodable>(_ type: T.Type, _ json: String) throws -> T {
        try JSONDecoder().decode(type, from: Data(json.utf8))
    }

    // MARK: Quotes in Markdown

    private func quoteDepth(_ blocks: [MarkdownBlock]) -> Int {
        var depth = 0
        var level = blocks
        while case let .quote(inner)? = level.first(where: { if case .quote = $0 { true } else { false } }) {
            depth += 1
            level = inner
        }
        return depth
    }

    @Test func aLineOfQuoteMarksIsQuickAndShallow() {
        // Daybreak's: 7,999 `>` then x, 8.2 s to parse and a stack overflow.
        let text = String(repeating: ">", count: 7_999) + "x"
        var blocks: [MarkdownBlock] = []
        let seconds = cpuSeconds { blocks = MarkdownBlock.parse(text) }
        #expect(seconds < 0.1, "\(seconds) s")
        #expect(quoteDepth(blocks) == MarkdownBlock.maxQuoteDepth)
        // What's past the deepest quote is words, marks and all.
        var level = blocks
        for _ in 0..<MarkdownBlock.maxQuoteDepth { if case let .quote(inner)? = level.first { level = inner } }
        #expect(level == [.paragraph(String(repeating: ">", count: 7_999 - MarkdownBlock.maxQuoteDepth) + "x")])
    }

    @Test func quotesNestedOverManyLinesStayShallow() {
        let text = (1...150).map { String(repeating: "> ", count: $0) + "line \($0)" }.joined(separator: "\n")
        var blocks: [MarkdownBlock] = []
        let seconds = cpuSeconds { blocks = MarkdownBlock.parse(text) }
        #expect(seconds < 0.1, "\(seconds) s")
        #expect(quoteDepth(blocks) <= MarkdownBlock.maxQuoteDepth)
        // An ordinary nested quote is still one.
        #expect(MarkdownBlock.parse("> a\n>> b") == [.quote([.paragraph("a"), .quote([.paragraph("b")])])])
    }

    // MARK: Other regexes over a reply

    @Test func headingsPicturesLinksAndAsksAreLinear() throws {
        let long = 8_000
        let inputs: [() -> Void] = [
            { _ = MarkdownBlock.parse("# a" + String(repeating: " ", count: long) + "b") },
            { _ = MarkdownBlock.parse(String(repeating: "![](<", count: long / 5)) },
            { _ = MarkdownBlock.parse(String(repeating: "![", count: long / 2)) },
            { _ = MarkdownBlock.parse(String(repeating: "![](x", count: long / 5)) },
            { _ = PhoneAsk(action: String(repeating: " ", count: long) + "x").paragraph },
            { _ = ReviewAnswer.parse("Review: T (00000000-0000-0000-0000-000000000000)\n\nPicked " + String(repeating: ". ", count: long / 2) + "\nx") },
            { _ = ReviewAnswer.parse("Review: T (00000000-0000-0000-0000-000000000000)\n\nNotes on " + String(repeating: " (", count: long / 2)) },
            { _ = ThreadLinks.find(quote: "npm test", from: nil, in: [.message(PhoneMessage(seq: 1, role: .assistant, text: String(repeating: "](work:", count: long / 7), at: Date()))]) },
        ]
        for (n, run) in inputs.enumerated() {
            let seconds = cpuSeconds(run)
            #expect(seconds < 0.1, "input \(n): \(seconds) s")
        }
        // One list item of many lines, as a long ask's why could be: grows
        // with the text, not its square (copying it all for every line).
        func item(_ lines: Int) -> Double { cpuSeconds { _ = MarkdownBlock.parse("- x\n" + String(repeating: "x\n", count: lines)) } }
        let small = item(10_000), big = item(40_000)
        #expect(big < small * 8 + 0.05, "\(small) s, then \(big) s")
        // What they found before, they still find.
        #expect(MarkdownBlock.parse("## Title ##") == [.heading(level: 2, text: "Title")])
        #expect(MarkdownBlock.parse("## Title#") == [.heading(level: 2, text: "Title#")])
        #expect(MarkdownBlock.parse("# C# \t ###") == [.heading(level: 1, text: "C#")])
        #expect(MarkdownBlock.parse("# ##") == [.heading(level: 1, text: "##")])
        #expect(PhoneAsk(action: "Merge\n  it\r\n now ").paragraph == "Merge it now")
        let review = try #require(ReviewAnswer.parse("Review: T (00000000-0000-0000-0000-000000000000)\n\nPicked B. Calm, as it reads quickest.\n\nNotes on A (Loud): too much. Really (yes)."))
        #expect(review.lines.map(\.text) == ["Picked B: Calm, as it reads quickest", "too much. Really (yes)."])
        #expect(review.lines.last?.label == "Notes on A: Loud")
    }

    @Test func tablesHaveACellBudget() {
        func cells(_ blocks: [MarkdownBlock]) -> Int {
            blocks.reduce(0) { sum, block in
                switch block {
                case let .table(header, _, rows): sum + header.count * (rows.count + 1)
                case let .quote(inner): sum + cells(inner)
                default: sum
                }
            }
        }
        // 9 KB asking for 1.6 million cells.
        let wide = String(repeating: "x|", count: 800) + "\n" + String(repeating: "-|", count: 800) + "\n" + String(repeating: "x|\n", count: 2_000)
        #expect(cells(MarkdownBlock.parse(wide)) <= MarkdownBlock.maxTableCells)
        // Many small tables, in quotes or not, share it.
        let one = String(repeating: "x|", count: 45) + "\n" + String(repeating: "-|", count: 45) + "\n" + String(repeating: "x|\n", count: 44) + "\n"
        #expect(cells(MarkdownBlock.parse(String(repeating: one, count: 29))) <= MarkdownBlock.maxTableCells)
        #expect(cells(MarkdownBlock.parse(String(repeating: one.split(separator: "\n").map { "> " + $0 }.joined(separator: "\n") + "\n\n", count: 29))) <= MarkdownBlock.maxTableCells)
        // A real one is all there.
        let real = "| a | b |\n|---|---|\n| 1 | 2 |\n| 3 |"
        #expect(MarkdownBlock.parse(real) == [.table(header: ["a", "b"], alignments: [.leading, .leading], rows: [["1", "2"], ["3", ""]])])
    }

    @Test func codeSpansAreAskedAboutOnce() {
        let inputs: [() -> Void] = [
            { _ = MarkdownBlock.parse(String(repeating: "`x` ![](x) ", count: 2_400)) },
            { _ = ThreadLinks.escapeDestinations(String(repeating: "`x` [a](work:x) ", count: 2_000)) },
        ]
        for run in inputs {
            let seconds = cpuSeconds(run)
            #expect(seconds < 0.1, "\(seconds) s")
        }
        // A picture or link in a code span is still left as written.
        #expect(MarkdownBlock.parse("`![a](b.png)` ![c](d.png)") == [.paragraph("`![a](b.png)`"), .image(alt: "c", src: "d.png")])
        #expect(ThreadLinks.escapeDestinations("`[a](work:x y)` [b](work:x y)") == "`[a](work:x y)` [b](work:x%20y)")
    }

    @Test func previewTextIsLinearAndUnchanged() {
        let seconds = cpuSeconds { _ = PreviewText.plain(String(repeating: "[", count: 32_000)) }
        #expect(seconds < 0.1, "\(seconds) s")
        // The regex it replaced, to check against.
        func old(_ text: String) -> String {
            text.replacingOccurrences(of: #"!?\[([^\]]*)\]\([^)]*\)"#, with: "$1", options: .regularExpression)
        }
        func new(_ text: String) -> String {
            text.replacing(/!?\[([^\]]*)(?:\]\([^)]*(\))?)?/) { $0.2 == nil ? String($0.0) : String($0.1) }
        }
        #expect(PreviewText.plain("See [the docs](https://x) and ![a](b.png) [c] [d](e") == "See the docs and a [c] [d](e")
        let pieces = ["[", "]", "(", ")", "!", "a", " ", "\n", "](", "x)"]
        var generator = SeededGenerator(seed: 5)
        for _ in 0..<5_000 {
            let text = (0..<Int.random(in: 1...12, using: &generator)).map { _ in pieces.randomElement(using: &generator)! }.joined()
            #expect(new(text) == old(text), "\(text.debugDescription)")
            if new(text) != old(text) { break }
        }
    }

    // MARK: Card mentions

    @Test func cardMentionsAreLinearOnBracketsWithNoLink() {
        let inputs = [String(repeating: "[", count: 32_000) + "notion.",
                      String(repeating: "[a\\", count: 11_000) + "notion.",
                      String(repeating: "[a](https://x.notion.so/", count: 1_400),
                      String(repeating: "[a](thread:", count: 3_000) + "](thread:"]
        for input in inputs {
            let seconds = cpuSeconds { _ = CardMentions.find(in: input) }
            #expect(seconds < 0.1, "\(seconds) s for \(input.prefix(24))")
        }
    }

    @Test func cardMentionsFindWhatTheRegexFound() {
        let regex = try! NSRegularExpression(pattern: #"(?<!!)\[((?:[^\]\\\n]|\\.)+)\]\((https://(?:[A-Za-z0-9-]+\.)*notion\.(?:so|site|com)/[^\s)]*|thread:[A-Za-z0-9_-]+)\)"#)
        func old(_ text: String) -> [String] {
            let ns = text as NSString
            return regex.matches(in: text, range: NSRange(location: 0, length: ns.length)).map { m in
                let title = ns.substring(with: m.range(at: 1)).replacingOccurrences(of: "\\[", with: "[").replacingOccurrences(of: "\\]", with: "]")
                return "\(m.range)|\(title)|\(ns.substring(with: m.range(at: 2)))"
            }
        }
        func new(_ text: String) -> [String] { CardMentions.find(in: text).map { "\($0.range)|\($0.title)|\($0.url)" } }
        let pieces = ["[", "]", "(", ")", "\\", "!", "\n", "\r", " ", "a", "-", "_", ".", "/", "https://", "notion.so", "notion.site", "x.notion.com",
                      "thread:", "](", "](thread:", "](https://", "](https://www.notion.so/", "\u{0B}", "\u{85}", "\u{A0}", "\u{2028}", "\u{1F600}", "notion."]
        var generator = SeededGenerator(seed: 11)
        for _ in 0..<5_000 {
            let text = "notion." + (0..<Int.random(in: 1...12, using: &generator)).map { _ in pieces.randomElement(using: &generator)! }.joined()
            let a = old(text), b = new(text)
            #expect(a == b, "\(text.debugDescription)")
            if a != b { break }
        }
    }

    // MARK: Numbers in Convex rows

    @Test func numbersInRowsNeverTrap() throws {
        // A date of 1e300 ms is held to the last one JavaScript has.
        let thread = try decode(PhoneThread.self, #"{"threadId":"t","runnerId":"r","title":"T","cwd":"/w","accountId":"a","provider":"claude","status":"running","needsYou":false,"unread":false,"preview":"p","lastActivityAt":1e300,"view":"inbox","earliestSeq":1e300,"asks":[{"action":"Pick","options":["a","b"],"suggested":1e100}]}"#)
        #expect(thread.lastActivityAt == Date(timeIntervalSince1970: 8.64e12))
        #expect(!RelativeTime.short(thread.lastActivityAt, now: Date()).isEmpty)
        #expect(!RowStatus.workingLabel(since: thread.lastActivityAt, now: Date(timeIntervalSince1970: -8.64e12)).isEmpty)
        #expect(thread.asks?.first?.suggestedIndex == nil)
        #expect(thread.hasEarlier(than: 5) == false)
        // A message's seq that isn't a whole number is refused, not Int(_:).
        #expect(throws: DecodingError.self) { try decode(PhoneMessage.self, #"{"seq":1e100,"role":"assistant","text":"x","at":0}"#) }
        #expect(try decode(PhoneMessage.self, #"{"seq":12.0,"role":"assistant","text":"x","at":0}"#).seq == 12)
        #expect(try decode(PhoneCounts.self, #"{"hibernating":1e100,"den":-1}"#) == PhoneCounts(hibernating: 0, den: 0))
        #expect(WorkedTurn(items: [], duration: 1e300).title.hasPrefix("Worked for"))
        #expect(!TurnGap.later(1e300).isEmpty)
        #expect(Int(checked: 1e100) == nil && Int(saturating: 1e100) == .max && Int(saturating: .nan) == 0)
    }

    // MARK: Pasted pictures

    @Test func aHugePictureIsRefusedBeforeItsDecoded() throws {
        // 10,240 px square: 140 KB of PNG, 105 MB of pixels.
        let png = blankPNG(side: 10_240)
        #expect(png.count < 1_000_000)
        #expect(!PhotoPrep.fits(png))
        var prepared: PhotoPrep.Prepared?
        let seconds = cpuSeconds { prepared = PhotoPrep.prepared(from: png) }
        #expect(prepared == nil)
        #expect(seconds < 0.1, "\(seconds) s")
        // Too many bytes is refused without looking inside.
        #expect(!PhotoPrep.fits(Data(count: PhotoPrep.maxSourceBytes + 1)))
        // A camera-sized one still fits.
        #expect(PhotoPrep.fits(blankPNG(side: 2_000)))
    }
}

/// A grey PNG of `side` x `side` zero pixels, made without holding them:
/// the rows are deflated one at a time.
private func blankPNG(side: Int) -> Data {
    func be32(_ v: UInt32) -> [UInt8] { [UInt8(v >> 24), UInt8(v >> 16 & 0xFF), UInt8(v >> 8 & 0xFF), UInt8(v & 0xFF)] }
    func chunk(_ type: String, _ body: [UInt8]) -> [UInt8] {
        let typed = Array(type.utf8) + body
        return be32(UInt32(body.count)) + typed + be32(crc32(typed))
    }
    let row = [UInt8](repeating: 0, count: side + 1)
    var deflated: [UInt8] = []
    let stream = UnsafeMutablePointer<compression_stream>.allocate(capacity: 1)
    defer { stream.deallocate() }
    compression_stream_init(stream, COMPRESSION_STREAM_ENCODE, COMPRESSION_ZLIB)
    let out = UnsafeMutablePointer<UInt8>.allocate(capacity: 65_536)
    defer { out.deallocate() }
    row.withUnsafeBufferPointer { rowBytes in
        for n in 0..<side {
            stream.pointee.src_ptr = rowBytes.baseAddress!
            stream.pointee.src_size = rowBytes.count
            let last = n == side - 1
            repeat {
                stream.pointee.dst_ptr = out
                stream.pointee.dst_size = 65_536
                let status = compression_stream_process(stream, last ? Int32(COMPRESSION_STREAM_FINALIZE.rawValue) : 0)
                deflated += UnsafeBufferPointer(start: out, count: 65_536 - stream.pointee.dst_size)
                if status == COMPRESSION_STATUS_END { break }
            } while stream.pointee.src_size > 0 || (last && stream.pointee.dst_size == 0)
        }
    }
    compression_stream_destroy(stream)
    // zlib's wrapper: a header, then Adler-32 of all those zeros (A stays 1,
    // B counts the bytes).
    let total = UInt32((side * (side + 1)) % 65_521)
    let zlib = [0x78, 0x01] + deflated + be32(total << 16 | 1)
    let header = be32(UInt32(side)) + be32(UInt32(side)) + [8, 0, 0, 0, 0]
    let png = [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A] + chunk("IHDR", header) + chunk("IDAT", zlib) + chunk("IEND", [])
    return Data(png)
}

private func crc32(_ bytes: [UInt8]) -> UInt32 {
    var crc: UInt32 = 0xFFFF_FFFF
    for byte in bytes {
        crc ^= UInt32(byte)
        for _ in 0..<8 { crc = crc & 1 == 1 ? (crc >> 1) ^ 0xEDB8_8320 : crc >> 1 }
    }
    return ~crc
}

/// The same random strings on every run (SplitMix64).
struct SeededGenerator: RandomNumberGenerator {
    var state: UInt64
    init(seed: UInt64) { state = seed }
    mutating func next() -> UInt64 {
        state &+= 0x9E37_79B9_7F4A_7C15
        var z = state
        z = (z ^ (z >> 30)) &* 0xBF58_476D_1CE4_E5B9
        z = (z ^ (z >> 27)) &* 0x94D0_49BB_1331_11EB
        return z ^ (z >> 31)
    }
}
