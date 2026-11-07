import AppKit
import QuartzCore
import SwiftUI
import ThreadbearCore

/// Voice mode's avatar: Threadbear's mascot as in its sprites
/// (docs/threadbear-design/sprites): tan fur, cream ears and muzzle, a
/// patch with a button eye, a stitched seam. It blinks and its ears perk
/// while it listens, nods along as Mike talks, looks up with thought dots
/// while the agent works, and opens its mouth in time with its own voice.
///
/// Its parts are layers moved by Core Animation, which runs off the main
/// thread (AGENTS.md, Animations): it keeps moving while the app is busy,
/// and costs the main thread nothing between changes. The app only says
/// what mood it's in, and how loud, a few times a second.
struct VoiceBear: NSViewRepresentable {
    enum Mood: Equatable { case waking, listening, hearing, thinking, speaking }

    let mood: Mood
    /// 0...1: his voice while listening, its own while speaking.
    let level: CGFloat

    func makeNSView(context: Context) -> VoiceBearView { VoiceBearView() }

    func updateNSView(_ view: VoiceBearView, context: Context) {
        view.set(mood: mood)
        view.set(level: level)
        view.setAccessibilityLabel(label)
    }

    private var label: String {
        switch mood {
        case .waking: "The bear, waking up"
        case .listening: "The bear, listening"
        case .hearing: "The bear, listening to you"
        case .thinking: "The bear, thinking"
        case .speaking: "The bear, talking"
        }
    }
}

final class VoiceBearView: NSView {
    // The mascot's colours (docs/threadbear-design/sprites).
    private static let fur = CGColor(srgbRed: 0.84, green: 0.58, blue: 0.33, alpha: 1)
    private static let furEdge = CGColor(srgbRed: 0.66, green: 0.42, blue: 0.21, alpha: 1)
    private static let cream = CGColor(srgbRed: 0.96, green: 0.84, blue: 0.67, alpha: 1)
    private static let creamSoft = CGColor(srgbRed: 0.96, green: 0.84, blue: 0.67, alpha: 0.8)
    private static let patch = CGColor(srgbRed: 0.45, green: 0.31, blue: 0.21, alpha: 1)
    private static let button = CGColor(srgbRed: 0.42, green: 0.27, blue: 0.18, alpha: 1)
    private static let buttonRim = CGColor(srgbRed: 0.30, green: 0.19, blue: 0.12, alpha: 1)
    private static let thread = CGColor(srgbRed: 0.55, green: 0.36, blue: 0.19, alpha: 1)
    private static let dark = CGColor(srgbRed: 0.20, green: 0.12, blue: 0.08, alpha: 1)
    private static let tongue = CGColor(srgbRed: 0.85, green: 0.45, blue: 0.45, alpha: 1)
    private static let white = CGColor(srgbRed: 1, green: 1, blue: 1, alpha: 1)

    /// Drawn on a 24 by 24 grid, scaled to the view by `canvas`.
    private static let grid: CGFloat = 24
    private static let center = CGPoint(x: 11.4, y: 13.6)

    private let canvas = CALayer()
    private let head = CALayer()
    private let ears = CALayer()
    private let eye = CALayer()
    private let openEye = CALayer()
    private let shutEye = CAShapeLayer()
    private let smile = CAShapeLayer()
    private let mouth = CALayer()
    private var dots: [CAShapeLayer] = []
    private var mood: VoiceBear.Mood?
    private var level: CGFloat = 0

    override init(frame: NSRect) {
        super.init(frame: frame)
        wantsLayer = true
        layer?.addSublayer(canvas)
        build()
    }

    required init?(coder: NSCoder) { fatalError("not from a nib") }

    override func layout() {
        super.layout()
        // Not animated: this is the view's size, not the bear moving.
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        let side = min(bounds.width, bounds.height)
        canvas.anchorPoint = .zero
        canvas.bounds = CGRect(x: 0, y: 0, width: Self.grid, height: Self.grid)
        canvas.position = CGPoint(x: (bounds.width - side) / 2, y: (bounds.height - side) / 2)
        // The drawing's y runs down, as it did in a SwiftUI Canvas.
        canvas.transform = CATransform3DConcat(
            CATransform3DMakeScale(side / Self.grid, -side / Self.grid, 1),
            CATransform3DMakeTranslation(0, side, 0))
        sharpen()
        CATransaction.commit()
    }

