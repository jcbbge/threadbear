import CoreGraphics
import XCTest
@testable import ThreadbearCore

final class ArchiveFlightPathTests: XCTestCase {
    // Window coordinates, y up: the panel's centre on the right, the
    // Archived heading low on the left, as in a short inbox.
    let path = ArchiveFlightPath(start: CGPoint(x: 800, y: 400), end: CGPoint(x: 120, y: 200))

    func testStartsAsThePanelItself() {
        let frame = path.frame(at: 0)
        XCTAssertEqual(frame.position, CGPoint(x: 800, y: 400))
        XCTAssertEqual(frame.scale, 1)
        XCTAssertEqual(frame.tilt, 0, accuracy: 1e-9)
        XCTAssertEqual(frame.opacity, 1)
    }

    func testEndsTinyOnTheHeading() {
        let frame = path.frame(at: 1)
        XCTAssertEqual(frame.position.x, 120, accuracy: 1e-9)
        XCTAssertEqual(frame.position.y, 200, accuracy: 1e-9)
        XCTAssertEqual(frame.scale, ArchiveFlightPath.smallest, accuracy: 1e-9)
        XCTAssertEqual(frame.tilt, 0, accuracy: 1e-9)
        // Still faintly there as it lands, so the bounce follows on from it.
        XCTAssertEqual(frame.opacity, 0.2, accuracy: 1e-9)
    }

    /// It swings: early on it's moved further down than across, and it's
    /// below the straight line between the two.
    func testFallsBeforeItSwingsAcross() {
        let early = path.frame(at: 0.25).position
        XCTAssertGreaterThan(400 - early.y, 800 - early.x)
        let middle = path.frame(at: 0.5).position
        let straightY = 400 + (middle.x - 800) / (120 - 800) * (200 - 400)
        XCTAssertLessThan(middle.y, straightY)
    }

    func testShrinksAndTipsOnTheWay() {
        let frames = stride(from: 0.0, through: 1.0, by: 0.1).map { path.frame(at: $0) }
        for (a, b) in zip(frames, frames.dropFirst()) {
            XCTAssertLessThanOrEqual(b.scale, a.scale)
        }
        XCTAssertGreaterThan(path.frame(at: 0.5).tilt, 0)
        XCTAssertEqual(path.frame(at: 0.5).opacity, 1)
    }

    /// With the heading out of sight it falls off the bottom of the list,
    /// gone by the end.
    func testOffTheListFadesAllTheWay() {
        let off = ArchiveFlightPath(start: path.start, end: path.end, onHeading: false)
        XCTAssertEqual(off.frame(at: 1).opacity, 0, accuracy: 1e-9)
        XCTAssertLessThan(off.frame(at: 0.8).opacity, path.frame(at: 0.8).opacity)
    }

    func testProgressEasesInAndOut() {
        XCTAssertEqual(ArchiveFlightPath.progress(atTime: 0), 0)
        XCTAssertEqual(ArchiveFlightPath.progress(atTime: 0.5), 0.5, accuracy: 1e-9)
        XCTAssertEqual(ArchiveFlightPath.progress(atTime: 1), 1)
        XCTAssertEqual(ArchiveFlightPath.progress(atTime: 2), 1)
        XCTAssertLessThan(ArchiveFlightPath.progress(atTime: 0.1), 0.1)
        XCTAssertGreaterThan(ArchiveFlightPath.progress(atTime: 0.9), 0.9)
    }

    // MARK: Hibernate, the same flight tucked in

    private var tuck: ArchiveFlightPath {
        ArchiveFlightPath(start: path.start, end: path.end, swing: 16, style: .tuck)
    }

    func testTuckStartsAsThePanelAndEndsOnTheMoon() {
        let first = tuck.frame(at: 0)
        XCTAssertEqual(first.position, path.start)
        XCTAssertEqual(first.scale, 1)
        XCTAssertEqual(first.opacity, 1)
        XCTAssertEqual(first.dimming, 0)
        let last = tuck.frame(at: 1)
        XCTAssertEqual(last.position.x, path.end.x, accuracy: 1e-9)
        XCTAssertEqual(last.position.y, path.end.y, accuracy: 1e-9)
        XCTAssertEqual(last.scale, ArchiveFlightPath.smallest, accuracy: 1e-9)
    }

    /// No tilt anywhere: it's put to bed, not dropped.
    func testTuckStaysLevel() {
        for p in stride(from: 0.0, through: 1.0, by: 0.05) {
            XCTAssertEqual(tuck.frame(at: p).tilt, 0)
        }
    }

    /// The lights go down from the start and all the way, where the drop
    /// stays bright until it's nearly there. About 40% just before it lands.
    func testTuckDimsAllTheWayDown() {
        let frames = stride(from: 0.0, through: 1.0, by: 0.05).map { tuck.frame(at: $0) }
        for (a, b) in zip(frames, frames.dropFirst()) {
            XCTAssertLessThan(b.opacity, a.opacity)
            XCTAssertGreaterThan(b.dimming, a.dimming)
        }
        XCTAssertEqual(tuck.frame(at: 0.9).opacity, 0.4, accuracy: 1e-9)
        XCTAssertLessThan(tuck.frame(at: 0.5).opacity, path.frame(at: 0.5).opacity)
        XCTAssertEqual(path.frame(at: 0.5).dimming, 0, "the drop doesn't dim")
    }

    /// Nearly straight down first, then easing across: a smaller swing than
    /// the drop's, so at the same point it's strayed less from the start's
    /// line.
    func testTuckSinksBeforeItEasesAcross() {
        let early = tuck.frame(at: 0.2).position
        XCTAssertGreaterThan(early.x, path.frame(at: 0.2).position.x)
        XCTAssertLessThan(early.y, path.start.y)
    }

    func testTuckShrinksLaterThanTheDrop() {
        XCTAssertGreaterThan(tuck.frame(at: 0.3).scale, path.frame(at: 0.3).scale)
    }

    func testTuckOffTheListGoesOutCompletely() {
        let off = ArchiveFlightPath(start: path.start, end: path.end, swing: 16, onHeading: false, style: .tuck)
        XCTAssertEqual(off.frame(at: 1).opacity, 0, accuracy: 1e-9)
        XCTAssertEqual(tuck.frame(at: 1).opacity, 0.1, accuracy: 1e-9)
    }

    /// A sine, softer through the middle than the drop's cubic.
    func testTuckProgressIsASine() {
        XCTAssertEqual(ArchiveFlightPath.progress(atTime: 0, style: .tuck), 0, accuracy: 1e-9)
        XCTAssertEqual(ArchiveFlightPath.progress(atTime: 0.5, style: .tuck), 0.5, accuracy: 1e-9)
        XCTAssertEqual(ArchiveFlightPath.progress(atTime: 1, style: .tuck), 1, accuracy: 1e-9)
        XCTAssertLessThan(ArchiveFlightPath.progress(atTime: 0.6, style: .tuck), ArchiveFlightPath.progress(atTime: 0.6))
    }
}
