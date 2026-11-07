import XCTest
@testable import ThreadbearCore

final class DenLinesTests: XCTestCase {
    private var calendar: Calendar {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "Australia/Perth")!
        return calendar
    }

    private func at(_ day: Int, month: Int = 11, hour: Int = 12) -> Date {
        calendar.date(from: DateComponents(year: 2026, month: month, day: day, hour: hour))!
    }

    private func thread(_ id: String, _ created: Date) -> ThreadSummary {
        ThreadSummary(id: id, title: "", status: .idle, createdAt: created, updatedAt: created)
    }

    private let now = Date(timeIntervalSince1970: 1_793_000_000)

    func testTheRealNumbers() {
        var threads = [thread("a", at(26, month: 10)), thread("b", at(4)), thread("c", at(4)), thread("d", at(5))]
        threads[3].snoozedUntil = now.addingTimeInterval(3600)
        XCTAssertEqual(DenLines.make(threads, now: now, calendar: calendar), [
            "4 threads since 26 Oct.",
            "Busiest day: 4 Nov, 2 threads. Sorry.",
            "1 hibernating. Snoring, mostly.",
        ])
    }

    func testBigNumbersGetTheirComma() {
        let threads = (0..<1004).map { thread("t\($0)", at(4)) }
        XCTAssertEqual(DenLines.make(threads, now: now, calendar: calendar).first, "1,004 threads since 4 Nov.")
    }

    func testNothingToSayIsLeftOut() {
        XCTAssertEqual(DenLines.make([], now: now, calendar: calendar), [])
        // One thread hasn't got a busiest day worth apologising for, and
        // an archived one that was hibernating isn't still snoring.
        var only = thread("a", at(4))
        only.snoozedUntil = now.addingTimeInterval(3600)
        only.archivedAt = now
        XCTAssertEqual(DenLines.make([only], now: now, calendar: calendar), ["1 thread since 4 Nov."])
    }

    func testDaysAreLocalNotUTC() {
        // 11 pm and 1 am in Perth are different days, whatever UTC says.
        let threads = [thread("a", at(4, hour: 23)), thread("b", at(5, hour: 1)), thread("c", at(5, hour: 2))]
        XCTAssertTrue(DenLines.make(threads, now: now, calendar: calendar).contains("Busiest day: 5 Nov, 2 threads. Sorry."))
    }

    func testTheTourSamplesDontCount() {
        var sample = thread("s", at(1))
        sample.sample = true
        XCTAssertEqual(DenLines.make([sample, thread("a", at(4))], now: now, calendar: calendar).first, "1 thread since 4 Nov.")
    }

    func testTheBuildLine() {
        XCTAssertEqual(DenLines.build(short: "fa772646", builtAt: "2026-11-07T02:00:00Z", calendar: calendar), "Stitched together from fa772646 on 7 Nov.")
        // As build-app.sh writes it.
        XCTAssertEqual(DenLines.build(short: "fa772646", builtAt: "2026-11-07T02:00:00+00:00", calendar: calendar), "Stitched together from fa772646 on 7 Nov.")
        XCTAssertEqual(DenLines.build(short: "fa772646", builtAt: "not a date", calendar: calendar), "Stitched together from fa772646.")
        XCTAssertNil(DenLines.build(short: "", builtAt: "", calendar: calendar))
    }
}