    override func setFrameSize(_ newSize: NSSize) {
        super.setFrameSize(newSize)
        needsLayout = true
    }

    override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        sharpen()
        // Moving again after coming back to a window.
        if window != nil, let mood {
            self.mood = nil
            set(mood: mood)
        }
    }

    /// Shapes draw on a small grid that's scaled up, so each needs that many
    /// more pixels to be sharp on this screen.
    private func sharpen() {
        let side = min(bounds.width, bounds.height)
        guard side > 0 else { return }
        let scale = (window?.backingScaleFactor ?? 2) * side / Self.grid
        func walk(_ layer: CALayer) {
            layer.contentsScale = scale
            for sublayer in layer.sublayers ?? [] { walk(sublayer) }
        }
        walk(canvas)
    }

    // MARK: What the app tells it

    func set(level new: CGFloat) {
        guard new != level else { return }
        // Quick to open, slower to close, so the mouth doesn't flicker.
        level = new > level ? new : level * 0.6 + new * 0.4
        guard mood == .speaking else { return }
        CATransaction.begin()
        CATransaction.setAnimationDuration(0.1)
        mouth.transform = CATransform3DMakeScale(1, max(0.25, min(1, level)), 1)
        CATransaction.commit()
    }

    func set(mood new: VoiceBear.Mood) {
        guard new != mood else { return }
        mood = new
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        for layer in [head, ears, eye] + dots { layer.removeAllAnimations() }
        head.transform = CATransform3DIdentity
        ears.transform = CATransform3DIdentity
        eye.transform = CATransform3DIdentity
        let waking = new == .waking, speaking = new == .speaking, thinking = new == .thinking
        openEye.isHidden = waking
        shutEye.isHidden = !waking
        smile.isHidden = speaking
        mouth.isHidden = !speaking
        for dot in dots { dot.opacity = 0 }
        if speaking { mouth.transform = CATransform3DMakeScale(1, max(0.25, min(1, level)), 1) }
        if thinking { eye.transform = CATransform3DMakeTranslation(0.6, -0.7, 0) }
        if new == .hearing { head.transform = CATransform3DMakeRotation(.pi / 30, 0, 0, 1) }
        CATransaction.commit()

        // Holding still is the whole of it with Reduce Motion on.
        guard !Juice.reduceMotion else { return }
        switch new {
        case .waking:
            head.add(Self.loop("transform.rotation.z", from: -.pi / 30, to: 0, seconds: 2, reverses: false), forKey: "move")
        case .listening:
            head.add(Self.loop("transform.rotation.z", from: -.pi / 45, to: .pi / 45, seconds: 3.9), forKey: "move")
            ears.add(Self.loop("transform.translation.y", from: -0.4, to: -0.6, seconds: 1), forKey: "perk")
        case .hearing:
            // On top of its tilt, so the nod is a value of its own.
            head.add(Self.loop("transform.translation.y", from: -0.4, to: 0.4, seconds: 0.35), forKey: "move")
            ears.add(Self.loop("transform.translation.y", from: -0.2, to: -0.8, seconds: 1), forKey: "perk")
        case .thinking:
            head.add(Self.loop("transform.rotation.z", from: -.pi / 30, to: .pi / 30, seconds: 2.4), forKey: "move")
            for (i, dot) in dots.enumerated() {
                let rise = CAKeyframeAnimation(keyPath: "opacity")
                rise.values = [0, 1, 0]
                rise.keyTimes = [0, 0.5, 1]
                rise.duration = 1.5
                rise.repeatCount = .infinity
                rise.isRemovedOnCompletion = false
                // One after another.
                rise.beginTime = CACurrentMediaTime() + Double(i) * 0.35
                dot.add(rise, forKey: "rise")
            }
        case .speaking:
            head.add(Self.loop("transform.translation.y", from: -0.3, to: 0.3, seconds: 0.22), forKey: "move")
        }
        // A blink every few seconds, in every mood but waking.
        if !waking {
            let blink = CAKeyframeAnimation(keyPath: "transform.scale.y")
            blink.values = [1, 1, 0.1, 1]
            blink.keyTimes = [0, 0.96, 0.98, 1]
            blink.duration = 4.2
            blink.repeatCount = .infinity
            blink.isRemovedOnCompletion = false
            openEye.add(blink, forKey: "blink")
        } else {
            openEye.removeAnimation(forKey: "blink")
        }
    }

    private static func loop(_ keyPath: String, from: CGFloat, to: CGFloat, seconds: CFTimeInterval, reverses: Bool = true) -> CABasicAnimation {
        let move = CABasicAnimation(keyPath: keyPath)
        move.fromValue = from
        move.toValue = to
        move.duration = seconds
        move.autoreverses = reverses
        move.repeatCount = .infinity
        move.isRemovedOnCompletion = false
        move.timingFunction = CAMediaTimingFunction(name: .easeInEaseOut)
        return move
    }

    // MARK: Drawing, once

    private func shape(_ path: Path, fill: CGColor? = nil, stroke: CGColor? = nil, width: CGFloat = 0, dash: [NSNumber]? = nil) -> CAShapeLayer {
        let layer = CAShapeLayer()
        layer.path = path.cgPath
        layer.fillColor = fill
        layer.strokeColor = stroke
        layer.lineWidth = width
        layer.lineCap = .round
        layer.lineDashPattern = dash
        return layer
    }

    /// A layer the size of the grid whose moves turn about `pivot`.
    private func group(_ layer: CALayer, pivot: CGPoint) {
        layer.bounds = CGRect(x: 0, y: 0, width: Self.grid, height: Self.grid)
        layer.anchorPoint = CGPoint(x: pivot.x / Self.grid, y: pivot.y / Self.grid)
        layer.position = pivot
    }

    private func circle(_ c: CGPoint, _ r: CGFloat) -> Path {
        Path(ellipseIn: CGRect(x: c.x - r, y: c.y - r, width: 2 * r, height: 2 * r))
    }

    private func build() {
        let c = Self.center
        let rx: CGFloat = 8.3, ry: CGFloat = 7.5, edge: CGFloat = 0.45
        canvas.addSublayer(head)
        group(head, pivot: c)
        group(ears, pivot: c)
        head.addSublayer(ears)

        // Ears, behind the head: round, cream inside.
        for sign in [-1.0, 1.0] as [CGFloat] {
            let e = CGPoint(x: c.x + sign * rx * 0.78, y: c.y - ry * 0.78)
            ears.addSublayer(shape(circle(e, 3), fill: Self.fur, stroke: Self.furEdge, width: edge))
            ears.addSublayer(shape(circle(CGPoint(x: e.x + sign * 0.2, y: e.y + 0.3), 1.7), fill: Self.cream))
        }

        // The head, a little wider than tall.
        let face = Path(ellipseIn: CGRect(x: c.x - rx, y: c.y - ry, width: 2 * rx, height: 2 * ry))
        head.addSublayer(shape(face, fill: Self.fur, stroke: Self.furEdge, width: edge))

        // The patch over his right eye (our left), stitched round its edge,
        // kept to the face.
        var patch = Path()
        patch.move(to: CGPoint(x: c.x - rx * 0.95, y: c.y - ry * 0.55))
        patch.addLine(to: CGPoint(x: c.x - rx * 0.32, y: c.y - ry * 0.78))
        patch.addLine(to: CGPoint(x: c.x - rx * 0.12, y: c.y - ry * 0.12))
        patch.addLine(to: CGPoint(x: c.x - rx * 0.70, y: c.y + ry * 0.12))
        patch.closeSubpath()
        let clipped = CALayer()
        clipped.frame = CGRect(x: 0, y: 0, width: Self.grid, height: Self.grid)
        clipped.mask = shape(face, fill: Self.white)
        clipped.addSublayer(shape(patch, fill: Self.patch))
        clipped.addSublayer(shape(patch, stroke: Self.creamSoft, width: 0.28, dash: [0.55, 0.45]))
        head.addSublayer(clipped)

        // The seam down the forehead, with cross-stitches.
        var seam = Path()
        seam.move(to: CGPoint(x: c.x + 0.4, y: c.y - ry))
        seam.addQuadCurve(to: CGPoint(x: c.x + 0.2, y: c.y - ry * 0.18), control: CGPoint(x: c.x + 0.9, y: c.y - ry * 0.6))
        head.addSublayer(shape(seam, stroke: Self.thread, width: 0.3))
        for f in [0.25, 0.55, 0.82] as [CGFloat] {
            let y = c.y - ry + (ry * 0.82) * f
            let x = c.x + 0.4 + 0.35 * sin(f * .pi)
            var cross = Path()
            cross.move(to: CGPoint(x: x - 0.45, y: y - 0.35)); cross.addLine(to: CGPoint(x: x + 0.45, y: y + 0.35))
            cross.move(to: CGPoint(x: x + 0.45, y: y - 0.35)); cross.addLine(to: CGPoint(x: x - 0.45, y: y + 0.35))
            head.addSublayer(shape(cross, stroke: Self.thread, width: 0.28))
        }

        // The button eye, on the patch: four holes and a cross of thread.
        let eyeY = c.y - ry * 0.12
        let bc = CGPoint(x: c.x - rx * 0.42, y: eyeY + 0.45)
        let br: CGFloat = 2.15
        head.addSublayer(shape(circle(bc, br), fill: Self.button))
        head.addSublayer(shape(circle(bc, br * 0.78), stroke: Self.buttonRim, width: 0.25))
        for (dx, dy) in [(-0.55, -0.55), (0.55, -0.55), (-0.55, 0.55), (0.55, 0.55)] as [(CGFloat, CGFloat)] {
            head.addSublayer(shape(circle(CGPoint(x: bc.x + dx, y: bc.y + dy), 0.2), fill: Self.dark))
        }
        var x = Path()
        x.move(to: CGPoint(x: bc.x - 0.55, y: bc.y - 0.55)); x.addLine(to: CGPoint(x: bc.x + 0.55, y: bc.y + 0.55))
        x.move(to: CGPoint(x: bc.x + 0.55, y: bc.y - 0.55)); x.addLine(to: CGPoint(x: bc.x - 0.55, y: bc.y + 0.55))
        head.addSublayer(shape(x, stroke: Self.cream, width: 0.22))

        // The real eye: shiny, or shut while it wakes.
        let ec = CGPoint(x: c.x + rx * 0.45, y: eyeY)
        group(eye, pivot: ec)
        group(openEye, pivot: ec)
        let ew: CGFloat = 0.95, eh: CGFloat = 1.25
        openEye.addSublayer(shape(Path(ellipseIn: CGRect(x: ec.x - ew, y: ec.y - eh, width: 2 * ew, height: 2 * eh)), fill: Self.dark))
        openEye.addSublayer(shape(Path(ellipseIn: CGRect(x: ec.x - 0.05, y: ec.y - eh * 0.7, width: 0.6, height: 0.6)), fill: Self.white))
        eye.addSublayer(openEye)
        var shut = Path()
        shut.move(to: CGPoint(x: ec.x - 0.9, y: ec.y))
        shut.addQuadCurve(to: CGPoint(x: ec.x + 0.9, y: ec.y), control: CGPoint(x: ec.x, y: ec.y + 0.8))
        shutEye.path = shut.cgPath
        shutEye.fillColor = nil
        shutEye.strokeColor = Self.dark
        shutEye.lineWidth = 0.45
        shutEye.lineCap = .round
        eye.addSublayer(shutEye)
        head.addSublayer(eye)

        // Muzzle, nose and mouth.
        let mc = CGPoint(x: c.x + 0.2, y: c.y + ry * 0.42)
        head.addSublayer(shape(Path(ellipseIn: CGRect(x: mc.x - 2.9, y: mc.y - 2.1, width: 5.8, height: 4.2)), fill: Self.cream))
        let nose = CGPoint(x: mc.x, y: mc.y - 0.9)
        var n = Path()
        n.move(to: CGPoint(x: nose.x - 0.95, y: nose.y - 0.4))
        n.addQuadCurve(to: CGPoint(x: nose.x + 0.95, y: nose.y - 0.4), control: CGPoint(x: nose.x, y: nose.y - 0.9))
        n.addQuadCurve(to: CGPoint(x: nose.x - 0.95, y: nose.y - 0.4), control: CGPoint(x: nose.x, y: nose.y + 1.0))
        head.addSublayer(shape(n, fill: Self.dark))
        let mouthY = nose.y + 0.45
        var line = Path()
        line.move(to: CGPoint(x: mc.x, y: mouthY - 0.1))
        line.addLine(to: CGPoint(x: mc.x, y: mouthY + 0.35))
        line.move(to: CGPoint(x: mc.x - 1.1, y: mouthY + 0.1))
        line.addQuadCurve(to: CGPoint(x: mc.x, y: mouthY + 0.35), control: CGPoint(x: mc.x - 0.6, y: mouthY + 0.9))
        line.addQuadCurve(to: CGPoint(x: mc.x + 1.1, y: mouthY + 0.1), control: CGPoint(x: mc.x + 0.6, y: mouthY + 0.9))
        smile.path = line.cgPath
        smile.fillColor = nil
        smile.strokeColor = Self.dark
        smile.lineWidth = 0.35
        smile.lineCap = .round
        head.addSublayer(smile)
        // The mouth wide open; its height follows the voice, from the top.
        let open: CGFloat = 2.3
        let top = mouthY + 0.1
        group(mouth, pivot: CGPoint(x: mc.x, y: top))
        mouth.addSublayer(shape(Path(roundedRect: CGRect(x: mc.x - 0.95, y: top, width: 1.9, height: open), cornerRadius: 0.9), fill: Self.dark))
        mouth.addSublayer(shape(Path(ellipseIn: CGRect(x: mc.x - 0.6, y: top + open * 0.5, width: 1.2, height: open * 0.5)), fill: Self.tongue))
        head.addSublayer(mouth)

        // Thought dots while it works, rising one after another.
        for i in 0..<3 {
            let d = 0.6 + CGFloat(i) * 0.35
            let p = CGPoint(x: 19.6 + CGFloat(i) * 1.2, y: 5.6 - CGFloat(i) * 1.5)
            let dot = shape(circle(p, d), fill: Self.cream, stroke: Self.furEdge, width: 0.25)
            dot.opacity = 0
            canvas.addSublayer(dot)
            dots.append(dot)
        }
    }
}

