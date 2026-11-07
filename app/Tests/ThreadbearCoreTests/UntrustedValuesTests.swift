import Foundation
import Testing
@testable import ThreadbearCore

/// Values another runner, the backend or model output controls must be
/// refused or held in range, never reach a Swift trap (`Int(1e100)`, a
/// UInt8 below "0" minus 48, `Int.max + 1`) or superlinear work on the
/// main thread. Daybreak's findings of 7 Nov 2026, each played here.
// One at a time: several of these are heavy on purpose and don't suspend, and
// all together they held every pool thread, so the other suites' short
// sleeps and fake turns ran late and their tests failed.
@Suite(.serialized) struct UntrustedValuesTests {
    private func decode<T: Decodable>(_ type: T.Type, _ json: String) throws -> T {
        try JSONDecoder().decode(type, from: Data(json.utf8))
    }

    // MARK: Heartbeat startedAt (runners.list)

    @Test func aRunnersStartedAtWithABadOffsetIsNoTime() throws {
        // Daybreak's payload: four bytes after the sign, none a digit.
        let json = #"{"runners":[{"id":"evil","name":"evil","online":true,"startedAt":"2026-11-05T01:00:00+////"},{"id":"ok","name":"ok","startedAt":"2026-11-05T01:00:00+01:30"}]}"#
        let runners = try decode(RunnersResult.self, json).runners
        #expect(runners.map(\.id) == ["evil", "ok"])
        #expect(runners[0].startedAt == nil)
        #expect(runners[1].startedAt == ISO8601.parse("2026-11-04T23:30:00Z"))
    }

    @Test func iso8601RefusesWhatIsNotATime() {
        for bad in ["2026-11-05T01:00:00+////", "2026-11-05T01:00:00-////", "2026-11-05T01:00:00+0a:00", "2026-11-05T01:00:00+01:3",
                    "2026-11-05T01:00:00+", "2026-11-05T01:00:00+24:00", "2026-11-05T01:00:00+01:60", "2026-11-05T01:00:00Zjunk",
                    "2026-11-05T01:00:00+01:30junk", "2026-11-05T01:00:00.Z", "2026-13-05T01:00:00Z", "2026-11-05T25:00:00Z",
                    "2026/11/05T01:00:00Z", "2026-11-05T01:00:00\u{0}", "2026-11-05T01:00:00" + String(repeating: "0", count: 100),
                    "2026-11-05T01:00:00 ////", "\u{FF}\u{FF}\u{FF}\u{FF}-11-05T01:00:00Z"] {
            #expect(ISO8601.parse(bad) == nil, "\(bad)")
        }
        // And what's real still reads.
        #expect(ISO8601.parse("2026-11-05T01:00:00Z") == Date(timeIntervalSince1970: 1_793_840_400))
        #expect(ISO8601.parse("2026-11-05T01:00:00") == Date(timeIntervalSince1970: 1_793_840_400))
        #expect(ISO8601.parse("2026-11-05T02:30:00+0130") == Date(timeIntervalSince1970: 1_793_840_400))
        #expect(ISO8601.parse("2026-11-05T01:00:00.123456789Z")?.timeIntervalSince1970 ?? 0 == 1_793_840_400.123456789)
        #expect(ISO8601.parse("2026-11-04T19:00:00-06:00") == Date(timeIntervalSince1970: 1_793_840_400))
    }

    // MARK: files.list sizes

