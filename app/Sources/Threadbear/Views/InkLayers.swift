import AppKit
import QuartzCore

/// A bear in Core Animation layers, for one that moves by itself in a
/// transcript or the sidebar: the drawing comes from BearGeometry's inks, so
/// it's the same bear as the still images, and the movement carries on while
/// the main thread is busy (AGENTS.md, "Animations").
///
/// Subclasses put layers on `stage` and fill them in `layOut`, which runs
/// again for a new size, appearance or screen.
class InkLayersView: NSView {
    /// The line colour. A plain layer can't be a template image, so this is
    /// resolved by hand whenever the appearance changes.
    var tint: NSColor = .secondaryLabelColor {
        didSet { redraw() }
    }

    /// Holds the grid's y-down coordinates, as the static pose has.
    let stage = CALayer()

    override init(frame frameRect: NSRect) {
        super.init(frame: frameRect)
        wantsLayer = true
        // Some of what moves goes a little past the grid's edge.
        clipsToBounds = false
        stage.isGeometryFlipped = true
        layer?.addSublayer(stage)
        setAccessibilityRole(.image)
    }

    required init?(coder: NSCoder) { fatalError() }

    override func setFrameSize(_ newSize: NSSize) {
        super.setFrameSize(newSize)
        redraw()
    }

    override func viewDidChangeEffectiveAppearance() {
        super.viewDidChangeEffectiveAppearance()
        redraw()
    }

    override func viewDidChangeBackingProperties() {
        super.viewDidChangeBackingProperties()
        redraw()
    }

    /// Fills the layers for this size and colour. Replaces only what's on
    /// `InkLayersView.fill`'s hosts, so animations on the hosts themselves go on.
    func layOut(side: CGFloat, drawing: Drawing) {}

    /// What a subclass needs to turn inks into layers at the current size.
    struct Drawing {
        var unit: CGFloat
        var ink: CGColor
        var screen: CGFloat
    }

    /// Whether it's in its Santa hat. A transcript's cells set it each time,
    /// as a bear can sit in a pooled cell across midnight on the 30th.
    var hat = BearGeometry.wearsHat() {
        didSet { if hat != oldValue { drawn = nil; redraw() } }
    }

    /// What it was last drawn for: a row's cell sets the same frame and
    /// tint again and again, and new layers for each would be a waste.
    private var drawn: (side: CGFloat, ink: CGColor, screen: CGFloat)?

    final func redraw() {
        let side = min(bounds.width, bounds.height)
        guard side > 0 else { return }
        var ink = tint.cgColor
        effectiveAppearance.performAsCurrentDrawingAppearance { ink = self.tint.cgColor }
        let screen = window?.backingScaleFactor ?? NSScreen.main?.backingScaleFactor ?? 2
        if let drawn, drawn.side == side, drawn.ink == ink, drawn.screen == screen { return }
        drawn = (side, ink, screen)
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        stage.frame = bounds
        layOut(side: side, drawing: Drawing(unit: side / 24, ink: ink, screen: screen))
        CATransaction.commit()
    }

    /// Replaces what's in `host` with these inks.
    static func fill(_ host: CALayer, _ inks: [BearGeometry.Ink], square: CGRect, _ drawing: Drawing) {
        var scale = CGAffineTransform(scaleX: drawing.unit, y: drawing.unit)
        host.contentsScale = drawing.screen
        host.sublayers = inks.map { ink in
            let shape = CAShapeLayer()
            shape.frame = square
            shape.contentsScale = drawing.screen
            shape.path = ink.path.copy(using: &scale)
            shape.lineCap = .round
            shape.lineJoin = .round
            if let width = ink.width {
                shape.strokeColor = drawing.ink
                shape.fillColor = nil
                shape.lineWidth = width * drawing.unit
            } else {
                shape.fillColor = drawing.ink
                shape.strokeColor = nil
            }
            if let outside = ink.outside { shape.mask = mask(outside: outside, square: square, drawing) }
            return shape
        }
    }

    /// A mask that shows only what's outside a path on the grid, so outlines don't cross.
    static func mask(outside path: CGPath, square: CGRect, _ drawing: Drawing) -> CAShapeLayer {
        var scale = CGAffineTransform(scaleX: drawing.unit, y: drawing.unit)
        let everywhereElse = CGMutablePath()
        everywhereElse.addRect(square.insetBy(dx: -square.width, dy: -square.height))
        if let sized = path.copy(using: &scale) { everywhereElse.addPath(sized) }
        let mask = CAShapeLayer()
        mask.frame = square
        mask.contentsScale = drawing.screen
        mask.path = everywhereElse
        mask.fillRule = .evenOdd
        mask.fillColor = NSColor.black.cgColor
        return mask
    }

