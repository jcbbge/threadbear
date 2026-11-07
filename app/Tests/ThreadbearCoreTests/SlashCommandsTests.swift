import XCTest
@testable import ThreadbearCore

final class SlashCommandsTests: XCTestCase {
    let commands = [
        SlashCommand(name: "model", description: "Switch this thread's model", argumentHint: "[model]", source: "threadbear"),
        SlashCommand(name: "effort", description: "Set this thread's effort level", source: "threadbear"),
        SlashCommand(name: "compact", description: "Free up context", source: "cli"),
        SlashCommand(name: "context", description: "What's using the context window", source: "cli"),
        SlashCommand(name: "code-review", description: "Review the diff", argumentHint: "[level] [target]", source: "skill"),
        SlashCommand(name: "deslop", description: "Clean up code", source: "skill"),
    ]

    func testQueryIsOnlyTheCommandBeingTyped() {
        XCTAssertEqual(SlashPalette.query(in: "/"), "")
        XCTAssertEqual(SlashPalette.query(in: "/co"), "co")
        XCTAssertNil(SlashPalette.query(in: "/compact now"), "arguments: the palette goes")
        XCTAssertNil(SlashPalette.query(in: "/Users/"), "a path")
        XCTAssertNil(SlashPalette.query(in: "/a\nb"))
        XCTAssertNil(SlashPalette.query(in: "hi /co"))
    }

    func testMatchesStartsWithThenContainsThenDescription() {
        let names = SlashPalette.matches(commands, query: "co", category: .all, recent: []).map(\.name)
        XCTAssertEqual(names, ["compact", "context", "code-review", "deslop"], "deslop by its description")
        XCTAssertEqual(SlashPalette.matches(commands, query: "", category: .skills, recent: []).map(\.name), ["code-review", "deslop"])
        XCTAssertEqual(SlashPalette.matches(commands, query: "", category: .cli, recent: []).map(\.name), ["compact", "context"])
    }

    func testRecentIsInTheOrderUsed() {
        let recent = SlashPalette.used("compact", recent: SlashPalette.used("deslop", recent: []))
        XCTAssertEqual(recent, ["compact", "deslop"])
        XCTAssertEqual(SlashPalette.matches(commands, query: "", category: .recent, recent: recent).map(\.name), ["compact", "deslop"])
        XCTAssertEqual(SlashPalette.used("deslop", recent: recent), ["deslop", "compact"])
    }

    func testCountsLeaveOutAnEmptyRecent() {
        let counts = SlashPalette.counts(commands, query: "", recent: [])
        XCTAssertEqual(counts.map(\.0), [.all, .threadbear, .cli, .skills])
        XCTAssertEqual(counts.map(\.1), [6, 2, 2, 2])
    }

    func testUsageAndFill() {
        XCTAssertEqual(commands[4].usage, "/code-review [level] [target]")
        XCTAssertEqual(commands[2].usage, "/compact")
        XCTAssertEqual(SlashPalette.fill(commands[4], forArguments: true), "/code-review ")
        XCTAssertEqual(SlashPalette.fill(commands[2], forArguments: false), "/compact")
    }

    func testDecodesTheRunnersList() throws {
        let json = #"{"commands":[{"name":"compact","source":"cli"},{"name":"x","description":"d","argumentHint":"<f>","source":"skill","extra":1}]}"#
        let list = try JSONDecoder().decode(SlashCommandList.self, from: Data(json.utf8))
        XCTAssertEqual(list.commands.map(\.name), ["compact", "x"])
        XCTAssertEqual(list.commands[1].argumentHint, "<f>")
        XCTAssertEqual(SlashPalette.Category.cli.title(provider: "codex"), "Codex")
    }

