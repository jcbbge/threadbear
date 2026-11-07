import AppKit
import QuartzCore

/// The working line's bear, alive: it pops up when a turn starts, gives a
/// little wave every few seconds, breathes, and blinks now and then. Mike
/// watches this line while a turn runs, so the wave comes in bursts rather
/// than flapping non-stop next to the text he's reading.
///
/// It's the waving pose from BearGeometry cut into layers, so all of the
/// movement is Core Animation and carries on while the main thread is busy
/// (AGENTS.md, "Animations"). Under Reduce Motion it's the still pose.
///
/// A secret, with no tip to give it away: rest the pointer on it and it waves
/// back straight away, and click it and it hops.
final class WavingBearView: InkLayersView {
    /// One full run of each movement. The lengths don't divide evenly into
    /// each other, so the wave, breath and blink never settle into one
    /// obvious repeating loop.
    enum Timing {
        static let wave: CFTimeInterval = 6
        static let breath: CFTimeInterval = 3.4
        static let blink: CFTimeInterval = 7.3
        /// The paw's swing in degrees at seconds into the wave. Starts and
        /// ends at rest, so the still pose and the repeat both line up, and
        /// only ever swings outward: at rest the paw is already close to the
        /// ear, so going the other way runs it into the ear.
        static let paw: [(at: Double, degrees: Double)] = [
            (0, 0), (0.16, 14), (0.38, 3), (0.6, 14), (0.82, 3), (1.04, 10), (1.3, 0), (wave, 0),
        ]
        /// The Santa hat's pom-pom, a beat behind the paw with more swing, the
        /// other way, and a settle at the end. Starts and ends at rest too.
        static let pomLag: Double = 0.1
        static let pom: [(at: Double, degrees: Double)] = [
            (0, 0), (pomLag, 0), (0.26, -42), (0.48, -9), (0.7, -42), (0.92, -9), (1.14, -30), (1.4, 0),
            (1.52, 18), (1.66, -7.5), (1.8, 0), (wave, 0),
        ]
        /// How long the paw is up in each wave.
        static let burst: CFTimeInterval = 1.3
        /// Wiggling the pointer over it shouldn't make it flap.
        static let waveBackGap: CFTimeInterval = 3
        /// The hop on a click, as the fraction of it each point comes at: a
        /// squash, up on its toes, a squash on landing. `up` is on the grid.
        static let hop: CFTimeInterval = 0.42
        static let hopKeys: [(at: Double, up: Double, x: Double, y: Double)] = [
            (0, 0, 1, 1), (0.15, 0, 1.08, 0.9), (0.5, 9, 0.96, 1.05), (0.85, 0, 1.08, 0.92), (1, 0, 1, 1),
        ]
    }

    /// The pop on arrival. A layer of its own so it can't fight the breath.
    private let arrival = CALayer()
    /// Everything that sways and breathes.
    private let figure = CALayer()
    /// The face and any hat, which only ever move with the figure.
    private let stills = CALayer()
    /// The eye that blinks. The other one's a button, and buttons don't.
    private let eyes = CALayer()
    /// The Santa hat's pom-pom, swinging about the hat's tip.
    private let pom = CALayer()
    /// Shows the arm only outside the head, so it hugs it as it swings. It
    /// doesn't turn itself, or the head's shape would turn with the arm.
    private let armClip = CALayer()
    /// The arm and pad, swinging about the shoulder.
    private let paw = CALayer()

    private var builtSide: CGFloat = 0
    /// Between start and stop: the pointer can't wake a finished line's bear.
    private var live = false
    /// When the current wave's loop began, to tell whether the paw's up.
    private var waveBegan: CFTimeInterval = 0
    private var lastWaveBack = -CFTimeInterval.infinity
    private var lastHop = -CFTimeInterval.infinity
    private var hoverArea: NSTrackingArea?

    /// Whether any of the looping movement is on.
    var isAnimating: Bool { paw.animation(forKey: Key.paw) != nil }

