import XCTest
@testable import ThreadbearCore

/// The error bar's Investigate brief (InvestigateText).
final class InvestigateTextTests: XCTestCase {
    func testThePromptCarriesTheErrorTheThreadAndWhatHeWasDoing() {
        let r = InvestigateText.Report(
            message: "Couldn't trust poddle: Thread not found: a9ea90a7",
            at: Date(timeIntervalSince1970: 0),
            threadId: "a9ea90a7", threadTitle: "Poddle uploads", threadFolder: "/Users/m/dev/me/poddle",
            doing: "pressing Trust on a patch in the Patches panel",
            appVersion: "1.0", appCommit: "4e57f24", runnerVersion: "2026.11.07-1")
        let p = InvestigateText.prompt(r)
        XCTAssertTrue(p.contains("> Couldn't trust poddle: Thread not found: a9ea90a7"))
        XCTAssertTrue(p.contains("- In thread a9ea90a7 (\"Poddle uploads\"), folder /Users/m/dev/me/poddle"))
        XCTAssertTrue(p.contains("- Mike was pressing Trust on a patch in the Patches panel"))
        XCTAssertTrue(p.contains("- The app 1.0, built from 4e57f24"))
        XCTAssertTrue(p.contains("- Runner 2026.11.07-1"))
        XCTAssertTrue(p.contains("Find the cause in this checkout and fix it."))
    }

    func testWithNothingKnownItStillSaysTheError() {
        let p = InvestigateText.prompt(.init(message: "Busy", at: Date()))
        XCTAssertTrue(p.contains("> Busy"))
        XCTAssertTrue(p.contains("- No thread was open"))
        XCTAssertFalse(p.contains("Mike was"))
        XCTAssertFalse(p.contains("Runner"))
    }

    func testTheTitleIsTheErrorsFirstWords() {
        XCTAssertEqual(InvestigateText.title(.init(message: "Busy", at: Date())), "Error: Busy")
        let long = InvestigateText.title(.init(message: String(repeating: "word ", count: 30), at: Date()))
        XCTAssertTrue(long.hasSuffix("…"))
        XCTAssertLessThanOrEqual(long.count, 57)
    }
}
