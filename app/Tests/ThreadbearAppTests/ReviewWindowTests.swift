import AppKit
import SwiftUI
import XCTest
@testable import Threadbear
import ThreadbearCore

/// Real mouse events through a real window: SwiftUI buttons over AppKit
/// views have swallowed clicks here before (Mike, 29 and 30 Oct), and a test
/// that only checked hit testing passed while the click did nothing.
@MainActor
final class ReviewWindowTests: XCTestCase {
    func testItOpensOnTheFirstAndStepsThroughEveryShotToAllOfThem() {
        let (session, host, window) = make()
        defer { window.close() }
        XCTAssertEqual(session.mode, .single, "a walkthrough, one at a time")
        XCTAssertEqual(at(session), ["A", "0"])
        XCTAssertFalse(session.canStepBack, "nothing before the first")
        click("Next (\u{2192})", in: host, window)
        XCTAssertEqual(at(session), ["A", "1"], "A's own shots come first")
        click("Next (\u{2192})", in: host, window)
        click("Next (\u{2192})", in: host, window)
        XCTAssertEqual(at(session), ["B", "0"])
        click("Next (\u{2192})", in: host, window)
        XCTAssertEqual(at(session), ["B", "1"])
        click("Next (\u{2192})", in: host, window)
        click("Next (\u{2192})", in: host, window)
        XCTAssertEqual(at(session), ["Today", "0"], "a reference is a step too")
        click("Next (\u{2192})", in: host, window)
        click("See them all and choose (\u{2192})", in: host, window)
        XCTAssertEqual(session.mode, .all, "it ends on all of them, to choose")
        XCTAssertFalse(session.canStepForward)
        click("Back to the last one (\u{2190})", in: host, window)
        XCTAssertEqual(at(session), ["Today", "1"])
        click("Previous (\u{2190})", in: host, window)
        click("Previous (\u{2190})", in: host, window)
        XCTAssertEqual(at(session), ["C", "0"])
        click("Previous (\u{2190})", in: host, window)
        XCTAssertEqual(at(session), ["B", "1"], "back into B's last shot")
        click("Previous (\u{2190})", in: host, window)
        click("Previous (\u{2190})", in: host, window)
        XCTAssertEqual(at(session), ["A", "2"])
    }

    func testUpAndDownJumpBetweenOptionsPastTheirShots() {
        let (session, _, window) = make()
        defer { window.close() }
        session.browse(1)
        session.jump(1)
        XCTAssertEqual(at(session), ["B", "0"])
        session.jump(-1)
        XCTAssertEqual(at(session), ["A", "0"])
        session.jump(1); session.jump(1); session.jump(1)
        session.jump(1)
        XCTAssertEqual(session.mode, .all, "down from the last is all of them")
    }

    func testAMarkOrAShotGoesStraightToIt() {
        let (session, host, window) = make()
        defer { window.close() }
        click("C. Option C", in: host, window)
        XCTAssertEqual(at(session), ["C", "0"])
        click("A. Option A, Mid-drag", in: host, window)
        XCTAssertEqual(at(session), ["A", "1"], "a mark under the stage")
        click("A. Option A, Detail", in: host, window)
        XCTAssertEqual(at(session), ["A", "2"])
        click("See them all and choose (Esc)", in: host, window)
        XCTAssertEqual(session.mode, .all)
    }

    func testClickingAnyRowInTheRailShowsItReferencesToo() {
        let (session, host, window) = make()
        defer { window.close() }
        click("Show Today", in: host, window)
        XCTAssertEqual(at(session), ["Today", "0"], "a reference row used to do nothing")
        XCTAssertTrue(session.draft.pickedIds.isEmpty, "showing isn't picking")
        session.showAll()
        pump()
        click("Show B", in: host, window)
        XCTAssertEqual(at(session), ["B", "0"], "from all of them too")
    }

