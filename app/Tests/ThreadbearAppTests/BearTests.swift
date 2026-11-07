import AppKit
import XCTest
@testable import Threadbear

/// The bear is drawn in code: every pose is a template image at any size,
/// with ink in it. Set BEAR_SHEET to a .png path to get a contact sheet of
/// the poses at a few sizes, to look at.
@MainActor
final class BearTests: XCTestCase {
    func testEveryPoseIsATemplateWithInk() {
        for pose in Bear.Pose.allCases {
            for side: CGFloat in [16, 24, 48] {
                for hat in [false, true] {
                    let image = Bear.image(pose, side: side, hat: hat)
                    XCTAssertTrue(image.isTemplate, "\(pose) \(side)")
                    XCTAssertEqual(image.size, NSSize(width: side, height: side))
                    XCTAssertGreaterThan(ink(in: image, side: side), 0.03, "\(pose) at \(side) is nearly blank")
                    XCTAssertLessThan(ink(in: image, side: side), 0.5, "\(pose) at \(side) is a blob")
                }
            }
            XCTAssertFalse(Bear.description(pose).isEmpty)
        }
        XCTAssertTrue(Bear.image(.sit) === Bear.image(.sit), "cached")
    }

    /// The working line's moving bear is the still pose cut into layers, so
    /// at rest the two have to look the same, or the bear jumps between the
    /// working line and everywhere else.
    func testTheMovingBearAtRestMatchesTheStillPose() {
        for hat in [false, true] { checkMovingBearMatchesStill(hat: hat) }
    }

    private func checkMovingBearMatchesStill(hat: Bool) {
        let side: CGFloat = 96
        let view = WavingBearView(frame: NSRect(x: 0, y: 0, width: side, height: side))
        view.hat = hat
        view.tint = .black
        let moving = inkMap(side: Int(side)) { view.renderStill(in: $0) }
        let still = inkMap(side: Int(side)) { context in
            NSGraphicsContext.saveGraphicsState()
            NSGraphicsContext.current = NSGraphicsContext(cgContext: context, flipped: true)
            context.translateBy(x: 0, y: side)
            context.scaleBy(x: 1, y: -1)
            Bear.draw(.wave, in: NSRect(x: 0, y: 0, width: side, height: side), hat: hat)
            NSGraphicsContext.restoreGraphicsState()
        }
        let inked = still.filter { $0 }.count
        XCTAssertGreaterThan(inked, 500, "the pose should have ink in it")
        let different = zip(moving, still).filter { $0 != $1 }.count
        XCTAssertLessThan(Double(different) / Double(inked), 0.03, "\(different) of \(inked) pixels differ")
    }

    /// The Mac and the iPhone share no package, so the drawing is the same
    /// file in both. Change one, copy it to the other.
    func testBothAppsDrawTheSameBear() throws {
        let tests = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        let repo = tests.deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        let mac = try String(contentsOf: repo.appendingPathComponent("app/Sources/Threadbear/BearGeometry.swift"), encoding: .utf8)
        let phone = try String(contentsOf: repo.appendingPathComponent("ios/Threadbear/BearGeometry.swift"), encoding: .utf8)
        XCTAssertEqual(mac, phone, "copy app/Sources/Threadbear/BearGeometry.swift over ios/Threadbear/BearGeometry.swift")
    }

    /// Tiny specks go when the bear's small, and a cub has both its eyes.
    func testSmallBearsDropTheirSpecksAndCubsHaveNoButton() {
        let big = BearGeometry.waveFace(small: false), small = BearGeometry.waveFace(small: true)
        XCTAssertNotNil(big.stitch)
        XCTAssertNotNil(big.buttonPip)
        XCTAssertNil(small.stitch)
        XCTAssertNil(small.buttonPip)
        XCTAssertNotNil(small.buttonRing, "the button itself stays, it's the bear's whole character")
        XCTAssertNil(BearGeometry.pawPad(small: true))
        let cub = BearGeometry.Face(centre: .zero, scale: 0.6, eyes: .plain)
        XCTAssertNil(cub.buttonRing)
    }

