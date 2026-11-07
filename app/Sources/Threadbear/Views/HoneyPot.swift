import SwiftUI
import ThreadbearCore

/// The Usage icon: a little line-drawn pot on the bear glyphs' 24 grid and
/// line weight, filled to the room left. Its honey is the only amber on the
/// rail, and faint, as usage is the one place amber means something. The
/// outline takes the colour around it like the other rail icons.
///
/// A spend drains it in a short step. A reset of the same login's window
/// (`HoneyLevel.refilled`) rises to the top over 700 ms with one drip down the
/// outside. Both are SwiftUI's own animations; under Reduce Motion the level
/// just changes and there's no drip.
struct HoneyPot: View {
    /// 0 to 1.
    let level: Double
    /// Which login the level is for, as the pot changing hands isn't a refill.
    let login: String?

    @State private var shown: Double?
    @State private var drips = 0

    static let honey = Color(red: 217 / 255, green: 164 / 255, blue: 65 / 255)

    var body: some View {
        let grid = zoomed(21) / 24
        ZStack {
            // Slides up and down behind the body, clipped to it: rim to floor
            // is 9.6 to 20.8 on the grid.
            Rectangle()
                .fill(Self.honey.opacity(0.55))
                .offset(y: (9.6 + (1 - (shown ?? level)) * 11.2) * grid)
                .clipShape(PotBodyShape())
            PotShape()
                .stroke(style: StrokeStyle(lineWidth: grid * 1.6, lineCap: .round, lineJoin: .round))
            DripShape()
                .fill(Self.honey.opacity(0.9))
                .keyframeAnimator(initialValue: Drip(), trigger: drips) { drop, drip in
                    drop.opacity(drip.opacity).offset(x: drip.x, y: drip.y)
                } keyframes: { _ in
                    KeyframeTrack(\.opacity) {
                        LinearKeyframe(1, duration: 0.14)
                        LinearKeyframe(0, duration: 0.34)
                    }
                    KeyframeTrack(\.y) {
                        CubicKeyframe(zoomed(1), duration: 0.14)
                        CubicKeyframe(zoomed(5), duration: 0.34)
                    }
                    KeyframeTrack(\.x) {
                        CubicKeyframe(zoomed(0.7), duration: 0.14)
                        CubicKeyframe(zoomed(1.9), duration: 0.34)
                    }
                }
        }
        .frame(width: zoomed(21), height: zoomed(21))
        .onChange(of: Reading(level: level, login: login)) { old, new in change(from: old, to: new) }
        .onAppear { shown = level }
        .accessibilityHidden(true)
    }

    private func change(from old: Reading, to new: Reading) {
        if Juice.reduceMotion {
            shown = new.level
        } else if HoneyLevel.refilled(from: old.level, to: new.level, sameLogin: old.login == new.login) {
            withAnimation(.timingCurve(0.2, 0.8, 0.3, 1, duration: 0.7)) { shown = new.level }
            // Near the top of the rise, as the honey gets to the rim.
            Task {
                try? await Task.sleep(for: .milliseconds(520))
                drips += 1
            }
        } else {
            withAnimation(.easeOut(duration: 0.26)) { shown = new.level }
        }
    }

    /// Together, so a change of login and level is seen as one change.
    private struct Reading: Equatable {
        let level: Double
        let login: String?
    }

    private struct Drip {
        var opacity = 0.0
        var x = 0.0
        var y = 0.0
    }
}

/// The inside of the pot, for the honey.
private struct PotBodyShape: Shape {
    nonisolated func path(in rect: CGRect) -> Path { PotShape.bodyPath(in: rect.size) }
}

/// The pot's outline: body, rim, lid and knob.
struct PotShape: Shape {
    nonisolated static func bodyPath(in size: CGSize) -> Path {
        var body = Path()
        body.move(to: CGPoint(x: 8.2, y: 9.6))
        body.addCurve(to: CGPoint(x: 7.6, y: 20.8), control1: CGPoint(x: 4.2, y: 10.6), control2: CGPoint(x: 3.6, y: 19.4))
        body.addLine(to: CGPoint(x: 16.4, y: 20.8))
        body.addCurve(to: CGPoint(x: 15.8, y: 9.6), control1: CGPoint(x: 20.4, y: 19.4), control2: CGPoint(x: 19.8, y: 10.6))
        body.closeSubpath()
        let scale = size.width / 24
        return body.applying(CGAffineTransform(scaleX: scale, y: scale))
    }

    nonisolated func path(in rect: CGRect) -> Path {
        var pot = Self.bodyPath(in: CGSize(width: 24, height: 24))
        // Rim.
        pot.addRoundedRect(in: CGRect(x: 7, y: 7.1, width: 10, height: 2.5), cornerSize: CGSize(width: 1.25, height: 1.25))
        // Lid.
        pot.move(to: CGPoint(x: 8.4, y: 7.1))
        pot.addCurve(to: CGPoint(x: 15.6, y: 7.1), control1: CGPoint(x: 9, y: 4.9), control2: CGPoint(x: 15, y: 4.9))
        // Knob.
        pot.addEllipse(in: CGRect(x: 11.1, y: 3.2, width: 1.8, height: 1.8))
        let scale = rect.width / 24
        return pot.applying(CGAffineTransform(scaleX: scale, y: scale))
    }
}

/// The one drip, at its starting place on the shoulder of the pot.
private struct DripShape: Shape {
    nonisolated func path(in rect: CGRect) -> Path {
        var drop = Path()
        drop.move(to: CGPoint(x: 18.1, y: 8.4))
        drop.addCurve(to: CGPoint(x: 19.1, y: 10.5), control1: CGPoint(x: 18.65, y: 9.3), control2: CGPoint(x: 19.1, y: 9.95))
        drop.addArc(center: CGPoint(x: 18.1, y: 10.5), radius: 1, startAngle: .degrees(0), endAngle: .degrees(180), clockwise: false)
        drop.addCurve(to: CGPoint(x: 18.1, y: 8.4), control1: CGPoint(x: 17.1, y: 9.95), control2: CGPoint(x: 17.55, y: 9.3))
        let scale = rect.width / 24
        return drop.applying(CGAffineTransform(scaleX: scale, y: scale))
    }
}