    private enum Key {
        static let paw = "bear.paw"
        static let pom = "bear.pom"
        static let sway = "bear.sway"
        static let breath = "bear.breath"
        static let blink = "bear.blink"
        static let arrival = "bear.arrival"
        static let wink = "bear.wink"
        static let hop = "bear.hop"
    }

    override init(frame frameRect: NSRect) {
        super.init(frame: frameRect)
        stage.addSublayer(arrival)
        arrival.addSublayer(figure)
        armClip.addSublayer(paw)
        for part in [armClip, stills, pom, eyes] { figure.addSublayer(part) }
        setAccessibilityLabel(Bear.description(.wave))
        // init(frame:) doesn't go through setFrameSize.
        redraw()
    }

    required init?(coder: NSCoder) { fatalError() }

    // MARK: Moving

    /// Starts the movement, if it isn't going already. `fresh` adds the
    /// pop up from nothing, for a turn that's only just begun.
    func start(fresh: Bool, reduceMotion: Bool? = nil) {
        live = true
        guard !(reduceMotion ?? Juice.reduceMotion), !isAnimating else { return }
        addWave(at: CACurrentMediaTime())
        figure.add(Self.loop("transform.scale", length: Timing.breath,
                             keys: [(0, 1), (Timing.breath / 2, 1.03), (Timing.breath, 1)]), forKey: Key.breath)
        // One blink partway through, then a double one before it repeats.
        eyes.add(Self.loop("transform.scale.y", length: Timing.blink, keys: [
            (0, 1), (3, 1), (3.06, 0.12), (3.14, 1),
            (6.7, 1), (6.76, 0.12), (6.84, 1), (6.9, 0.12), (6.98, 1), (Timing.blink, 1),
        ]), forKey: Key.blink)
        if fresh {
            let pop = CASpringAnimation(keyPath: "transform.scale")
            pop.fromValue = 0.4
            pop.toValue = 1
            pop.mass = 0.6
            pop.stiffness = 240
            pop.damping = 11
            pop.duration = pop.settlingDuration
            arrival.add(pop, forKey: Key.arrival)
        }
    }

    func stop() {
        live = false
        paw.removeAnimation(forKey: Key.paw)
        pom.removeAnimation(forKey: Key.pom)
        figure.removeAnimation(forKey: Key.sway)
        figure.removeAnimation(forKey: Key.breath)
        eyes.removeAnimation(forKey: Key.blink)
        arrival.removeAnimation(forKey: Key.arrival)
        arrival.removeAnimation(forKey: Key.hop)
        eyes.removeAnimation(forKey: Key.wink)
    }

    /// Puts on the wave's two tracks, the burst starting at `time`. Adding
    /// them again replaces the ones running, which moves the bear's whole
    /// rhythm along, so the next burst comes a full loop after this one.
    private func addWave(at time: CFTimeInterval) {
        waveBegan = time
        paw.add(Self.loop("transform.rotation.z", length: Timing.wave, begin: time,
                          keys: Timing.paw.map { ($0.at, $0.degrees * .pi / 180) }), forKey: Key.paw)
        // The whole bear leans with the wave, a fraction as far.
        figure.add(Self.loop("transform.rotation.z", length: Timing.wave, begin: time,
                             keys: Timing.paw.map { ($0.at, -$0.degrees * 0.16 * .pi / 180) }), forKey: Key.sway)
        // Only there to see in December, but cheap enough to always run with the wave.
        pom.add(Self.loop("transform.rotation.z", length: Timing.wave, begin: time,
                          keys: Timing.pom.map { ($0.at, $0.degrees * .pi / 180) }), forKey: Key.pom)
    }

    /// Whether the paw is up now. Starting a wave then would snap it down.
    private func isMidWave(at now: CFTimeInterval) -> Bool {
        (now - waveBegan).truncatingRemainder(dividingBy: Timing.wave) < Timing.burst
    }