    func testItMovesUntilStoppedAndStaysStillUnderReduceMotion() {
        let view = WavingBearView(frame: NSRect(x: 0, y: 0, width: 26, height: 26))
        view.start(fresh: false, reduceMotion: true)
        XCTAssertFalse(view.isAnimating)
        view.start(fresh: true, reduceMotion: false)
        XCTAssertTrue(view.isAnimating)
        view.stop()
        XCTAssertFalse(view.isAnimating)
    }

    /// The wave has to begin and end at rest, or it jumps as it repeats,
    /// and it has to fit its loop with most of the time spent still.
    func testTheWaveIsABurstThatStartsAndEndsAtRest() {
        let keys = WavingBearView.Timing.paw
        XCTAssertEqual(keys.first?.degrees, 0)
        XCTAssertEqual(keys.last?.degrees, 0)
        XCTAssertEqual(keys.last?.at, WavingBearView.Timing.wave)
        XCTAssertEqual(keys.map(\.at), keys.map(\.at).sorted())
        let lastMove = keys.dropLast().last!.at
        XCTAssertLessThan(lastMove / WavingBearView.Timing.wave, 0.5, "the bear should rest more than it waves")
    }

    /// 1 to 26 December, on the Mac's own calendar, and gone on the 27th.
    func testTheHatIsForDecemberUpToBoxingDay() {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "Australia/Perth")!
        func on(_ month: Int, _ day: Int) -> Date {
            calendar.date(from: DateComponents(year: 2026, month: month, day: day, hour: 23, minute: 59))!
        }
        for (month, day, wears) in [(11, 30, false), (12, 1, true), (12, 25, true), (12, 26, true), (12, 27, false), (1, 1, false), (6, 15, false)] {
            XCTAssertEqual(BearGeometry.wearsHat(on: on(month, day), calendar: calendar), wears, "\(month)/\(day)")
        }
    }

    /// Every bear in a hat stays inside its square, where an image would
    /// clip it, apart from the moving pom-pom's swing.
    func testTheHatStaysInTheSquare() {
        for pose in Bear.Pose.allCases {
            for ink in BearGeometry.inks(pose, side: 48, hat: true) {
                let box = ink.path.boundingBoxOfPath.insetBy(dx: -(ink.width ?? 0) / 2, dy: -(ink.width ?? 0) / 2)
                XCTAssertGreaterThanOrEqual(box.minX, -0.1, "\(pose) off the left")
                XCTAssertGreaterThanOrEqual(box.minY, -0.1, "\(pose) off the top")
            }
        }
    }

    /// The hat's the bear's own grey: template ink only, whatever it's on, and
    /// the pom-pom's part of it on a still bear and apart from it on a moving one.
    func testThePomPomComesAndGoes() {
        let with = BearGeometry.inks(.wave, side: 48, hat: true)
        let without = BearGeometry.inks(.wave, side: 48, hat: true, pom: false)
        XCTAssertEqual(with.count, without.count + 1)
        XCTAssertFalse(BearGeometry.wavePom(small: false).isEmpty)
        XCTAssertTrue(BearGeometry.waveFace(small: false).pomInks.isEmpty, "no hat, no pom-pom")
        let keys = WavingBearView.Timing.pom
        XCTAssertEqual(keys.first?.degrees, 0)
        XCTAssertEqual(keys.last?.degrees, 0)
        XCTAssertEqual(keys.last?.at, WavingBearView.Timing.wave)
        XCTAssertEqual(keys.map(\.at), keys.map(\.at).sorted())
        XCTAssertEqual(keys.dropFirst().first?.at, WavingBearView.Timing.pomLag, "a beat behind the paw")
    }

    /// Rest the pointer on the bear and it waves back at once, but only every
    /// few seconds however much the pointer wiggles, and only while it's a
    /// working bear: a finished line's stays still.
    func testItWavesBackAtThePointerNowAndThen() {
        let view = WavingBearView(frame: NSRect(x: 0, y: 0, width: 26, height: 26))
        XCTAssertFalse(view.waveBack(at: 1000), "not started, so nothing's there to wave")
        view.start(fresh: false, reduceMotion: false)
        XCTAssertTrue(view.waveBack(at: 1000))
        XCTAssertFalse(view.waveBack(at: 1000 + WavingBearView.Timing.waveBackGap - 0.1))
        XCTAssertTrue(view.waveBack(at: 1000 + WavingBearView.Timing.waveBackGap))
        view.stop()
        XCTAssertFalse(view.isAnimating)
        XCTAssertFalse(view.waveBack(at: 2000), "a finished line")
        XCTAssertFalse(view.hop(at: 2000), "a finished line")
        XCTAssertFalse(view.isAnimating, "and the pointer doesn't start it up again")
    }

    func testAPointerOverItReallyWaves() throws {
        let view = WavingBearView(frame: NSRect(x: 0, y: 0, width: 26, height: 26))
        view.updateTrackingAreas()
        let area = try XCTUnwrap(view.trackingAreas.first)
        XCTAssertTrue(area.options.contains(.mouseEnteredAndExited))
        XCTAssertTrue(area.options.contains(.inVisibleRect), "it has to follow the bear's own size, which is set after it's made")
        XCTAssertTrue(area.owner === view)
    }

    func testTheHopStartsAndEndsOnTheGroundAndIsNotInterrupted() {
        let keys = WavingBearView.Timing.hopKeys
        XCTAssertEqual(keys.first?.up, 0)
        XCTAssertEqual(keys.first?.y, 1)
        XCTAssertEqual(keys.last?.up, 0)
        XCTAssertEqual(keys.last?.y, 1)
        XCTAssertEqual(keys.last?.at, 1)
        let view = WavingBearView(frame: NSRect(x: 0, y: 0, width: 26, height: 26))
        view.start(fresh: false, reduceMotion: false)
        XCTAssertTrue(view.hop(at: 1000))
        XCTAssertFalse(view.hop(at: 1000 + WavingBearView.Timing.hop / 2), "already in the air")
        XCTAssertTrue(view.hop(at: 1000 + WavingBearView.Timing.hop + 0.01))
    }

    /// Under Reduce Motion the bear doesn't move, but it still sees you.
    func testReduceMotionGetsABlinkAndNoMovement() {
        let view = WavingBearView(frame: NSRect(x: 0, y: 0, width: 26, height: 26))
        view.start(fresh: false, reduceMotion: true)
        XCTAssertTrue(view.waveBack(at: 1000))
        XCTAssertTrue(view.hop(at: 1000))
        XCTAssertFalse(view.isAnimating)
    }

    /// Bedtime is 10 pm up to 5 am, on the Mac's own clock.
    func testBedtimeIsTenUntilFive() {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "Australia/Perth")!
        func at(_ hour: Int, _ minute: Int) -> Date {
            calendar.date(from: DateComponents(year: 2026, month: 11, day: 7, hour: hour, minute: minute))!
        }
        for (hour, minute, asleep) in [(21, 59, false), (22, 0, true), (23, 59, true), (0, 0, true), (4, 59, true), (5, 0, false), (12, 0, false)] {
            XCTAssertEqual(InboxZero.isBedtime(at(hour, minute), calendar: calendar), asleep, "\(hour):\(minute)")
        }
    }

    /// The Zs drift while it's on screen, stop when it isn't, and sit still
    /// under Reduce Motion.
    func testTheSleepingBearDriftsOnlyWhileItCan() {
        let view = SleepingBearView(frame: NSRect(x: 0, y: 0, width: 30, height: 30))
        view.start(reduceMotion: true)
        XCTAssertFalse(view.isDrifting)
        view.start(reduceMotion: false)
        XCTAssertTrue(view.isDrifting)
        view.stop()
        XCTAssertFalse(view.isDrifting)
        let keys = SleepingBearView.Timing.zKeys
        XCTAssertEqual(keys.first?.shown, 0, "fades in from nothing")
        XCTAssertEqual(keys.last?.shown, 0, "and out to nothing, so the repeat doesn't show")
        XCTAssertEqual(keys.last?.at, SleepingBearView.Timing.drift)
        XCTAssertEqual(keys.map(\.up), keys.map(\.up).sorted(), "only ever up")
    }

    /// The sleeping pose is still the head and its Zs, however it's cut up.
    func testTheSleepPoseIsItsHeadAndZs() {
        let zs = BearGeometry.sleepZs.count
        XCTAssertEqual(zs, 2)
        XCTAssertEqual(BearGeometry.inks(.sleep, side: 48).count, BearGeometry.sleepingHead(small: false).count + zs)
    }

    /// At rest, and whenever a track stops early, the woken bear is the sat bear.
    func testTheWokenBearAtRestIsTheSatBear() {
        let side: CGFloat = 96
        let view = WokenBearView(frame: NSRect(x: 0, y: 0, width: side, height: side))
        view.tint = .black
        let moving = inkMap(side: Int(side)) { view.layer?.render(in: $0) }
        let still = inkMap(side: Int(side)) { context in
            NSGraphicsContext.saveGraphicsState()
            NSGraphicsContext.current = NSGraphicsContext(cgContext: context, flipped: true)
            context.translateBy(x: 0, y: side)
            context.scaleBy(x: 1, y: -1)
            Bear.draw(.sit, in: NSRect(x: 0, y: 0, width: side, height: side))
            NSGraphicsContext.restoreGraphicsState()
        }
        let inked = still.filter { $0 }.count
        XCTAssertGreaterThan(inked, 500)
        let different = zip(moving, still).filter { $0 != $1 }.count
        XCTAssertLessThan(Double(different) / Double(inked), 0.03, "\(different) of \(inked) pixels differ")
    }

    func testWakingUpIsAboutASecondAndSkippedUnderReduceMotion() {
        XCTAssertEqual(WokenBearView.Timing.total, 1.28, accuracy: 0.2)
        let view = WokenBearView(frame: NSRect(x: 0, y: 0, width: 18, height: 18))
        view.wakeUp(reduceMotion: true)
        XCTAssertFalse(view.isWaking)
        view.wakeUp(reduceMotion: false)
        XCTAssertTrue(view.isWaking)
        view.settle()
        XCTAssertFalse(view.isWaking)
    }

    /// Set BEAR_FRAMES_WOKEN to a folder to get the waking bear as numbered PNGs.
    func testWokenFramesWhenAsked() throws {
        guard let folder = ProcessInfo.processInfo.environment["BEAR_FRAMES_WOKEN"] else { throw XCTSkip("BEAR_FRAMES_WOKEN not set") }
        let side = 192, pad = 32, canvas = side + 2 * pad
        let view = WokenBearView(frame: NSRect(x: 0, y: 0, width: side, height: side))
        view.tint = .black
        view.wakeUp(reduceMotion: false)
        for frame in 0..<Int(WokenBearView.Timing.total * 15) + 2 {
            let context = CGContext(data: nil, width: canvas, height: canvas, bitsPerComponent: 8, bytesPerRow: canvas * 4,
                                    space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
            context.setFillColor(.white)
            context.fill(CGRect(x: 0, y: 0, width: canvas, height: canvas))
            context.translateBy(x: CGFloat(pad), y: CGFloat(pad))
            view.renderFrame(at: Double(frame) / 15, in: context)
            let png = NSBitmapImageRep(cgImage: context.makeImage()!).representation(using: .png, properties: [:])!
            try png.write(to: URL(fileURLWithPath: folder).appendingPathComponent(String(format: "f%04d.png", frame)))
        }
    }

    /// Set BEAR_FRAMES to a folder to get the moving bear as numbered PNGs,
    /// to look at or turn into a GIF. Drawn 8pt in from each edge, so a paw
    /// swinging past the frame shows.
    func testFramesWhenAsked() throws {
        guard let folder = ProcessInfo.processInfo.environment["BEAR_FRAMES"] else { throw XCTSkip("BEAR_FRAMES not set") }
        // BEAR_FRAMES_HOP: the hop on a click instead, from the click on.
        let hopping = ProcessInfo.processInfo.environment["BEAR_FRAMES_HOP"] != nil
        let side = 192, pad = hopping ? 96 : 32, canvas = side + 2 * pad
        let view = WavingBearView(frame: NSRect(x: 0, y: 0, width: side, height: side))
        view.hat = ProcessInfo.processInfo.environment["BEAR_HAT"] != nil
        view.tint = .black
        view.start(fresh: false, reduceMotion: false)
        if hopping { view.hop() }
        for frame in 0..<(hopping ? 15 : 8 * 30) {
            let context = CGContext(data: nil, width: canvas, height: canvas, bitsPerComponent: 8, bytesPerRow: canvas * 4,
                                    space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
            context.setFillColor(.white)
            context.fill(CGRect(x: 0, y: 0, width: canvas, height: canvas))
            context.translateBy(x: CGFloat(pad), y: CGFloat(pad))
            view.renderFrame(at: Double(frame) / 30, in: context)
            let png = NSBitmapImageRep(cgImage: context.makeImage()!).representation(using: .png, properties: [:])!
            try png.write(to: URL(fileURLWithPath: folder).appendingPathComponent(String(format: "f%04d.png", frame)))
        }
    }

    func testContactSheetWhenAsked() throws {
        guard let path = ProcessInfo.processInfo.environment["BEAR_SHEET"] else { throw XCTSkip("BEAR_SHEET not set") }
        let sizes: [CGFloat] = [14, 18, 26, 48, 96]
        let cell: CGFloat = 110
        let hat = ProcessInfo.processInfo.environment["BEAR_HAT"] != nil
        let sheet = NSImage(size: NSSize(width: cell * CGFloat(Bear.Pose.allCases.count), height: cell * CGFloat(sizes.count)))
        sheet.lockFocus()
        NSColor.white.setFill()
        NSRect(origin: .zero, size: sheet.size).fill()
        for (column, pose) in Bear.Pose.allCases.enumerated() {
            for (row, side) in sizes.enumerated() {
                let image = Bear.image(pose, side: side, hat: hat)
                let tinted = image.copy() as! NSImage
                tinted.isTemplate = false
                let origin = NSPoint(x: cell * CGFloat(column) + (cell - side) / 2, y: cell * CGFloat(row) + (cell - side) / 2)
                tinted.draw(in: NSRect(origin: origin, size: NSSize(width: side, height: side)))
            }
        }
        sheet.unlockFocus()
        let tiff = sheet.tiffRepresentation!
        let png = NSBitmapImageRep(data: tiff)!.representation(using: .png, properties: [:])!
        try png.write(to: URL(fileURLWithPath: path))
    }

    /// Which pixels have ink when `draw` paints a square of `side` pixels.
    private func inkMap(side: Int, draw: (CGContext) -> Void) -> [Bool] {
        let context = CGContext(data: nil, width: side, height: side, bitsPerComponent: 8, bytesPerRow: side * 4,
                                space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
        draw(context)
        let pixels = context.data!.bindMemory(to: UInt8.self, capacity: side * side * 4)
        return (0..<side * side).map { pixels[$0 * 4 + 3] > 127 }
    }

    /// The share of pixels with any ink, drawn at 2x so thin lines count.
    private func ink(in image: NSImage, side: CGFloat) -> Double {
        let px = Int(side * 2)
        let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: px, pixelsHigh: px, bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
        NSGraphicsContext.saveGraphicsState()
        NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
        let copy = image.copy() as! NSImage
        copy.isTemplate = false
        copy.draw(in: NSRect(x: 0, y: 0, width: px, height: px))
        NSGraphicsContext.restoreGraphicsState()
        var inked = 0
        for y in 0..<px { for x in 0..<px where (rep.colorAt(x: x, y: y)?.alphaComponent ?? 0) > 0.2 { inked += 1 } }
        return Double(inked) / Double(px * px)
    }
}