    /// Pins a layer so it turns and scales about this spot on the grid.
    static func pin(_ part: CALayer, about point: CGPoint, square: CGRect) {
        part.bounds = square
        part.anchorPoint = CGPoint(x: point.x / 24, y: point.y / 24)
        part.position = CGPoint(x: point.x * square.width / 24, y: point.y * square.height / 24)
    }

    /// A track from (seconds, value) pairs. Thirty frames a second is plenty
    /// at this size, and some of these run for as long as they're on screen.
    static func track(_ keyPath: String, length: CFTimeInterval, begin: CFTimeInterval = 0, repeats: Bool = false, keys: [(Double, Double)]) -> CAKeyframeAnimation {
        let track = CAKeyframeAnimation(keyPath: keyPath)
        track.values = keys.map(\.1)
        track.keyTimes = keys.map { NSNumber(value: $0.0 / length) }
        track.timingFunctions = Array(repeating: CAMediaTimingFunction(name: .easeInEaseOut), count: max(1, keys.count - 1))
        track.duration = length
        track.beginTime = begin
        track.preferredFrameRateRange = CAFrameRateRange(minimum: 15, maximum: 30, preferred: 30)
        if repeats {
            track.repeatCount = .infinity
            // Keeps its place through a layer leaving and rejoining the tree.
            track.isRemovedOnCompletion = false
        }
        return track
    }
}

/// The bedtime bear under an empty Inbox: asleep, breathing slowly, with its
/// two Zs drifting up and fading. Only here and only at night, so a slow
/// loop is all the movement there is. Under Reduce Motion it's the still pose.
final class SleepingBearView: InkLayersView {
    enum Timing {
        static let breath: CFTimeInterval = 4.4
        static let drift: CFTimeInterval = 3
        /// The big Z comes a beat after the small one.
        static let secondZ: CFTimeInterval = 0.7
        /// Into the drift in seconds: how far up it's gone, on the grid, and
        /// how much of it shows.
        static let zKeys: [(at: Double, up: Double, shown: Double)] = [
            (0, -0.6, 0), (0.75, 0, 1), (2.1, 1.4, 0.85), (drift, 2.4, 0),
        ]
    }

    /// Everything that breathes.
    private let figure = CALayer()
    private let head = CALayer()
    private let zs = [CALayer(), CALayer()]

    // Nothing here's a control: clicks go through to the sidebar.
    override func hitTest(_ point: NSPoint) -> NSView? { nil }

    var isDrifting: Bool { zs[0].animation(forKey: "bear.drift") != nil }

    override init(frame frameRect: NSRect) {
        super.init(frame: frameRect)
        stage.addSublayer(figure)
        figure.addSublayer(head)
        zs.forEach(stage.addSublayer)
        setAccessibilityLabel(Bear.description(.sleep))
        redraw()
    }

    required init?(coder: NSCoder) { fatalError() }

    override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        if window == nil { stop() } else { start() }
    }

    func start(reduceMotion: Bool? = nil) {
        guard !(reduceMotion ?? Juice.reduceMotion), !isDrifting else { return }
        let length = Timing.breath
        figure.add(Self.track("transform.scale.x", length: length, repeats: true, keys: [(0, 1), (length / 2, 1.025), (length, 1)]), forKey: "bear.breathX")
        figure.add(Self.track("transform.scale.y", length: length, repeats: true, keys: [(0, 1), (length / 2, 1.035), (length, 1)]), forKey: "bear.breathY")
        let now = CACurrentMediaTime()
        for (index, z) in zs.enumerated() {
            let begin = now + Double(index) * Timing.secondZ
            let keys = Timing.zKeys
            let group = CAAnimationGroup()
            group.animations = [
                Self.track("opacity", length: Timing.drift, keys: keys.map { ($0.at, $0.shown) }),
                Self.track("transform.translation.y", length: Timing.drift, keys: keys.map { ($0.at, -$0.up * Double(unit)) }),
            ]
            group.duration = Timing.drift
            group.beginTime = begin
            group.repeatCount = .infinity
            group.preferredFrameRateRange = CAFrameRateRange(minimum: 15, maximum: 30, preferred: 30)
            group.isRemovedOnCompletion = false
            // Hidden until its first drift, for the one that starts late.
            group.fillMode = .backwards
            z.add(group, forKey: "bear.drift")
        }
    }

    func stop() {
        figure.removeAllAnimations()
        zs.forEach { $0.removeAllAnimations() }
    }

    private var unit: CGFloat { min(bounds.width, bounds.height) / 24 }

    override func layOut(side: CGFloat, drawing: Drawing) {
        let square = CGRect(x: 0, y: 0, width: side, height: side)
        Self.pin(figure, about: BearGeometry.sleepingFeet, square: square)
        head.frame = square
        Self.fill(head, BearGeometry.sleepingHead(small: side < BearGeometry.smallSide, hat: hat), square: square, drawing)
        let wasDrifting = isDrifting
        for (z, path) in zip(zs, BearGeometry.sleepZs) {
            z.frame = square
            Self.fill(z, [BearGeometry.Ink(path: path, width: BearGeometry.Face.shutWidth)], square: square, drawing)
        }
        // Drifts are in points, so a new size wants them worked out again.
        if wasDrifting { stop(); start() }
    }
}

