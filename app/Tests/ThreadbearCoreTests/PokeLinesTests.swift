import XCTest
@testable import ThreadbearCore

final class PokeLinesTests: XCTestCase {
    func testADifferentLineEachPoke() {
        var pokes = PokeLines(PokeLines.librarian)
        let said = (0..<4).compactMap { _ in pokes.poke() }
        XCTAssertEqual(said, PokeLines.librarian)
    }

    func testAFifthInARowGivesUp() {
        var pokes = PokeLines(PokeLines.librarian)
        for _ in 0..<4 { _ = pokes.poke() }
        XCTAssertEqual(pokes.poke(), "Alright, alright.")
        // And then it carries on where it was, never the same line twice running.
        XCTAssertEqual(pokes.poke(), PokeLines.librarian[0])
    }

    func testAPauseStartsANewRun() {
        var pokes = PokeLines(PokeLines.scheduled)
        for _ in 0..<4 { _ = pokes.poke() }
        pokes.endRun()
        XCTAssertNotEqual(pokes.poke(), "Alright, alright.")
    }

    func testNoLinesNoPoke() {
        var pokes = PokeLines([])
        XCTAssertNil(pokes.poke())
    }
}