    private func wink(at now: CFTimeInterval) {
        let wink = CAKeyframeAnimation(keyPath: "transform.scale.y")
        wink.values = [1, 0.12, 1]
        wink.keyTimes = [0, 0.43, 1]
        wink.duration = 0.14
        wink.beginTime = now
        eyes.add(wink, forKey: Key.wink)
    }

    /// The pointer came to rest on the bear: it blinks and waves straight
    /// away, unless it's waving already or did only just now. Under Reduce
    /// Motion it's only the blink. Says whether it noticed, for BearTests.
    @discardableResult
    func waveBack(at now: CFTimeInterval = CACurrentMediaTime()) -> Bool {
        guard live, now - lastWaveBack >= Timing.waveBackGap else { return false }
        lastWaveBack = now
        wink(at: now)
        if isAnimating, !isMidWave(at: now) { addWave(at: now) }
        return true
    }

    /// A click: a hop with a squash at each end, and a wave once it's down.
    /// Under Reduce Motion it's a blink. A click while it's in the air
    /// doesn't start it again, or it would jump back to the ground.
    @discardableResult
    func hop(at now: CFTimeInterval = CACurrentMediaTime()) -> Bool {
        guard live, now - lastHop >= Timing.hop else { return false }
        lastHop = now
        guard isAnimating else {
            wink(at: now)
            return true
        }
        let unit = builtSide / 24
        let track = CAKeyframeAnimation(keyPath: "transform")
        // Up is minus: the stage is flipped, and so y runs down as on the grid.
        track.values = Timing.hopKeys.map { key in
            NSValue(caTransform3D: CATransform3DScale(CATransform3DMakeTranslation(0, -key.up * unit, 0), key.x, key.y, 1))
        }
        track.keyTimes = Timing.hopKeys.map { NSNumber(value: $0.at) }
        track.timingFunction = CAMediaTimingFunction(name: .easeOut)
        track.duration = Timing.hop
        track.beginTime = now
        arrival.add(track, forKey: Key.hop)
        if !isMidWave(at: now), !isMidWave(at: now + Timing.hop) { addWave(at: now + Timing.hop) }
        return true
    }

    // MARK: The pointer

    override func updateTrackingAreas() {
        super.updateTrackingAreas()
        guard hoverArea == nil else { return }
        // Always, not only in the key window: it's a bear, seeing a pointer
        // go past it. It costs one track restart at most every few seconds.
        let area = NSTrackingArea(rect: .zero, options: [.mouseEnteredAndExited, .activeAlways, .inVisibleRect], owner: self)
        addTrackingArea(area)
        hoverArea = area
    }

    override func mouseEntered(with event: NSEvent) { waveBack() }

    // Not passed on to the row: this click is only for the bear.
    override func mouseDown(with event: NSEvent) { hop() }