    func testOriginSaysWhereItCameFrom() {
        func origin(_ c: SlashCommand) -> String { SlashPalette.origin(of: c, provider: "claude") }
        XCTAssertEqual(origin(SlashCommand(name: "v", source: "skill", scope: "user", path: "/u/.claude/skills/v/SKILL.md")), "Your skill")
        XCTAssertEqual(origin(SlashCommand(name: "d", source: "skill", scope: "project", path: "/r/.claude/commands/d.md")), "This folder's command")
        XCTAssertEqual(origin(SlashCommand(name: "p", source: "skill", scope: "plugin", plugin: "ship-tools")), "From the ship-tools plugin")
        XCTAssertEqual(origin(SlashCommand(name: "x", source: "skill", scope: "claude.ai")), "Synced from claude.ai")
        XCTAssertEqual(origin(SlashCommand(name: "c", source: "cli", scope: "system")), "Claude Code's own")
        XCTAssertEqual(SlashPalette.shortPath("/Users/m/.claude/skills/v/SKILL.md", home: "/Users/m"), "~/.claude/skills/v/SKILL.md")
        XCTAssertEqual(SlashPalette.shortPath("/opt/x", home: "/Users/m"), "/opt/x")
    }

    func testColumnsFitTheirLongestEntryAndGiveWayWhenNarrow() {
        // Wide: each column as wide as it needs.
        let wide = SlashPalette.columnWidths(total: 900, categories: 160, list: 230)
        XCTAssertEqual(wide.categories, 160)
        XCTAssertEqual(wide.list, 230)
        // A very long name takes at most half of what's left.
        XCTAssertEqual(SlashPalette.columnWidths(total: 900, categories: 160, list: 600).list, 370)
        // Narrow: the list gives way first, then the categories.
        let narrow = SlashPalette.columnWidths(total: 520, categories: 160, list: 230)
        XCTAssertEqual(narrow.list, 160)
        XCTAssertEqual(narrow.categories, 160)
        let tiny = SlashPalette.columnWidths(total: 450, categories: 160, list: 230)
        XCTAssertEqual(tiny.list, 120)
        XCTAssertEqual(tiny.categories, 130)
    }

    func testHeightIsAboutHalfTheWindow() {
        XCTAssertEqual(SlashPalette.height(window: 1000), 500)
        XCTAssertEqual(SlashPalette.height(window: 400), 300, "never below the least")
        XCTAssertEqual(SlashPalette.height(window: 1600), 560, "nor above the most")
    }

    func testDraggedSizesStayInBounds() {
        typealias L = SlashPalette.Layout
        XCTAssertEqual(L.height(100, window: 900), 220, "never too short to use")
        XCTAssertEqual(L.height(2000, window: 900), 765, "never past 85% of the window")
        XCTAssertEqual(L.height(500, window: 900), 500)
        XCTAssertEqual(L.width(300, window: 1400), 480)
        XCTAssertEqual(L.width(5000, window: 1400), 1320)
        // A dragged column leaves the others room: 900 wide, the rest needing 500.
        XCTAssertEqual(L.column(600, least: 110, others: 500, total: 900), 400)
        XCTAssertEqual(L.column(50, least: 110, others: 500, total: 900), 110)
        // A list Mike dragged wide isn't held to half of what's left.
        XCTAssertEqual(SlashPalette.columnWidths(total: 900, categories: 160, list: 450, chosen: true).list, 450)
        XCTAssertEqual(SlashPalette.columnWidths(total: 900, categories: 160, list: 450).list, 370)
        let saved = try! JSONDecoder().decode(L.self, from: JSONEncoder().encode(L(height: 500, list: 300)))
        XCTAssertEqual(saved, L(height: 500, list: 300))
    }

    func testDescriptionRendersInlineMarkdown() {
        let text = SlashPalette.description("Run the `computercub` command, **now**.")
        XCTAssertEqual(String(text.characters), "Run the computercub command, now.")
        let code = text.runs.first { $0.inlinePresentationIntent == .code }
        XCTAssertEqual(code.map { String(text[$0.range].characters) }, "computercub")
        // Plain words and paths come through as they are.
        XCTAssertEqual(String(SlashPalette.description("Open chrome:// pages (Finder, Xcode)").characters), "Open chrome:// pages (Finder, Xcode)")
    }
}