    func testSeveralCanBePickedAndStayInTheirOrder() {
        let (session, host, window) = make()
        defer { window.close() }
        click("Pick C", in: host, window)
        click("Pick A", in: host, window)
        XCTAssertEqual(session.draft.pickedIds, ["A", "C"])
        XCTAssertEqual(session.sendLabel, "Send A + C")
        XCTAssertEqual(at(session), ["A", "0"], "picking doesn't move the stage")
        click("Unpick C", in: host, window)
        XCTAssertEqual(session.draft.pickedIds, ["A"])
        XCTAssertNil(anchor("Pick Today", in: host), "a reference can't be picked")
    }

    func testNoneTakesThePicksAwayAndAPickTakesNoneAway() {
        let (session, host, window) = make()
        defer { window.close() }
        click("Pick B", in: host, window)
        click("None of them will do", in: host, window)
        XCTAssertTrue(session.draft.none)
        XCTAssertTrue(session.draft.pickedIds.isEmpty)
        XCTAssertEqual(session.sendLabel, "Send none of them")
        XCTAssertTrue(session.canSubmit)
        click("Pick B", in: host, window)
        XCTAssertFalse(session.draft.none)
    }

    func testOneReplyBoxAndSendSaysWhatItWillSend() {
        let (session, _, window) = make()
        defer { window.close() }
        XCTAssertFalse(session.canSubmit)
        XCTAssertEqual(session.sendLabel, "Send")
        session.setReply("Can you explain what these are for?")
        XCTAssertEqual(session.sendLabel, "Send reply")
        XCTAssertTrue(session.canSubmit, "words alone are an answer")
        session.pick("C")
        XCTAssertEqual(session.sendLabel, "Send C")
    }

    func testTheStageSaysWhichShotAndOffersTheLiveOne() {
        let (session, host, window) = make()
        defer { window.close() }
        XCTAssertNotNil(anchor("Try A running live: http://localhost:5190/a", in: host))
        click("C. Option C", in: host, window)
        XCTAssertNil(anchor("Try A running live: http://localhost:5190/a", in: host))
        XCTAssertEqual(session.focusedShot?.image.path, "/tmp/C.png", "one image is one shot")
    }

    func testTodayCanBeFlickedToByItsButtonOrHoldingSpace() {
        let (session, host, window) = make(native: true)
        defer { window.close() }
        session.enlarge(0, shot: 1)
        pump()
        click("Flick to Today: click, or hold Space", in: host, window)
        XCTAssertEqual(session.shownOption?.id, "Today")
        XCTAssertEqual(session.shownShot?.image.path, "/tmp/today2.png", "today's shot of the same name")
        XCTAssertEqual(at(session), ["A", "1"], "flicking isn't moving")
        click("Back to A (or let go of Space)", in: host, window)
        XCTAssertEqual(session.shownOption?.id, "A")
        func space(_ type: NSEvent.EventType) {
            window.sendEvent(NSEvent.keyEvent(with: type, location: .zero, modifierFlags: [], timestamp: 0, windowNumber: window.windowNumber,
                                              context: nil, characters: " ", charactersIgnoringModifiers: " ", isARepeat: false, keyCode: 49)!)
            pump()
        }
        space(.keyDown)
        XCTAssertTrue(session.peeking)
        space(.keyUp)
        XCTAssertFalse(session.peeking)
        session.enlarge(1, shot: 1)
        XCTAssertEqual(session.peeking, false)
        session.peeking = true
        XCTAssertEqual(session.shownShot?.image.path, "/tmp/today.png", "no shot of that name: today's first")
        session.browse(1)
        XCTAssertFalse(session.peeking, "moving turns it off")
        session.enlarge(3)
        pump()
        XCTAssertNil(anchor("Flick to Today: click, or hold Space", in: host), "nothing to flick to from today itself")
    }

    func testClickingAnImageEnlargesItAndAgainGoesBack() {
        let (session, host, window) = make()
        defer { window.close() }
        session.showAll()
        pump()
        click("C: click to enlarge", in: host, window)
        XCTAssertEqual(session.mode, .single)
        XCTAssertEqual(at(session), ["C", "0"])
        click("C: click to see them all, scroll to zoom", in: host, window)
        XCTAssertEqual(session.mode, .all)
    }