    // A click counts while Threadbear isn't the app in front, like the row's.
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }

    /// A forever-repeating track from (seconds, value) pairs. Thirty frames
    /// a second is plenty at this size, and this runs for whole turns, so
    /// it shouldn't keep the display at 120.
    private static func loop(_ keyPath: String, length: CFTimeInterval, begin: CFTimeInterval = 0, keys: [(Double, Double)]) -> CAKeyframeAnimation {
        let track = CAKeyframeAnimation(keyPath: keyPath)
        track.values = keys.map(\.1)
        track.keyTimes = keys.map { NSNumber(value: $0.0 / length) }
        track.timingFunction = CAMediaTimingFunction(name: .easeInEaseOut)
        track.calculationMode = .cubic
        track.duration = length
        track.beginTime = begin
        track.repeatCount = .infinity
        // Keeps its place through a layer leaving and rejoining the tree;
        // stop() is what ends it.
        track.isRemovedOnCompletion = false
        track.preferredFrameRateRange = CAFrameRateRange(minimum: 15, maximum: 30, preferred: 30)
        return track
    }

    // MARK: Drawing

    /// Paths are made at the real size, not scaled afterwards, so the lines
    /// stay sharp at any zoom. Small bears drop the stitch, pip and pad.
    override func layOut(side: CGFloat, drawing: Drawing) {
        builtSide = side
        let square = CGRect(x: 0, y: 0, width: side, height: side)
        let small = side < BearGeometry.smallSide
        let face = BearGeometry.waveFace(small: small, hat: hat)
        let eyeBox = face.blinkingEyes?.boundingBox ?? .zero

        Self.pin(arrival, about: BearGeometry.feet, square: square)
        Self.pin(figure, about: BearGeometry.feet, square: square)
        Self.pin(eyes, about: CGPoint(x: eyeBox.midX, y: eyeBox.midY), square: square)
        Self.pin(paw, about: BearGeometry.shoulder, square: square)
        Self.pin(pom, about: face.hatTip ?? .zero, square: square)
        stills.frame = square
        armClip.frame = square
        armClip.mask = Self.mask(outside: face.head, square: square, drawing)

        var arm = [BearGeometry.Ink(path: BearGeometry.arm, width: BearGeometry.line)]
        if let pad = BearGeometry.pawPad(small: small) { arm.append(BearGeometry.Ink(path: pad, width: nil)) }
        Self.fill(paw, arm, square: square, drawing)
        Self.fill(stills, face.stillInks, square: square, drawing)
        Self.fill(pom, face.pomInks, square: square, drawing)
        Self.fill(eyes, face.blinkingEyes.map { [BearGeometry.Ink(path: $0, width: nil)] } ?? [], square: square, drawing)
    }

    /// The layers as they stand, for BearTests to compare with the pose.
    func renderStill(in context: CGContext) {
        layer?.render(in: context)
    }

    #if DEBUG
    /// Draws the bear as it looks `seconds` into its loops, from the real
    /// tracks, for BearTests' BEAR_FRAMES. Core Animation can't be sampled
    /// to a bitmap, least of all with the screen locked.
    func renderFrame(at seconds: Double, in context: CGContext) {
        let moved: [(CALayer, String)] = [(paw, Key.paw), (figure, Key.sway), (figure, Key.breath), (eyes, Key.blink), (pom, Key.pom)]
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        for (part, key) in moved {
            guard let track = part.animation(forKey: key) as? CAKeyframeAnimation,
                  let values = track.values as? [Double], let times = track.keyTimes?.map(\.doubleValue),
                  let keyPath = track.keyPath else { continue }
            let t = seconds.truncatingRemainder(dividingBy: track.duration) / track.duration
            let i = max(0, (times.lastIndex { $0 <= t } ?? 0))
            let j = min(i + 1, values.count - 1)
            let span = max(0.000_001, times[j] - times[i])
            part.setValue(values[i] + (values[j] - values[i]) * min(1, (t - times[i]) / span), forKeyPath: keyPath)
        }
        // The hop, if there's been one: `seconds` counts from the click.
        if let track = arrival.animation(forKey: Key.hop) as? CAKeyframeAnimation,
           let values = track.values as? [NSValue], let times = track.keyTimes?.map(\.doubleValue) {
            let t = min(1, seconds / track.duration)
            let i = times.lastIndex { $0 <= t } ?? 0, j = min(i + 1, values.count - 1)
            let (a, b) = (values[i].caTransform3DValue, values[j].caTransform3DValue)
            let f = min(1, (t - times[i]) / max(0.000_001, times[j] - times[i]))
            let mix = { (x: CGFloat, y: CGFloat) in x + (y - x) * f }
            arrival.setAffineTransform(CGAffineTransform(a: mix(a.m11, b.m11), b: 0, c: 0, d: mix(a.m22, b.m22), tx: 0, ty: mix(a.m42, b.m42)))
        }
        CATransaction.commit()
        layer?.render(in: context)
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        for part in [paw, figure, eyes, arrival, pom] { part.setAffineTransform(.identity) }
        CATransaction.commit()
    }
    #endif
}
