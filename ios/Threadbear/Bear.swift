import SwiftUI

/// The bear, drawn as line glyphs from BearGeometry, the same file as the Mac
/// app's, so it takes the text colour around it and stays crisp at any size.
struct BearView: View {
    typealias Pose = BearGeometry.Pose

    var pose: Pose
    var size: CGFloat = 22

    var body: some View {
        Canvas { context, canvas in
            let side = min(canvas.width, canvas.height)
            context.scaleBy(x: side / 24, y: side / 24)
            Self.draw(BearGeometry.inks(pose, side: side, hat: BearGeometry.wearsHat()), in: &context)
        }
        .frame(width: size, height: size)
        .accessibilityLabel(pose == .sleep ? "The bear, asleep" : pose == .wave ? "The bear, waving" : "The bear")
    }

    /// Draws inks in the text colour, on the grid the context is scaled to.
    static func draw(_ inks: [BearGeometry.Ink], in context: inout GraphicsContext) {
        for ink in inks {
            var layer = context
            if let outside = ink.outside {
                var clip = Path(CGRect(x: -24, y: -24, width: 72, height: 72))
                clip.addPath(Path(outside))
                layer.clip(to: clip, style: FillStyle(eoFill: true))
            }
            if let width = ink.width {
                layer.stroke(Path(ink.path), with: .foreground, style: StrokeStyle(lineWidth: width, lineCap: .round, lineJoin: .round))
            } else {
                layer.fill(Path(ink.path), with: .foreground)
            }
        }
    }
}

/// The working line's bear, alive: it pops up, gives a little wave every
/// few seconds, breathes and blinks, with the same timings as the Mac's
/// WavingBearView. The wave comes in bursts rather than flapping non-stop
/// beside the text. Under Reduce Motion it's the still pose.
struct WavingBear: View {
    var size: CGFloat = 24
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var arrived = false

    var body: some View {
        if reduceMotion {
            BearView(pose: .wave, size: size)
        } else {
            let feet = UnitPoint(x: BearGeometry.feet.x / 24, y: BearGeometry.feet.y / 24)
            let face = BearGeometry.waveFace(small: size < BearGeometry.smallSide, hat: BearGeometry.wearsHat())
            let eye = face.blinkingEyes?.boundingBox ?? .zero
            let shoulder = UnitPoint(x: BearGeometry.shoulder.x / 24, y: BearGeometry.shoulder.y / 24)
            ZStack {
                // The arm first, behind the head. The clip stays put while the
                // arm turns inside it, so the arm always hugs the head.
                part(pawInks(small: size < BearGeometry.smallSide))
                    .keyframeAnimator(initialValue: 0.0, repeating: true) { paw, angle in
                        paw.rotationEffect(.degrees(angle), anchor: shoulder)
                    } keyframes: { _ in
                        KeyframeTrack { Self.waveKeyframes(scale: 1) }
                    }
                    .mask { OutsideHead(head: Path(face.head)).fill(style: FillStyle(eoFill: true)) }
                // The eye blinks on its own; the other one's a button, and
                // buttons don't.
                part(face.stillInks)
                // The Santa hat's pom-pom in December, a beat behind the paw.
                part(face.pomInks)
                    .keyframeAnimator(initialValue: 0.0, repeating: true) { pom, angle in
                        let tip = face.hatTip ?? .zero
                        return pom.rotationEffect(.degrees(angle), anchor: UnitPoint(x: tip.x / 24, y: tip.y / 24))
                    } keyframes: { _ in
                        KeyframeTrack {
                            LinearKeyframe(0, duration: 0.1)
                            CubicKeyframe(-42, duration: 0.16)
                            CubicKeyframe(-9, duration: 0.22)
                            CubicKeyframe(-42, duration: 0.22)
                            CubicKeyframe(-9, duration: 0.22)
                            CubicKeyframe(-30, duration: 0.22)
                            CubicKeyframe(0, duration: 0.26)
                            CubicKeyframe(18, duration: 0.12)
                            CubicKeyframe(-7.5, duration: 0.14)
                            CubicKeyframe(0, duration: 0.14)
                            LinearKeyframe(0, duration: 4.2)
                        }
                    }
                part(face.blinkingEyes.map { [BearGeometry.Ink(path: $0, width: nil)] } ?? [])
                    .keyframeAnimator(initialValue: 1.0, repeating: true) { eyes, open in
                        eyes.scaleEffect(y: open, anchor: UnitPoint(x: eye.midX / 24, y: eye.midY / 24))
                    } keyframes: { _ in
                        // One blink partway through, then a double one.
                        KeyframeTrack {
                            LinearKeyframe(1, duration: 3)
                            LinearKeyframe(0.12, duration: 0.06)
                            LinearKeyframe(1, duration: 0.08)
                            LinearKeyframe(1, duration: 3.56)
                            LinearKeyframe(0.12, duration: 0.06)
                            LinearKeyframe(1, duration: 0.08)
                            LinearKeyframe(0.12, duration: 0.06)
                            LinearKeyframe(1, duration: 0.08)
                            LinearKeyframe(1, duration: 0.32)
                        }
                    }
            }
            .frame(width: size, height: size)
            // The whole bear leans with the wave, a fraction as far.
            .keyframeAnimator(initialValue: 0.0, repeating: true) { bear, angle in
                bear.rotationEffect(.degrees(angle), anchor: feet)
            } keyframes: { _ in
                KeyframeTrack { Self.waveKeyframes(scale: -0.16) }
            }
            .keyframeAnimator(initialValue: 1.0, repeating: true) { bear, scale in
                bear.scaleEffect(scale, anchor: feet)
            } keyframes: { _ in
                KeyframeTrack {
                    CubicKeyframe(1.03, duration: 1.7)
                    CubicKeyframe(1, duration: 1.7)
                }
            }
            .scaleEffect(arrived ? 1 : 0.4, anchor: feet)
            .onAppear {
                withAnimation(.spring(response: 0.35, dampingFraction: 0.5)) { arrived = true }
            }
            .accessibilityElement()
            .accessibilityLabel("The bear, waving")
        }
    }