    func testASentReviewHasNothingToPress() async {
        var answered = review()
        answered.status = "answered"
        answered.response = ReviewDraft(pickedIds: ["A", "C"], notes: ["C": "Fainter"], reply: "Both")
        let (session, host, window) = make(answered)
        defer { window.close() }
        XCTAssertEqual(session.mode, .all, "nothing left to step towards")
        XCTAssertNil(anchor("Pick B", in: host))
        XCTAssertNil(anchor("Unpick C", in: host))
        XCTAssertNil(anchor("None of them will do", in: host))
        XCTAssertEqual(noteBoxes(in: host), 0, "the reply is shown as text, not a box that can't be typed in")
    }

    func testAWheelZoomsAndZoomedInPressesDragNotGoBack() {
        let (session, host, window) = make(tall())
        defer { window.close() }
        let image = stage(in: host)
        XCTAssertTrue(image.isFittedForTests)
        XCTAssertEqual(image.pictureSizeForTests.height, 20852 / window.backingScaleFactor, "a point per screen pixel (two pixels on Retina)")
        let fit = image.magnification
        XCTAssertLessThan(fit, 0.1, "the whole page fits")

        image.scrollWheel(with: wheel(lines: 5))
        pump()
        XCTAssertGreaterThan(image.magnification, fit * 2)
        XCTAssertTrue(session.zoomed, "the title bar's button reads this")

        // A press on the image used to go back to all of them.
        let at = image.convert(NSPoint(x: image.bounds.midX, y: image.bounds.midY), to: nil)
        press(.leftMouseDown, at, window)
        press(.leftMouseUp, at, window)
        pump()
        XCTAssertEqual(session.mode, .single)

        image.scrollWheel(with: wheel(lines: -40))
        pump()
        XCTAssertEqual(image.magnification, fit, accuracy: 0.0001, "it stops at the whole page")
        XCTAssertFalse(session.zoomed)
    }

    func testZoomingKeepsTheSpotUnderThePointerUnderIt() {
        let (session, host, window) = make(wide())
        defer { window.close() }
        let image = stage(in: host)
        session.zoom(.actual)
        pump()
        let pointer = image.convert(NSPoint(x: image.bounds.midX + 150, y: image.bounds.midY - 100), to: nil)
        let before = image.contentView.convert(pointer, from: nil)
        image.zoom(by: 1.5, around: pointer)
        pump()
        let after = image.contentView.convert(pointer, from: nil)
        XCTAssertEqual(after.x, before.x, accuracy: 1)
        XCTAssertEqual(after.y, before.y, accuracy: 1)
    }

    func testDraggingMovesAroundAndTheImageFollowsTheHand() {
        // Narrow enough to stay centred on a 1x display as well as Retina.
        let (session, host, window) = make(tall(width: 300))
        defer { window.close() }
        let image = stage(in: host)
        session.zoom(.actual)
        pump()
        XCTAssertEqual(image.magnification, 1, accuracy: 0.0001)
        XCTAssertEqual(image.visibleForTests.minY, 0, accuracy: 1, "full size starts at the top of the page")
        XCTAssertLessThan(image.visibleForTests.minX, 0, "narrower than the stage, so it's in the middle")
        XCTAssertEqual(image.visibleForTests.midX, image.pictureSizeForTests.width / 2, accuracy: 1)

        let from = image.convert(NSPoint(x: image.bounds.midX, y: image.bounds.midY), to: nil)
        press(.leftMouseDown, from, window)
        // Up the screen, in AppKit's points: the page goes up, so further down it.
        press(.leftMouseDragged, NSPoint(x: from.x, y: from.y + 200), window)
        press(.leftMouseUp, NSPoint(x: from.x, y: from.y + 200), window)
        pump()
        XCTAssertEqual(image.visibleForTests.minY, 200, accuracy: 1)
    }

