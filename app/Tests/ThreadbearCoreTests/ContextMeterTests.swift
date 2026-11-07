import Testing
@testable import ThreadbearCore

@Suite struct ContextMeterTests {
    @Test func needsBothTokensAndWindow() {
        #expect(ContextMeter(used: 100, window: nil) == nil)
        #expect(ContextMeter(used: nil, window: 200_000) == nil)
        #expect(ContextMeter(used: 100, window: 0) == nil)
        #expect(ContextMeter(used: 0, window: 200_000) != nil)
    }

    @Test func fractionPercentAndNearlyFull() {
        let m = ContextMeter(used: 640_000, window: 1_000_000)!
        #expect(m.percent == 64)
        #expect(!m.isNearlyFull)
        #expect(m.amount == "640k of 1M tokens")
        #expect(m.tip == "Context 64% full")
        #expect(ContextMeter(used: 160_000, window: 200_000)!.isNearlyFull)
        // Over the window (a count taken mid-compaction) reads as full.
        #expect(ContextMeter(used: 300_000, window: 200_000)!.percent == 100)
    }

    @Test func tokenWords() {
        #expect(ContextMeter.tokens(850) == "850")
        #expect(ContextMeter.tokens(1_000) == "1k")
        #expect(ContextMeter.tokens(1_250) == "1.2k")
        #expect(ContextMeter.tokens(12_400) == "12k")
        #expect(ContextMeter.tokens(258_400) == "258k")
        #expect(ContextMeter.tokens(1_000_000) == "1M")
        #expect(ContextMeter.tokens(1_250_000) == "1.2M")
    }

    @Test func compactNoteNamesTheProvider() {
        #expect(ContextMeter.compactNote(provider: "claude") == "Claude compacts it by itself when it's nearly full.")
        #expect(ContextMeter.compactNote(provider: "codex").hasPrefix("Codex"))
    }

    @Test func fromAThread() {
        var t = ThreadSummary(id: "t", title: "x", cwd: "/", accountId: "a")
        #expect(ContextMeter(t) == nil)
        t.contextTokens = 5_000
        t.contextWindow = 200_000
        #expect(ContextMeter(t)?.percent == 3)
    }
}