    /// The paw's swing, six seconds from rest to rest: a burst of waving,
    /// then a pause. Outward only, as at rest it's already close to the ear.
    @KeyframeTrackContentBuilder<Double>
    private static func waveKeyframes(scale: Double) -> some KeyframeTrackContent<Double> {
        CubicKeyframe(14 * scale, duration: 0.16)
        CubicKeyframe(3 * scale, duration: 0.22)
        CubicKeyframe(14 * scale, duration: 0.22)
        CubicKeyframe(3 * scale, duration: 0.22)
        CubicKeyframe(10 * scale, duration: 0.22)
        CubicKeyframe(0, duration: 0.26)
        LinearKeyframe(0, duration: 4.7)
    }

    /// One part of the pose on its own canvas, so it can move by itself.
    private func pawInks(small: Bool) -> [BearGeometry.Ink] {
        var inks = [BearGeometry.Ink(path: BearGeometry.arm, width: BearGeometry.line)]
        if let pad = BearGeometry.pawPad(small: small) { inks.append(BearGeometry.Ink(path: pad, width: nil)) }
        return inks
    }

    private func part(_ inks: [BearGeometry.Ink]) -> some View {
        BearPart(inks: inks, size: size)
    }
}

/// The bear waving the once, for when `waves` goes up: the paw swings and the
/// whole bear tilts from its feet, three quick tilts as the Mac's InboxZero has,
/// and it stops. Until then, and after, it's the wave pose holding still.
struct WaveOnceBear: View {
    var size: CGFloat = 46
    var waves: Int

    var body: some View {
        let small = size < BearGeometry.smallSide
        let face = BearGeometry.waveFace(small: small)
        let shoulder = UnitPoint(x: BearGeometry.shoulder.x / 24, y: BearGeometry.shoulder.y / 24)
        let feet = UnitPoint(x: BearGeometry.feet.x / 24, y: BearGeometry.feet.y / 24)
        var paw = [BearGeometry.Ink(path: BearGeometry.arm, width: BearGeometry.line)]
        if let pad = BearGeometry.pawPad(small: small) { paw.append(BearGeometry.Ink(path: pad, width: nil)) }
        return ZStack {
            BearPart(inks: paw, size: size)
                .keyframeAnimator(initialValue: 0.0, trigger: waves) { arm, angle in
                    arm.rotationEffect(.degrees(angle), anchor: shoulder)
                } keyframes: { _ in
                    KeyframeTrack {
                        CubicKeyframe(18, duration: 0.175)
                        CubicKeyframe(2, duration: 0.175)
                        CubicKeyframe(16, duration: 0.175)
                        CubicKeyframe(0, duration: 0.175)
                    }
                }
                .mask { OutsideHead(head: Path(face.head)).fill(style: FillStyle(eoFill: true)) }
            BearPart(inks: face.inks, size: size)
        }
        .frame(width: size, height: size)
        .keyframeAnimator(initialValue: 0.0, trigger: waves) { bear, angle in
            bear.rotationEffect(.degrees(angle), anchor: feet)
        } keyframes: { _ in
            KeyframeTrack {
                CubicKeyframe(-9, duration: 0.154)
                CubicKeyframe(7, duration: 0.182)
                CubicKeyframe(-5, duration: 0.154)
                CubicKeyframe(0, duration: 0.21)
            }
        }
        .accessibilityElement()
        .accessibilityLabel("The bear, waving")
    }
}