    func testATrackpadScrollZoomsFromFitAndScrollsOnceZoomed() {
        let (session, host, window) = make(tall())
        defer { window.close() }
        let image = stage(in: host)
        let fit = image.magnification
        image.scrollWheel(with: swipe(.began, 40))
        image.scrollWheel(with: swipe(.changed, 40))
        pump()
        let zoomedIn = image.magnification
        XCTAssertGreaterThan(zoomedIn, fit, "nothing to scroll while it fits")
        let top = image.visibleForTests.minY
        // The same swipe stays a zoom right through, however far it's gone.
        image.scrollWheel(with: swipe(.changed, 20))
        XCTAssertGreaterThan(image.magnification, zoomedIn)
        XCTAssertTrue(session.zoomed)

        let scale = image.magnification
        image.scrollWheel(with: swipe(.ended, 0))
        image.scrollWheel(with: swipe(.began, -60))
        image.scrollWheel(with: swipe(.changed, -60))
        pump()
        XCTAssertEqual(image.magnification, scale, accuracy: 0.0001, "the next swipe moves around")
        XCTAssertNotEqual(image.visibleForTests.minY, top)
    }

    func testASwipeEitherWayZoomsInFromFit() {
        let (_, host, window) = make(tall())
        defer { window.close() }
        let image = stage(in: host)
        let fit = image.magnification
        image.scrollWheel(with: swipe(.began, -40))
        image.scrollWheel(with: swipe(.changed, -40))
        XCTAssertGreaterThan(image.magnification, fit, "natural scrolling's swipe up")
    }

    func testTheMinimapShowsThePartOnShowAndGoesWhereItsPressed() {
        let (session, host, window) = make(tall())
        defer { window.close() }
        let image = stage(in: host)
        XCTAssertTrue(image.minimap.isHidden, "the whole image is on show")
        session.zoom(.actual)
        pump()
        XCTAssertFalse(image.minimap.isHidden)
        XCTAssertEqual(image.minimap.shown.minY, 0, accuracy: 0.001)
        let map = image.minimap
        let middle = map.convert(NSPoint(x: map.bounds.midX, y: map.bounds.midY), to: nil)
        press(.leftMouseDown, middle, window)
        press(.leftMouseUp, middle, window)
        pump()
        XCTAssertEqual(image.visibleForTests.midY, image.pictureSizeForTests.height / 2, accuracy: 2, "halfway down the page")
        XCTAssertEqual(session.mode, .single)
        session.zoom(.fit)
        pump()
        XCTAssertTrue(image.minimap.isHidden)
    }

    func testMovingToAnotherShotFitsItAndAFlickStaysOnTheSamePart() {
        let (session, host, window) = make(tall())
        defer { window.close() }
        let image = stage(in: host)
        session.zoom(.actual)
        pump()
        image.scrollWheel(with: wheel(lines: 1))
        let scale = image.magnification
        image.contentView.scroll(to: NSPoint(x: image.visibleForTests.minX, y: 5000))
        pump()
        session.peeking = true
        pump()
        XCTAssertEqual(session.shownOption?.id, "Today")
        XCTAssertEqual(image.magnification, scale, accuracy: 0.0001, "flicking keeps the zoom")
        XCTAssertEqual(image.visibleForTests.minY, 5000, accuracy: 20, "and the place")
        session.peeking = false
        pump()
        session.browse(1)
        pump()
        XCTAssertTrue(image.isFittedForTests, "a new shot starts whole")
        XCTAssertFalse(session.zoomed)
    }

    func testTheZoomKeysAndEscOnAShotLeaveTheAppsZoomAlone() {
        let (session, host, window) = make(tall(), native: true)
        defer { window.close() }
        let image = stage(in: host)
        let fit = image.magnification
        window.sendEvent(key("=", modifiers: .command, code: 24))
        pump()
        XCTAssertGreaterThan(image.magnification, fit)
        XCTAssertTrue(session.zoomed)
        window.keyDown(with: key("\u{1B}", modifiers: [], code: 53))
        pump()
        XCTAssertEqual(session.mode, .single, "Esc comes out of the zoom first")
        XCTAssertFalse(session.zoomed)
        window.keyDown(with: key("\u{1B}", modifiers: [], code: 53))
        XCTAssertEqual(session.mode, .all)
    }

