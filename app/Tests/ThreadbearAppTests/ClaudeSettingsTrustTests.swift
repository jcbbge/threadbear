import XCTest
@testable import Threadbear
import ThreadbearCore

/// A folder's Claude Code settings waiting to be trusted, as the runner
/// lists them among the thread's patches (source "claude"): the words on
/// the Patches row and the chip over the composer.
final class ClaudeSettingsTrustTests: XCTestCase {
    private let claude = PatchInfo(id: "claude-settings", source: "claude", file: "/r/.claude/settings.json", untrusted: "new", hash: String(repeating: "a", count: 64))
    private let patch = PatchInfo(id: "tools", source: "project", file: "/r/.threadbear/patches/tools.ts", untrusted: "new", hash: String(repeating: "b", count: 64))

    func testTheRowSaysHooksAreSkippedRatherThanNotRun() {
        XCTAssertEqual(PatchesList.waitingText(claude, untrusted: "new"), "Hooks, commands and environment settings skipped until you trust them")
        XCTAssertEqual(PatchesList.waitingText(claude, untrusted: "changed"), "Changed since you trusted them, so they're skipped")
        XCTAssertEqual(PatchesList.waitingText(patch, untrusted: "new"), "Not run yet")
        XCTAssertEqual(PatchesList.sourceName("claude"), "Claude Code settings")
    }

    func testTheChipCountsHooksWithoutCallingThemAPatch() {
        XCTAssertEqual(WaitingPatchesChip.label([claude]), "Hooks to trust")
        XCTAssertEqual(WaitingPatchesChip.label([claude, patch]), "2 to trust")
        XCTAssertEqual(WaitingPatchesChip.label([patch]), "1 patch to trust")
        XCTAssertEqual(WaitingPatchesChip.label([patch, patch]), "2 patches to trust")
    }

    func testTheClaudeSourceDecodesWithItsFiles() throws {
        let json = #"{"id":"claude-settings","source":"claude","file":"/r/.claude/settings.json","untrusted":"new","hash":"aa","helpers":["/r/.claude/hooks/start.mjs"]}"#
        let info = try JSONDecoder().decode(PatchInfo.self, from: Data(json.utf8))
        XCTAssertEqual(info.source, "claude")
        XCTAssertEqual(info.helpers, ["/r/.claude/hooks/start.mjs"])
        XCTAssertNil(info.grants)
    }

    func testWhatTheirPermissionRulesAllowDecodes() throws {
        let json = #"{"id":"claude-settings","source":"claude","file":"/r/.claude/settings.json","untrusted":"new","hash":"aa","grants":["Allows Bash without asking (.claude/settings.json)"]}"#
        let info = try JSONDecoder().decode(PatchInfo.self, from: Data(json.utf8))
        XCTAssertEqual(info.grants, ["Allows Bash without asking (.claude/settings.json)"])
    }
}