/// The sat bear for peeking over the inbox: its dot eye blinks when `blinks`
/// goes up (the button doesn't), and it gives a little nod when `nods` does.
struct PeekingBear: View {
    var size: CGFloat = 64
    var blinks: Int
    var nods: Int

    var body: some View {
        let small = size < BearGeometry.smallSide
        let face = BearGeometry.sitFace(small: small)
        let eye = face.blinkingEyes?.boundingBox ?? .zero
        let feet = UnitPoint(x: 0.5, y: 20 / 24)
        return ZStack {
            BearPart(inks: BearGeometry.sitBody(face: face) + face.stillInks, size: size)
            BearPart(inks: face.blinkingEyes.map { [BearGeometry.Ink(path: $0, width: nil)] } ?? [], size: size)
                .keyframeAnimator(initialValue: 1.0, trigger: blinks) { eyes, open in
                    eyes.scaleEffect(y: open, anchor: UnitPoint(x: eye.midX / 24, y: eye.midY / 24))
                } keyframes: { _ in
                    KeyframeTrack {
                        LinearKeyframe(0.1, duration: 0.085)
                        LinearKeyframe(1, duration: 0.085)
                    }
                }
        }
        .frame(width: size, height: size)
        .keyframeAnimator(initialValue: Nod(), trigger: nods) { bear, nod in
            bear.scaleEffect(y: nod.squash, anchor: feet).offset(y: nod.drop)
        } keyframes: { _ in
            KeyframeTrack(\.drop) {
                CubicKeyframe(2.2 * size / 24, duration: 0.133)
                CubicKeyframe(-0.6 * size / 24, duration: 0.133)
                CubicKeyframe(0, duration: 0.114)
            }
            KeyframeTrack(\.squash) {
                CubicKeyframe(0.95, duration: 0.133)
                CubicKeyframe(1.01, duration: 0.133)
                CubicKeyframe(1, duration: 0.114)
            }
        }
        .accessibilityHidden(true)
    }

    private struct Nod { var drop: CGFloat = 0; var squash: CGFloat = 1 }
}

/// Some of a pose on its own canvas, so it can move by itself.
private struct BearPart: View {
    var inks: [BearGeometry.Ink]
    var size: CGFloat

    var body: some View {
        Canvas { context, canvas in
            let scale = min(canvas.width, canvas.height) / 24
            context.scaleBy(x: scale, y: scale)
            BearView.draw(inks, in: &context)
        }
        .frame(width: size, height: size)
    }
}

/// Everywhere but the head, on the grid: the moving bear's arm shows only here.
/// Reaches well past the frame, so a paw swinging out doesn't get cut off.
nonisolated private struct OutsideHead: Shape {
    var head: Path

    func path(in rect: CGRect) -> Path {
        var path = Path(CGRect(x: -rect.width, y: -rect.height, width: rect.width * 3, height: rect.height * 3))
        path.addPath(head.applying(CGAffineTransform(scaleX: rect.width / 24, y: rect.height / 24)))
        return path
    }
}

/// "Bear with me · 12s" with the waving bear, while a turn runs. The
/// seconds count from when the phone first saw it working.
struct WorkingLine: View {
    var text: String?
    @State private var started = Date.now

    var body: some View {
        HStack(spacing: 8) {
            // Outside the timeline, so the once-a-second redraw of the
            // seconds leaves the bear's movement alone.
            WavingBear(size: 24)
            TimelineView(.periodic(from: .now, by: 1)) { context in
                Text(label(now: context.date))
                    .font(.subheadline)
                    .lineLimit(1)
            }
        }
        .foregroundStyle(.secondary)
    }

    private func label(now: Date) -> String {
        let seconds = max(0, Int(now.timeIntervalSince(started)))
        let elapsed = seconds < 60 ? "\(seconds)s" : "\(seconds / 60)m \(seconds % 60)s"
        guard let text, !text.isEmpty, text != "Bear with me" else { return "Bear with me · \(elapsed)" }
        return "\(text) · \(elapsed)"
    }
}

#Preview {
    VStack(spacing: 20) {
        HStack { ForEach(BearView.Pose.allCases, id: \.self) { BearView(pose: $0, size: 60) } }
        WorkingLine(text: "Running npm test")
    }
}