/// The stage above the message box while Voice is on: the bear, and in a
/// bubble beside it what he's saying or what it's doing.
struct VoiceStage: View {
    let threadId: String
    @State private var voice = VoiceMode.shared

    var body: some View {
        HStack(alignment: .center, spacing: 10) {
            Spacer(minLength: 0)
            if let caption {
                Text(caption)
                    .font(.callout)
                    .foregroundStyle(captionIsHim ? .primary : .secondary)
                    .lineLimit(3)
                    .truncationMode(.head)
                    .padding(.horizontal, 12)
                    .padding(.vertical, 8)
                    .background(RoundedRectangle(cornerRadius: 14).fill(Color.primary.opacity(0.06)))
                    .frame(maxWidth: 360, alignment: .trailing)
                    .tip(caption)
            }
            VoiceBear(mood: mood, level: CGFloat(voice.level))
                .frame(width: 84, height: 84)
        }
        .padding(.horizontal, 12)
        .padding(.bottom, 6)
        .transition(.move(edge: .bottom).combined(with: .opacity))
    }

    private var mood: VoiceBear.Mood {
        switch voice.phase {
        case .starting: .waking
        case .listening, .off, .failed: .listening
        case .hearing: .hearing
        case .thinking: .thinking
        case .speaking: .speaking
        }
    }

    private var captionIsHim: Bool {
        if case .hearing = voice.phase { return true }
        return false
    }

    private var caption: String? {
        switch voice.phase {
        case .starting(let status): status
        case .listening: "Listening…"
        case .hearing(let words): words.isEmpty ? "Listening…" : words
        case .thinking: "Working on it…"
        case .speaking: "Speaking"
        case .off, .failed: nil
        }
    }
}