    /// A page as long as the phone shots that prompted zooming, with today's
    /// version of the same size to flick to, and a shot after it to move to.
    private func tall(width: Int = 780) -> DesignReview {
        func image(_ name: String) -> ImageRef { ImageRef(path: "/tmp/\(name).png", mediaType: "image/png", width: width, height: 20852) }
        var page = ReviewOption(id: "A", title: "Option A", image: image("A"))
        page.shots = [ReviewShot(title: "Phone", image: image("A")), ReviewShot(title: "Top", image: image("A2"))]
        return DesignReview(id: "review", title: "Page", options: [
            page,
            ReviewOption(id: "Today", title: "Today", reference: true, image: image("today")),
        ])
    }

    /// Too big for the stage both ways, so zooming has room in every direction.
    private func wide() -> DesignReview {
        DesignReview(id: "review", title: "Page", options: [
            ReviewOption(id: "A", title: "Option A", image: ImageRef(path: "/tmp/A.png", mediaType: "image/png", width: 6000, height: 6000)),
        ])
    }

    private func stage(in host: NSView) -> ReviewImageScroll {
        Automation.all(ReviewImageScroll.self, in: host)[0]
    }

    /// A notched mouse wheel, as lines with no finer deltas.
    private func wheel(lines: Int32) -> NSEvent {
        NSEvent(cgEvent: CGEvent(scrollWheelEvent2Source: nil, units: .line, wheelCount: 1, wheel1: lines, wheel2: 0, wheel3: 0)!)!
    }

    /// Part of a two-finger swipe on a trackpad.
    private func swipe(_ phase: RowSwipeEvents.Phase, _ points: Double) -> NSEvent {
        let event = CGEvent(scrollWheelEvent2Source: nil, units: .pixel, wheelCount: 1, wheel1: 0, wheel2: 0, wheel3: 0)!
        event.setIntegerValueField(.scrollWheelEventIsContinuous, value: 1)
        event.setIntegerValueField(.scrollWheelEventScrollPhase, value: phase.rawValue)
        event.setDoubleValueField(.scrollWheelEventPointDeltaAxis1, value: points)
        event.setDoubleValueField(.scrollWheelEventFixedPtDeltaAxis1, value: points)
        return NSEvent(cgEvent: event)!
    }

    private func press(_ type: NSEvent.EventType, _ point: NSPoint, _ window: NSWindow) {
        window.sendEvent(NSEvent.mouseEvent(with: type, location: point, modifierFlags: [], timestamp: ProcessInfo.processInfo.systemUptime,
                                            windowNumber: window.windowNumber, context: nil, eventNumber: 0, clickCount: 1,
                                            pressure: type == .leftMouseUp ? 0 : 1)!)
    }

    private func key(_ characters: String, modifiers: NSEvent.ModifierFlags, code: UInt16) -> NSEvent {
        NSEvent.keyEvent(with: .keyDown, location: .zero, modifierFlags: modifiers, timestamp: 0, windowNumber: 0,
                         context: nil, characters: characters, charactersIgnoringModifiers: characters, isARepeat: false, keyCode: code)!
    }

    private func review() -> DesignReview {
        func image(_ name: String) -> ImageRef { ImageRef(path: "/tmp/\(name).png", mediaType: "image/png") }
        var options = ["A", "B", "C"].map {
            ReviewOption(id: $0, title: "Option \($0)", note: "Why \($0)", image: image($0))
        }
        // A has three shots and runs live; B has two, untitled.
        options[0].shots = [ReviewShot(title: "Overview", image: image("A")), ReviewShot(title: "Mid-drag", image: image("A2")), ReviewShot(title: "Detail", image: image("A3"))]
        options[0].url = "http://localhost:5190/a"
        options[1].shots = [ReviewShot(image: image("B")), ReviewShot(image: image("B2"))]
        // A reference: to look at, not to pick.
        options.append(ReviewOption(id: "Today", title: "Today", reference: true, image: image("today"),
                                    shots: [ReviewShot(title: "Overview", image: image("today")), ReviewShot(title: "Mid-drag", image: image("today2"))]))
        return DesignReview(id: "review", title: "Rail", options: options)
    }