    @Test func aFolderEntrysSizeOutOfRangeIsNoSize() throws {
        let sizes = ["1e100", "-1e100", "1.5", "-1", "9223372036854775807", "9223372036854775808", "1.7976931348623157e308"]
        for size in sizes {
            let json = #"{"path":"/remote","entries":[{"name":"notes.md","size":"# + size + #"},{"name":"b"}],"truncated":false}"#
            let contents = try decode(FolderContents.self, json)
            #expect(contents.entries.map(\.name) == ["notes.md", "b"], "\(size)")
            #expect(contents.entries[0].size == nil, "\(size)")
        }
        let normal = try decode(FolderContents.self, #"{"path":"/r","entries":[{"name":"a","size":1024},{"name":"z","size":0}]}"#)
        #expect(normal.entries.map(\.size) == [1024, 0])
    }

    @Test func aRemoteFilesSizeOutOfRangeIsZero() throws {
        let file = try decode(FileRead.self, #"{"path":"/a","size":1e100,"modifiedAt":"x","unchanged":true}"#)
        #expect(file.stamp.size == 0)
        #expect(try decode(FileRead.self, #"{"path":"/a","size":2048,"unchanged":true}"#).stamp.size == 2048)
    }

    // MARK: runners.stats

    @Test func aRunnersStatsOutOfRangeLeaveThatRunnerOut() throws {
        func row(_ id: String, _ field: String, _ value: String) -> String {
            var fields = ["cpuPercent": "12", "cores": "8", "memUsed": "1000", "memTotal": "2000", "diskFree": "10", "diskTotal": "20", "uptimeSec": "60", "load1": "1.5"]
            fields[field] = value
            return #"{"runnerId":"\#(id)","at":"2026-11-05T01:00:00Z","# + fields.map { "\"\($0.key)\":\($0.value)" }.joined(separator: ",") + "}"
        }
        // Daybreak's: cores 1e20 on a runner that isn't the one opened.
        for (field, value) in [("cores", "1e20"), ("cores", "8.5"), ("cores", "-1"), ("cpuPercent", "1e300"), ("memUsed", "1e300"),
                               ("diskFree", "-5"), ("uptimeSec", "1e300"), ("load1", "1e300"), ("memTotal", "1e19")] {
            let json = #"{"stats":["# + row("good", "cores", "8") + "," + row("evil", field, value) + "]}"
            let stats = try decode(RunnerStatsResult.self, json).stats
            #expect(stats.map(\.runnerId) == ["good"], "\(field) \(value)")
        }
        let fine = try decode(RunnerStatsResult.self, #"{"stats":["# + row("a", "cores", "10") + "]}").stats
        #expect(fine.first?.cores == 10)
        #expect(fine.first?.load1 == 1.5)
    }

    @Test func runnersWordsNeverTrapOnHugeFigures() {
        let huge = RunnerMachineStats(runnerId: "x", cpuPercent: 1e300, cores: 8, memUsed: 1e300, memTotal: 1e300, diskFree: 1e300, diskTotal: 1e300, load1: 1e300, uptimeSec: 1e300)
        #expect(!RunnersText.gauges(huge).isEmpty)
        #expect(!RunnersText.machineLines(huge).isEmpty)
        #expect(RunnersText.gb(.infinity).hasSuffix("TB"))
        #expect(RunnersText.span(seconds: 1e300).hasSuffix("d"))
    }

    // MARK: Other numbers off the wire

    @Test func countsOffTheWireAreHeldOrDropped() throws {
        // A seq of Int.max made the feed's `seq + 1` trap.
        let event = try decode(Event.self, #"{"seq":9223372036854775807,"type":"x","threadId":"t"}"#)
        #expect(event.seq == 0)
        #expect(try decode(Event.self, #"{"seq":1e100,"type":"x","threadId":"t"}"#).seq == 0)
        #expect(try decode(Event.self, #"{"seq":42,"type":"x","threadId":"t"}"#).seq == 42)
        let page = try decode(EventsPage.self, #"{"events":[],"firstSeq":1e300,"lastSeq":9007199254740993}"#)
        #expect(page.firstSeq == 0 && page.lastSeq == 0)
        let thread = try decode(ThreadSummary.self, #"{"id":"t","title":"x","cwd":"/","status":"idle","createdAt":"2026-11-05T01:00:00Z","lastActivityAt":"2026-11-05T01:00:00Z","lastSeq":9223372036854775807,"contextTokens":1e100,"contextWindow":-5}"#)
        #expect(thread.lastSeq == 0)
        #expect(thread.contextTokens == nil && thread.contextWindow == nil)
        let picture = try decode(ImageRef.self, #"{"path":"/a.png","width":1e100,"height":-3}"#)
        #expect(picture.width == nil && picture.height == nil)
    }

    @Test func aReadsOffsetFromTheModelIsHeld() {
        for offset in [1e300, -1e300, 9.2e18] {
            let read = ToolItem(itemId: "c1", call: ToolCall(itemId: "c1", name: "Read", kind: .read, title: "t", input: .object(["file_path": .string("/a"), "offset": .number(offset)])),
                                result: ToolResult(itemId: "c1", ok: true, text: "a\nb"))
            guard case .file(_, let lines) = ToolPresentation.detail(read) else { Issue.record("not a file"); continue }
            #expect(lines.count == 2)
        }
    }

    @Test func usageHoursOutOfRangeAreSkipped() throws {
        let json = #"{"accountId":"a","hours":[[1762304400000,1e100,1,1,1],[1762304400000,10,-1,0,0],[1e300,1,1,1,1],[1762308000000,10,20,30,40]]}"#
        let usage = try decode(AccountTokens.self, json)
        #expect(usage.hours.map(\.input) == [10])
    }

    @Test func wordsForHugeTimesNeverTrap() {
        #expect(RelativeTime.duration(milliseconds: 1e300).hasSuffix("m"))
        #expect(RelativeTime.duration(milliseconds: .infinity).hasSuffix("m"))
        #expect(!TurnGap.later(1e300).isEmpty)
        #expect(AccountUsageText.percent(1e300).hasSuffix("%"))
        #expect(ThreadRowLook.workingLabel(since: .distantPast, now: Date(timeIntervalSince1970: 1e300)).hasSuffix("m"))
        #expect(WokeWords.away(1e300).hasSuffix("days"))
        #expect(ScheduleTime.relative(Date(timeIntervalSince1970: 1e300), now: Date()).hasSuffix("days"))
        #expect(Int(checked: 1e100) == nil && Int(checked: -.infinity) == nil && Int(checked: .nan) == nil)
        #expect(Int(checked: 9_223_372_036_854_775_808.0) == nil && Int(checked: -9_223_372_036_854_775_808.0) == .min)
        #expect(Int(saturating: 1e100) == .max && Int(saturating: -1e100) == .min && Int(saturating: .nan) == 0 && Int(saturating: 2.9) == 2)
    }

    // MARK: Markdown nesting

    @Test func nestingIsBoundedFromAbove() {
        #expect(MarkdownNesting.bound(String(repeating: ">", count: 7_999) + "x") == 7_999)
        #expect(MarkdownNesting.bound(String(repeating: "- ", count: 4_000) + "x") == 4_000)
        #expect(MarkdownNesting.bound(String(repeating: "1. ", count: 100) + "x") == 100)
        // Nested one line at a time, by indent, or with \r between lines.
        let indented = (0..<200).map { String(repeating: "  ", count: $0) + "- x" }
        #expect(MarkdownNesting.bound(indented.joined(separator: "\n")) >= 200)
        #expect(MarkdownNesting.bound(indented.joined(separator: "\r")) >= 200)
        // Empty items still nest (cross-lab review).
        let empty = (0..<300).map { String(repeating: "  ", count: $0) + "-" }
        #expect(MarkdownNesting.bound(empty.joined(separator: "\n")) >= 300)
        #expect(MarkdownNesting.bound(empty.joined(separator: "\r") + "\r") >= 300)
        // A lazy line keeps what's open; the next one opens more.
        #expect(MarkdownNesting.bound("> > a\nlazy\n> > > b") >= 3)
        // What people write stays well under MarkdownRenderer's limit.
        #expect(MarkdownNesting.bound("> a quote\n> - with a list\n>   - nested\n\n```\n" + String(repeating: " ", count: 200) + "code\n```") < 10)
        #expect(MarkdownNesting.bound("*bold* and - a dash, 3.5 apples, 1.x") == 0)
        #expect(MarkdownNesting.inlineMarks("*a* _b_ ~c~ [d](e)") == 7)
        let seconds = cpuSeconds { _ = MarkdownNesting.bound(String(repeating: "> - 1. ", count: 10_000)) }
        #expect(seconds < 0.1)
    }

    // MARK: Other regexes over a reply

    @Test func workLinksAndAsksAreLinear() {
        let links = String(repeating: "](work:", count: 32_000 / 7)
        let row = TranscriptRow(id: "a", seq: 1, content: .assistant(TextItem(itemId: "a", text: links, isStreaming: false)))
        for run in [{ _ = WorkLinks.escapeDestinations(links) }, { _ = WorkLinks.step(for: "npm test", in: [row]) },
                    { _ = Decisions.paragraph(Ask(action: String(repeating: " ", count: 8_000) + "x")) }] {
            let seconds = cpuSeconds(run)
            #expect(seconds < 0.1, "\(seconds) s")
        }
        // What they did before, they still do.
        #expect(WorkLinks.escapeDestinations("[tests](work:npm test) [x](work:a b") == "[tests](work:npm%20test) [x](work:a b")
        let linked = TranscriptRow(id: "b", seq: 2, content: .assistant(TextItem(itemId: "b", text: "Ran [the tests](work:npm test).", isStreaming: false)))
        #expect(WorkLinks.step(for: "npm test", in: [linked]) == nil, "a line that links to a step isn't the step")
        #expect(Decisions.paragraph(Ask(action: "Merge\n  it\r\n now ")) == "Merge it now")
    }

    @Test func aRestartNoticesCountsAddWithoutTrapping() {
        // A runner's notice: each number an Int, their sum not.
        let notice = RunnerRestart.parse("The runner will restart when 9223372036854775807 threads finish and you answer 1")
        #expect(notice != nil)
    }

    @Test func usageSumsHoldAtIntMax() {
        // Each hour in range, a quarter of a million of them not.
        let hour = TokenHour(start: Date(), input: 10_000_000_000_000, output: 10_000_000_000_000, cacheRead: 10_000_000_000_000, cacheWrite: 10_000_000_000_000)
        var sum = TokenHour(start: Date())
        for _ in 0..<300_000 { sum = sum + hour }
        #expect(sum.total == .max)
        #expect(Int.max.adding(saturating: 1) == .max && Int.min.adding(saturating: -1) == .min && 2.adding(saturating: 3) == 5)
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

    @Test func tableCellsAreBounded() {
        let wide = String(repeating: "x|", count: 800) + "\n" + String(repeating: "-|", count: 800) + "\n" + String(repeating: "x|\n", count: 2_000)
        #expect(MarkdownNesting.tableCells(wide) >= 1_600_000)
        #expect(MarkdownNesting.tableCells("> | a | b |\n> |---|:-:|\n> | 1 | 2 |") >= 6)
        // A long code block or paragraph with pipes and no delimiter row isn't one.
        #expect(MarkdownNesting.tableCells(String(repeating: "a | b | c\n", count: 5_000)) == 0)
        #expect(MarkdownNesting.tableCells("| a | b |\n|---|---|\n| 1 | 2 |") < 100)
    }

    // MARK: Card mentions

    /// CPU time, as the Mac running these is often busy.
    private func cpuSeconds(_ work: () -> Void) -> Double {
        // This thread's own time: Swift Testing runs other tests alongside,
        // and clock() would count theirs too.
        func now() -> Double { Double(clock_gettime_nsec_np(CLOCK_THREAD_CPUTIME_ID)) / 1e9 }
        let start = now()
        work()
        return now() - start
    }

    @Test func cardMentionsAreLinearOnBracketsWithNoLink() {
        // Daybreak's: 32,000 `[` then "notion." took 16 s with the regex.
        let inputs = [String(repeating: "[", count: 32_000) + "notion.",
                      String(repeating: "[a\\", count: 11_000) + "notion.",
                      String(repeating: "[a](https://x.notion.so/", count: 1_400),
                      String(repeating: "[a](thread:", count: 3_000) + "](thread:",
                      String(repeating: "![", count: 16_000) + "](thread:x)"]
        for input in inputs {
            var found: [CardMentions.Mention] = []
            let seconds = cpuSeconds { found = CardMentions.find(in: input) }
            #expect(seconds < 0.1, "\(seconds) s for \(input.prefix(24))")
            _ = found
        }
    }

    @Test func cardMentionsFindWhatTheRegexFound() {
        // The regex they replace, kept here to check the scan against.
        let regex = try! NSRegularExpression(pattern: #"(?<!!)\[((?:[^\]\\\n]|\\.)+)\]\((https://(?:[A-Za-z0-9-]+\.)*notion\.(?:so|site|com)/[^\s)]*|thread:[A-Za-z0-9_-]+)\)"#)
        func old(_ text: String) -> [String] {
            guard text.contains("notion.") || text.contains("](thread:") else { return [] }
            let ns = text as NSString
            return regex.matches(in: text, range: NSRange(location: 0, length: ns.length)).map { m in
                let title = ns.substring(with: m.range(at: 1)).replacingOccurrences(of: "\\[", with: "[").replacingOccurrences(of: "\\]", with: "]")
                return "\(m.range)|\(title)|\(ns.substring(with: m.range(at: 2)))"
            }
        }
        func new(_ text: String) -> [String] { CardMentions.find(in: text).map { "\($0.range)|\($0.title)|\($0.url)" } }
        let fixed = ["[a [b](thread:x)", "![a](thread:x) [b](thread:y)", "[a\\](b](thread:x)", "[a\\\n](thread:x)", "[](thread:x)",
                     "[a](https://notion.so.evil.com/x)", "[a](https://www.notion.so/x y)", "[a](https://www.notion.so/x\u{A0})",
                     "[a](https://www.notion.so/x\u{0B})", "[a](https://a..notion.so/x)", "[a](https://.notion.so/x)", "[a](https://my-notion.so/x)",
                     "[\u{1F600}\\\u{1F600}](thread:a_b-c)", "[a\\\r](thread:x)", "[a\r](thread:x)", "x![[a](thread:x)", "[a](thread:)"]
        for text in fixed { #expect(new(text) == old(text), "\(text.debugDescription)") }
        let pieces = ["[", "]", "(", ")", "\\", "!", "\n", "\r", " ", "a", "-", "_", ".", "/", "https://", "notion.so", "notion.site", "x.notion.com",
                      "thread:", "](", "](thread:", "](https://", "](https://www.notion.so/", "\u{0B}", "\u{85}", "\u{A0}", "\u{2028}", "\u{1F600}", "notion."]
        var generator = SeededGenerator(seed: 7)
        for _ in 0..<20_000 {
            let text = (0..<Int.random(in: 1...12, using: &generator)).map { _ in pieces.randomElement(using: &generator)! }.joined()
            let a = old("notion." + text), b = new("notion." + text)
            #expect(a == b, "\(text.debugDescription)")
            if a != b { break }
        }
    }
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
