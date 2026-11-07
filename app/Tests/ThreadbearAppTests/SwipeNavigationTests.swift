import AppKit
import XCTest
@testable import Threadbear
@testable import ThreadbearCore

/// Trackpad swipes through the handler the window's monitor calls, with
/// made-up scroll events (RowSwipeEvents).
@MainActor
final class SwipeNavigationTests: XCTestCase {
    private var window: NSWindow!
    private var saved: NSWindow?

    override func setUp() {
        super.setUp()
        _ = NSApplication.shared
        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 600, height: 400), styleMask: [.titled], backing: .buffered, defer: true)
        window.contentView = NSView(frame: NSRect(x: 0, y: 0, width: 600, height: 400))
        saved = MainWindowFrame.window
        MainWindowFrame.window = window
    }

    override func tearDown() {
        MainWindowFrame.window = saved
        super.tearDown()
    }

    private func settle() async {
        await withCheckedContinuation { done in DispatchQueue.main.async { done.resume() } }
    }

    private func app() async -> AppModel {
        let app = AppModel()
        app.notificationsEnabled = false
        for id in ["a", "b"] { app.threads[id] = ThreadSummary(id: id, title: id) }
        app.select("a")
        await settle()
        app.select("b")
        await settle()
        return app
    }

    private func swipeNavigation(_ app: AppModel, on: Bool = true) -> SwipeNavigation {
        let swipes = SwipeNavigation()
        swipes.app = app
        swipes.scrollSwipesOn = { on }
        return swipes
    }

    /// `moves` are the fingers' way, right and down positive; returns
    /// whether each event was taken, the lift's last.
    @discardableResult
    private func gesture(_ swipes: SwipeNavigation, _ moves: [(Double, Double)]) -> [Bool] {
        var taken: [Bool] = []
        for (i, move) in moves.enumerated() {
            guard let event = RowSwipeEvents.event(dx: move.0, dy: move.1, phase: i == 0 ? .began : .changed) else { XCTFail("no event"); return taken }
            taken.append(swipes.handle(event, in: window))
        }
        if let end = RowSwipeEvents.event(dx: 0, phase: .ended) { taken.append(swipes.handle(end, in: window)) }
        return taken
    }

    func testSwipeRightGoesBackAndLeftForward() async {
        let app = await app()
        let swipes = swipeNavigation(app)
        let taken = gesture(swipes, [(3, 0), (20, 0), (40, 0), (40, 0), (20, 0)])
        XCTAssertEqual(app.selection, "a")
        XCTAssertEqual(taken, [true, true, true, true, true, true], "the view under the pointer gets none of it")
        gesture(swipes, [(-3, 0), (-20, 0), (-40, 0), (-40, 0), (-20, 0)])
        XCTAssertEqual(app.selection, "b")
    }

    /// The arrow's state follows the fingers, and goes when they lift.
    func testTheArrowFollowsAndFillsAtTheLine() async {
        let app = await app()
        let swipes = swipeNavigation(app)
        func move(_ dx: Double, _ phase: RowSwipeEvents.Phase) { _ = RowSwipeEvents.event(dx: dx, phase: phase).map { swipes.handle($0, in: window) } }
        move(8, .began)
        XCTAssertEqual(swipes.swipe.direction, .back)
        XCTAssertFalse(swipes.swipe.armed)
        move(120, .changed)
        XCTAssertTrue(swipes.swipe.armed)
        XCTAssertEqual(app.selection, "b", "not until the fingers lift")
        move(0, .ended)
        XCTAssertNil(swipes.swipe.direction)
        XCTAssertEqual(app.selection, "a")
    }

    func testShortSwipeGoesNowhere() async {
        let app = await app()
        let swipes = swipeNavigation(app)
        gesture(swipes, [(3, 0), (5, 0), (5, 0)])
        XCTAssertEqual(app.selection, "b")
    }

    /// Nothing to go forward to: a swipe left is left to whatever's under it.
    func testNowhereToGoLeavesTheEventsAlone() async {
        let app = await app()
        let swipes = swipeNavigation(app)
        let taken = gesture(swipes, [(-8, 0), (-40, 0), (-40, 0)])
        XCTAssertEqual(taken, [false, false, false, false])
        XCTAssertEqual(app.selection, "b")
    }

    /// Up and down goes to the view from the first few points.
    func testUpAndDownScrolls() async {
        let app = await app()
        let swipes = swipeNavigation(app)
        XCTAssertEqual(gesture(swipes, [(0, 5), (1, 20), (30, 20)]), [false, false, false, false])
        XCTAssertEqual(app.selection, "b")
    }

    /// Momentum after a swipe is the swipe's, or the thread it landed on
    /// would scroll.
    func testMomentumAfterASwipeIsEaten() async {
        let app = await app()
        let swipes = swipeNavigation(app)
        gesture(swipes, [(8, 0), (120, 0)])
        guard let cg = CGEvent(scrollWheelEvent2Source: nil, units: .pixel, wheelCount: 2, wheel1: 0, wheel2: 0, wheel3: 0) else { return XCTFail("no event") }
        cg.setIntegerValueField(.scrollWheelEventIsContinuous, value: 1)
        cg.setIntegerValueField(.scrollWheelEventMomentumPhase, value: 2)
        guard let momentum = NSEvent(cgEvent: cg) else { return XCTFail("no event") }
        XCTAssertTrue(swipes.handle(momentum, in: window))
    }

    func testOffInSystemSettings() async {
        let app = await app()
        let swipes = swipeNavigation(app, on: false)
        XCTAssertFalse(swipes.takesBack)
        gesture(swipes, [(8, 0), (40, 0), (80, 0)])
        XCTAssertEqual(app.selection, "b")
    }

    /// A real trackpad says when the fingers touch, before any movement. A
    /// scroll view given that has the gesture for good, so it's held, and
    /// handed on only when it's a scroll or they lift without moving.
    func testFingersTouchingIsHeldUntilItsClear() async {
        let app = await app()
        let swipes = swipeNavigation(app)
        func send(_ dx: Double, _ dy: Double, _ phase: RowSwipeEvents.Phase) -> Bool {
            RowSwipeEvents.event(dx: dx, dy: dy, phase: phase).map { swipes.handle($0, in: window) } ?? false
        }
        XCTAssertTrue(send(0, 0, .mayBegin))
        XCTAssertTrue(send(0, 0, .began))
        XCTAssertTrue(send(8, 0, .changed))
        XCTAssertEqual(swipes.swipe.direction, .back, "the touch didn't restart it")
        XCTAssertTrue(send(120, 0, .changed))
        XCTAssertTrue(send(0, 0, .ended))
        XCTAssertEqual(app.selection, "a")

        XCTAssertTrue(send(0, 0, .mayBegin))
        XCTAssertFalse(send(0, 0, .cancelled), "lifted without moving")
        XCTAssertEqual(swipes.swipe.phase, .idle)

        XCTAssertTrue(send(0, 0, .mayBegin))
        XCTAssertTrue(send(0, 0, .began))
        XCTAssertFalse(send(0, 9, .changed), "a scroll")
    }

    /// After a scroll the view took (no end ever gets here), or a start it
    /// took, the next gesture still swipes: on Tinker Desk the first
    /// movement of a swipe after a scroll came with no start (7 Nov).
    func testASwipeWhoseStartWasMissedStillSwipes() async {
        let app = await app()
        let swipes = swipeNavigation(app)
        func send(_ dx: Double, _ dy: Double, _ phase: RowSwipeEvents.Phase, at time: TimeInterval) -> Bool {
            guard let cg = RowSwipeEvents.event(dx: dx, dy: dy, phase: phase)?.cgEvent else { return false }
            cg.timestamp = CGEventTimestamp(time * 1_000_000_000)
            return NSEvent(cgEvent: cg).map { swipes.handle($0, in: window) } ?? false
        }
        _ = send(0, 0, .began, at: 100)
        XCTAssertFalse(send(0, 9, .changed, at: 100.01), "a scroll, which the view now has")
        XCTAssertEqual(swipes.swipe.phase, .ignoring)
        XCTAssertFalse(send(1, 9, .changed, at: 100.03), "still that scroll")
        XCTAssertTrue(send(8, 0, .changed, at: 101), "a new gesture")
        XCTAssertEqual(swipes.swipe.direction, .back)
        XCTAssertTrue(send(120, 0, .changed, at: 101.01))
        XCTAssertTrue(send(0, 0, .ended, at: 101.02))
        XCTAssertEqual(app.selection, "a")
        XCTAssertTrue(swipes.swipe.phase == .idle)
    }

    /// The gesture moves to another window (a sheet opening over this one):
    /// nothing's left held or half done here.
    func testAnotherWindowTakingTheGestureEndsIt() async {
        let app = await app()
        let swipes = swipeNavigation(app)
        let other = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 200, height: 200), styleMask: [.titled], backing: .buffered, defer: true)
        guard let down = RowSwipeEvents.event(dx: 8, phase: .began), let more = RowSwipeEvents.event(dx: 8, phase: .changed) else { return XCTFail("no event") }
        XCTAssertTrue(swipes.handle(down, in: window))
        XCTAssertEqual(swipes.swipe.direction, .back)
        XCTAssertFalse(swipes.handle(more, in: other))
        XCTAssertEqual(swipes.swipe.phase, .idle)
    }

    /// A row half way through a gesture whose lift it never heard about
    /// doesn't take a later gesture elsewhere as its own, and doesn't archive.
    func testARowDoesntArchiveFromAGestureElsewhere() {
        var archived = false
        let row = RowSwipeController()
        row.action = RowSwipeAction(icon: "archivebox", run: { archived = true })
        row.setWidth(300)
        row.setHovered(true)
        func send(_ dx: Double, _ dy: Double, _ phase: RowSwipeEvents.Phase) -> Bool {
            RowSwipeEvents.event(dx: dx, dy: dy, phase: phase).map { row.handle($0) } ?? false
        }
        // Left the row in the middle of deciding: the list took the rest.
        _ = send(0, 1, .began)
        row.setHovered(false)
        XCTAssertEqual(row.swipe.phase, .idle)

        // Armed when the app lost the lift, then a new gesture elsewhere.
        row.setHovered(true)
        _ = send(-8, 0, .began)
        _ = send(-150, 0, .changed)
        XCTAssertTrue(row.swipe.armed)
        row.setHovered(false)
        XCTAssertFalse(send(0, 0, .began))
        XCTAssertEqual(row.swipe.phase, .idle)
        XCTAssertFalse(send(0, 9, .changed))
        XCTAssertFalse(send(0, 0, .ended))
        XCTAssertFalse(archived)
        row.stop()
    }

    /// Only the main window's swipes navigate.
    func testOtherWindowsKeepTheirSwipes() async {
        let app = await app()
        let swipes = swipeNavigation(app)
        let other = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 200, height: 200), styleMask: [.titled], backing: .buffered, defer: true)
        guard let event = RowSwipeEvents.event(dx: 8, phase: .began) else { return XCTFail("no event") }
        XCTAssertFalse(swipes.handle(event, in: other))
    }
}
