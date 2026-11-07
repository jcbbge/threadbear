import XCTest
@testable import ThreadbearCore

final class CompletionSoundTests: XCTestCase {
    func testDingsWhenAWorkingThreadIsDone() {
        XCTAssertTrue(CompletionSound.finished(from: .running, to: .idle))
        XCTAssertTrue(CompletionSound.finished(from: .running, to: .waiting))
        XCTAssertTrue(CompletionSound.finished(from: .running, to: .error))
        XCTAssertTrue(CompletionSound.finished(from: .starting, to: .idle))
    }

    func testQuietWhenStoppedOrNotWorking() {
        // Whoever stopped it knows.
        XCTAssertFalse(CompletionSound.finished(from: .running, to: .stopped))
        XCTAssertFalse(CompletionSound.finished(from: .running, to: .running))
        XCTAssertFalse(CompletionSound.finished(from: .idle, to: .idle))
        XCTAssertFalse(CompletionSound.finished(from: .waiting, to: .idle))
        // A thread seen for the first time (the app starting) didn't just finish.
        XCTAssertFalse(CompletionSound.finished(from: nil, to: .idle))
    }

    func testEachDingIsASoftWav() {
        for ding in CompletionSound.Ding.allCases {
            let wav = CompletionSound.wav(ding)
            XCTAssertEqual(String(decoding: wav.prefix(4), as: UTF8.self), "RIFF")
            XCTAssertEqual(String(decoding: wav[8..<12], as: UTF8.self), "WAVE")
            let samples = wav.dropFirst(44).withUnsafeBytes { Array($0.bindMemory(to: Int16.self)) }
            XCTAssertFalse(samples.isEmpty)
            let peak = samples.map { abs(Int($0)) }.max() ?? 0
            // Half of full scale, give or take rounding: soft, never clipped.
            XCTAssertEqual(Double(peak) / Double(Int16.max), 0.5, accuracy: 0.01, ding.title)
            // Under a second and a half.
            XCTAssertLessThan(Double(samples.count) / 44_100, 1.6)
        }
    }

    func testAnUnknownSavedDingFallsBackToChime() {
        XCTAssertEqual(CompletionSound.ding("gong"), .chime)
        XCTAssertEqual(CompletionSound.ding("bell"), .bell)
    }
}