    /// The option on show and its shot.
    private func at(_ session: ReviewSession) -> [String] {
        [session.focusedOption?.id ?? "", String(session.shot)]
    }

    private func make(_ given: DesignReview? = nil, native: Bool = false) -> (ReviewSession, NSView, NSWindow) {
        let review = given ?? review()
        let service = ReviewService(load: { review }, save: { _, _ in review }, respond: { _, _ in review }, cancel: { _ in review })
        let session = ReviewSession(threadId: "thread", review: review, service: service,
                                    defaults: UserDefaults(suiteName: "ReviewWindowTests.\(UUID().uuidString)")!, autosave: false)
        let host = NSHostingView(rootView: ReviewWindow(session: session, back: {}, close: {}))
        // The review's own window class where its keys matter.
        let frame = NSRect(x: 0, y: 0, width: 1100, height: 760)
        let window: NSWindow
        if native {
            let reviewWindow = ReviewNativeWindow(contentRect: frame, styleMask: [.titled], backing: .buffered, defer: false)
            reviewWindow.reviewSession = session
            window = reviewWindow
        } else {
            window = NSWindow(contentRect: frame, styleMask: [.titled], backing: .buffered, defer: false)
        }
        window.isReleasedWhenClosed = false
        window.contentView = host
        // SwiftUI's Buttons ignore clicks in a window that was never
        // ordered in, so it's ordered in, but where nobody sees it. Off
        // screen alone didn't do it: macOS pulls a titled window back on
        // screen as it's ordered in, and on 6 Nov this one came up over
        // Mike's browser during a thread's swift test. So it's also clear
        // and under every app's windows (tuckBehind's level).
        window.alphaValue = 0
        window.level = NSWindow.Level(rawValue: NSWindow.Level.normal.rawValue - 1)
        window.setFrameOrigin(NSPoint(x: -20000, y: -20000))
        window.orderFrontRegardless()
        window.makeKey()
        host.layoutSubtreeIfNeeded()
        pump()
        return (session, host, window)
    }

    private func pump() { RunLoop.main.run(until: Date().addingTimeInterval(0.2)) }

    private func noteBoxes(in host: NSView) -> Int {
        func boxes(_ view: NSView) -> Int {
            (view is NSTextView ? 1 : 0) + view.subviews.reduce(0) { $0 + boxes($1) }
        }
        return boxes(host)
    }

    /// Each control's tip anchor sits behind it, the same size.
    private func anchor(_ tip: String, in host: NSView) -> TipAnchorView? {
        func anchors(_ view: NSView) -> [TipAnchorView] {
            view.subviews.flatMap { ($0 as? TipAnchorView).map { [$0] } ?? anchors($0) }
        }
        return anchors(host).first { $0.text == tip }
    }

    /// A press and release, sent through the window as a real click is.
    private func click(_ tip: String, in host: NSView, _ window: NSWindow) {
        guard let anchor = anchor(tip, in: host) else { return XCTFail("nothing with the tip \(tip)") }
        let point = anchor.convert(NSPoint(x: anchor.bounds.midX, y: anchor.bounds.midY), to: nil)
        for type in [NSEvent.EventType.leftMouseDown, .leftMouseUp] {
            let event = NSEvent.mouseEvent(with: type, location: point, modifierFlags: [], timestamp: ProcessInfo.processInfo.systemUptime,
                                           windowNumber: window.windowNumber, context: nil, eventNumber: 0, clickCount: 1,
                                           pressure: type == .leftMouseDown ? 1 : 0)!
            window.sendEvent(event)
        }
        pump()
    }
}