/// The bear beside a transcript's "Woke up after hibernating for 2 days.":
/// sat, once it's up. The first time the note's seen it's asleep, then the
/// Zs go, its head comes up, it sits up with its eyes shut, opens them and
/// has one stretch with a paw in the air, about a second all told and all of
/// it Core Animation. Under Reduce Motion it's sat from the start.
final class WokenBearView: InkLayersView {
    enum Timing {
        /// Asleep for a beat first, as the thread comes up.
        static let asleep: CFTimeInterval = 0.35
        static let headUp = asleep + 0.15
        static let satUp = headUp + 0.12
        static let eyesOpen = satUp + 0.06
        static let eyesOpened = eyesOpen + 0.1
        static let stretch = eyesOpened + 0.08
        static let stretchLength: CFTimeInterval = 0.42
        static let total = stretch + stretchLength
    }

    private let sleeping = CALayer()
    private let zs = [CALayer(), CALayer()]
    /// Everything that stretches. At rest, the sat bear.
    private let figure = CALayer()
    private let satShut = CALayer()
    private let sat = CALayer()
    private let eye = CALayer()
    /// Shows the arm only outside the bear, so it comes from behind it. It
    /// doesn't turn itself, or the outline would turn with the arm.
    private let armClip = CALayer()
    private let arm = CALayer()

    // Nothing here's a control: clicks go through to the note's text.
    override func hitTest(_ point: NSPoint) -> NSView? { nil }

    /// Whether it's partway through waking up.
    var isWaking: Bool { figure.animation(forKey: "bear.stretchY") != nil }

    override init(frame frameRect: NSRect) {
        super.init(frame: frameRect)
        [sleeping, zs[0], zs[1], figure].forEach(stage.addSublayer)
        figure.addSublayer(armClip)
        armClip.addSublayer(arm)
        [satShut, sat, eye].forEach(figure.addSublayer)
        // Where they end up. The tracks hold them elsewhere until then, so
        // anything that stops a track leaves the bear sat.
        for hidden in [sleeping, zs[0], zs[1], satShut, arm] { hidden.opacity = 0 }
        setAccessibilityLabel(Bear.description(.sit))
        redraw()
    }

    required init?(coder: NSCoder) { fatalError() }

    func wakeUp(reduceMotion: Bool? = nil) {
        guard !(reduceMotion ?? Juice.reduceMotion) else { return }
        settle()
        let now = CACurrentMediaTime(), end = Timing.total
        func play(_ part: CALayer, _ keyPath: String, _ key: String, _ keys: [(Double, Double)]) {
            part.add(Self.track(keyPath, length: end, begin: now, keys: keys + [(end, keys.last!.1)]), forKey: key)
        }
        let unit = min(bounds.width, bounds.height) / 24
        // Its Zs, gone as it stirs.
        for (index, z) in zs.enumerated() {
            let peak = Timing.asleep * (index == 0 ? 0.4 : 0.8)
            play(z, "opacity", "bear.z", [(0, 0.3), (peak, 1), (Timing.asleep, 1), (Timing.headUp, 0)])
            play(z, "transform.translation.y", "bear.zUp", [(0, 0.5 * unit), (Timing.headUp, -1.5 * unit)])
        }
        // The head comes up off its side, and then it's sat, eyes still shut...
        let upright = -BearGeometry.sleepingTilt * .pi / 180
        play(sleeping, "transform.rotation.z", "bear.headUp", [(0, 0), (Timing.asleep, 0), (Timing.headUp, upright)])
        play(sleeping, "opacity", "bear.asleep", [(0, 1), (Timing.headUp, 1), (Timing.satUp, 0)])
        play(satShut, "opacity", "bear.satUp", [(0, 0), (Timing.headUp, 0), (Timing.satUp, 1), (Timing.eyesOpen, 1), (Timing.eyesOpen + 0.001, 0)])
        // ...then it opens them...
        play(sat, "opacity", "bear.sat", [(0, 0), (Timing.eyesOpen, 0), (Timing.eyesOpen + 0.001, 1)])
        play(eye, "opacity", "bear.eye", [(0, 0), (Timing.eyesOpen, 0), (Timing.eyesOpen + 0.001, 1)])
        play(eye, "transform.scale.y", "bear.eyeOpen", [(0, 0.1), (Timing.eyesOpen, 0.1), (Timing.eyesOpened, 1)])
        // ...and stretches up from its feet with a paw in the air.
        let start = Timing.stretch, length = Timing.stretchLength
        let tall = start + length * 0.45, held = start + length * 0.6
        play(figure, "transform.scale.x", "bear.stretchX", [(0, 1), (start, 1), (tall, 0.97), (start + length, 1)])
        play(figure, "transform.scale.y", "bear.stretchY", [(0, 1), (start, 1), (tall, 1.08), (start + length, 1)])
        let down = 110 * Double.pi / 180
        play(arm, "transform.rotation.z", "bear.arm", [(0, down), (start, down), (tall, -6 * .pi / 180), (held, 0), (start + length, down)])
        play(arm, "opacity", "bear.armShown", [(0, 0), (start, 0), (tall, 1), (held, 1), (start + length, 0)])
    }

