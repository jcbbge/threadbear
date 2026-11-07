import Observation
import XCTest
import ThreadbearCore
@testable import Threadbear

/// `sections` and `projectSections` are built once per change and kept, not
/// built again for every view that reads them. They must still follow every
/// change, and still tell the views reading them to redraw.
@MainActor
final class DerivedSectionsTests: XCTestCase {
    func testSectionsFollowEveryChange() {
        let app = AppModel()
        app.threads["a"] = ThreadSummary(id: "a", title: "One", status: .idle)
        XCTAssertEqual(app.sections.inbox.map(\.id), ["a"])
        app.threads["b"] = ThreadSummary(id: "b", title: "Two", status: .running)
        XCTAssertEqual(app.sections.running.map(\.id), ["b"])
        app.threads["a"]?.status = .running
        XCTAssertEqual(Set(app.sections.running.map(\.id)), ["a", "b"])
        XCTAssertTrue(app.sections.inbox.isEmpty)
    }

    #if DEBUG
    /// A thread update on a full sidebar sorts every thread once, however
    /// many things want the result, the Dock badge included (THREADBEAR-1B).
    func testAThreadUpdateBuildsTheSectionsOnce() {
        let app = AppModel()
        app.threads["a"] = ThreadSummary(id: "a", title: "One", status: .waiting)
        let before = ThreadSections.buildCount
        app.threads["a"]?.preview = "Working"
        for _ in 0..<3 { _ = app.sections.inbox.count }
        XCTAssertEqual(ThreadSections.buildCount - before, 1)
    }
    #endif

    func testThreadOwningAPanelFollowsTheThreads() {
        let app = AppModel()
        app.threads["a"] = ThreadSummary(id: "a", title: "One")
        XCTAssertNil(app.threadOwning(panel: "p"))
        app.threads["a"]?.panels = [Panel(id: "p", title: "Panel", url: "http://localhost/")]
        XCTAssertEqual(app.threadOwning(panel: "p")?.id, "a")
        app.threads["a"]?.title = "Renamed"
        XCTAssertEqual(app.threadOwning(panel: "p")?.title, "Renamed", "the thread as it is now, not as it was when the panel was first found")
        app.threads["a"]?.panels = []
        XCTAssertNil(app.threadOwning(panel: "p"))
    }

    /// What a hang report says about the Mac, for telling a freeze from a
    /// napped app on an overloaded machine with nobody there.
    func testAHangRecordsTheStateOfTheMac() throws {
        let context = HangWatch.currentContext(mainThread: pthread_mach_thread_np(pthread_self()))
        XCTAssertGreaterThan(try XCTUnwrap(context.mainPriority), 0)
        XCTAssertGreaterThanOrEqual(try XCTUnwrap(context.loadAverage), 0)
        XCTAssertGreaterThanOrEqual(try XCTUnwrap(context.idleSeconds), 0)
        let old = #"{"at":"2026-11-07T02:14:29Z","build":"fa772646"}"#
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        let record = try decoder.decode(HangWatch.Record.self, from: Data(old.utf8))
        XCTAssertNil(record.context)
        // Sentry only takes plain JSON: a record without the numbers leaves
        // them out rather than sending an empty optional.
        let without = record.extras(frames: ["f"])
        XCTAssertTrue(JSONSerialization.isValidJSONObject(without))
        XCTAssertNil(without["mainPriority"])
        var with = record
        with.context = HangWatch.Context(mainPriority: 4, loadAverage: 61.5, idleSeconds: 2000.5)
        let extras = with.extras(frames: ["f"])
        XCTAssertTrue(JSONSerialization.isValidJSONObject(extras))
        XCTAssertEqual(extras["mainPriority"] as? Int, 4)
        XCTAssertEqual(extras["loadAverage"] as? Double, 61.5)
        XCTAssertEqual(extras["idleSeconds"] as? Int, 2000)
    }

    func testProjectSectionsFollowProjectsAndThreads() {
        let app = AppModel()
        app.projects = [Project(id: "p", title: "Poddle")]
        XCTAssertEqual(app.projectSections.sections.map(\.project.title), ["Poddle"])
        app.threads["a"] = ThreadSummary(id: "a", title: "One", projects: [ThreadProject(id: "p", title: "Poddle")])
        XCTAssertEqual(app.projectSections.sections.first?.threads.map(\.id), ["a"])
        app.projects = [Project(id: "p", title: "Poddle 2")]
        XCTAssertEqual(app.projectSections.sections.map(\.project.title), ["Poddle 2"])
    }

    func testAReaderIsToldOfAThreadChangeEvenWhenTheMemoServedIt() {
        let app = AppModel()
        app.threads["a"] = ThreadSummary(id: "a", title: "One", status: .idle)
        _ = app.sections // fills the memo, so the read below hits it
        var told = false
        withObservationTracking { _ = app.sections } onChange: { told = true }
        app.threads["a"]?.preview = "Working"
        XCTAssertTrue(told)
        told = false
        withObservationTracking { _ = app.projectSections } onChange: { told = true }
        app.threads["a"]?.preview = "Still working"
        XCTAssertTrue(told)
    }
}