    /// Straight to sat, for a pooled cell getting another row.
    func settle() {
        for part in [sleeping, zs[0], zs[1], figure, satShut, sat, eye, arm] { part.removeAllAnimations() }
    }

    override func layOut(side: CGFloat, drawing: Drawing) {
        let square = CGRect(x: 0, y: 0, width: side, height: side)
        let small = side < BearGeometry.smallSide
        Self.pin(sleeping, about: BearGeometry.sleepingCentre, square: square)
        Self.fill(sleeping, BearGeometry.sleepingHead(small: small, hat: hat), square: square, drawing)
        for (z, path) in zip(zs, BearGeometry.sleepZs) {
            z.frame = square
            Self.fill(z, [BearGeometry.Ink(path: path, width: BearGeometry.Face.shutWidth)], square: square, drawing)
        }
        Self.pin(figure, about: BearGeometry.sitFeet, square: square)
        let shut = BearGeometry.sitFace(small: small, eyes: .shut, hat: hat), open = BearGeometry.sitFace(small: small, hat: hat)
        satShut.frame = square
        Self.fill(satShut, BearGeometry.sitBody(face: shut) + shut.inks, square: square, drawing)
        sat.frame = square
        Self.fill(sat, BearGeometry.sitBody(face: open) + open.stillInks + open.pomInks, square: square, drawing)
        let eyeBox = open.blinkingEyes?.boundingBox ?? .zero
        Self.pin(eye, about: CGPoint(x: eyeBox.midX, y: eyeBox.midY), square: square)
        Self.fill(eye, open.blinkingEyes.map { [BearGeometry.Ink(path: $0, width: nil)] } ?? [], square: square, drawing)
        armClip.frame = square
        armClip.mask = Self.mask(outside: BearGeometry.sitOutline(hat: hat), square: square, drawing)
        Self.pin(arm, about: BearGeometry.stretchShoulder, square: square)
        var parts = [BearGeometry.Ink(path: BearGeometry.stretchArm, width: BearGeometry.line)]
        if let pad = BearGeometry.stretchPad(small: small) { parts.append(BearGeometry.Ink(path: pad, width: nil)) }
        Self.fill(arm, parts, square: square, drawing)
    }

    #if DEBUG
    /// Draws the bear `seconds` into waking up, from the real tracks, for
    /// BearTests' BEAR_FRAMES_WOKEN. Core Animation can't be sampled to a
    /// bitmap, least of all with the screen locked.
    func renderFrame(at seconds: Double, in context: CGContext) {
        let parts = [sleeping, zs[0], zs[1], figure, satShut, sat, eye, arm]
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        var opacities: [ObjectIdentifier: Float] = [:]
        for part in parts {
            opacities[ObjectIdentifier(part)] = part.opacity
            for key in part.animationKeys() ?? [] {
                guard let track = part.animation(forKey: key) as? CAKeyframeAnimation, let keyPath = track.keyPath,
                      let values = track.values as? [Double], let times = track.keyTimes?.map(\.doubleValue) else { continue }
                let t = min(1, seconds / track.duration)
                let i = times.lastIndex { $0 <= t } ?? 0, j = min(i + 1, values.count - 1)
                let f = min(1, (t - times[i]) / max(0.000_001, times[j] - times[i]))
                part.setValue(values[i] + (values[j] - values[i]) * f, forKeyPath: keyPath)
            }
        }
        CATransaction.commit()
        layer?.render(in: context)
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        for part in parts {
            part.opacity = opacities[ObjectIdentifier(part)] ?? 1
            part.setAffineTransform(.identity)
        }
        CATransaction.commit()
    }
    #endif
}
