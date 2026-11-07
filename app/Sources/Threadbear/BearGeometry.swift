import CoreGraphics
import Foundation

/// The line bear as paths on a 24 by 24 grid (y down): the one drawing behind
/// every pose, on the Mac and the iPhone. It was redrawn on 7 Nov 2026 to look
/// like the Dock icon, as the old one read more like a koala: a wide head with
/// small ears set wide, a nose and smile, a stitch, and one button eye, picked
/// from sketches in ~/dev/me/misc/threadbear-juice-mockups/bear-lab.
///
/// This file is identical in app/Sources/Threadbear and ios/Threadbear, as
/// the two apps share no package. BearTests fails if they differ.
enum BearGeometry {
    enum Pose: String, CaseIterable {
        /// Sat, looking at you: the background line while jobs run.
        case sit
        /// A paw up: "Bear with me", the working line.
        case wave
        /// Eyes shut, a couple of Zs: Hibernating.
        case sleep
        /// A smaller bear with big ears: sub-agents out in the background.
        case cub
    }

    /// The date and time the bear goes by when it's choosing what to do:
    /// `date`, unless a launch argument says otherwise, to see December in
    /// November or bedtime in the afternoon: `-ThreadbearBearDate
    /// 2026-12-24T23:00` (local time; `dev-app.sh start --bear-date`).
    static func date(_ date: Date = Date()) -> Date { pretendDate ?? date }

    private static let pretendDate: Date? = {
        guard let text = UserDefaults.standard.string(forKey: "ThreadbearBearDate") else { return nil }
        let format = DateFormatter()
        format.locale = Locale(identifier: "en_US_POSIX")
        format.dateFormat = "yyyy-MM-dd'T'HH:mm"
        return format.date(from: text)
    }()

    /// Whether the bear's in its Santa hat: 1 to 26 December, in beach weather
    /// where Mike lives, so a bear working through it is the joke. Gone on the 27th.
    static func wearsHat(on date: Date = BearGeometry.date(), calendar: Calendar = .current) -> Bool {
        let day = calendar.dateComponents([.month, .day], from: date)
        return day.month == 12 && (day.day ?? 0) <= 26
    }

    /// The waving pose's pom-pom on its own, drawn where the pose has it.
    /// On the grid, like the rest of the pose.
    static func wavePom(small: Bool) -> [Ink] { waveFace(small: small, hat: true).pomInks }

    /// The pom-pom's size on the grid: the same on any head, or a cub's vanishes.
    static let pomRadius: CGFloat = 1.3

    /// The main line's weight on the grid, about an SF Symbol's at this size.
    static let line: CGFloat = 1.6

    /// Below this many points the stitch, the button's pip and the paw's pad
    /// are just specks, so they go, the way SF Symbols thin out when small.
    static let smallSide: CGFloat = 20

    /// One thing to draw: stroked at `width`, or filled when that's nil,
    /// showing only outside `outside` when it's set, so outlines never cross.
    struct Ink {
        var path: CGPath
        var width: CGFloat?
        var outside: CGPath? = nil
    }

    enum Eyes { case button, plain, shut }

    /// Where a pose's Santa hat peaks and where its tip flops to, on the
    /// full-size head (BearGeometry.Face): each pose has its own room above it.
    struct Hat {
        var peak: CGFloat
        var tip: CGPoint
    }

    /// A head, centred at `centre` and `scale` times the full-size one. Its
    /// parts move about the grid with it, but the line weights stay the same.
    struct Face {
        var centre: CGPoint
        var scale: CGFloat
        var eyes: Eyes = .button
        var bigEars = false
        var stitched = true
        var small = false
        /// The December hat. Where its cone peaks and where its tip flops to,
        /// on the full-size head: each pose has its own room above the head.
        var hat: Hat? = nil

        /// A point on the full-size head (centre 12, 13.2), placed on this one.
        private func at(_ x: CGFloat, _ y: CGFloat) -> CGPoint {
            CGPoint(x: centre.x + (x - 12) * scale, y: centre.y + (y - 13.2) * scale)
        }
        /// Eyes shrink less than the head does, or they vanish on the sat bear.
        private var eyeScale: CGFloat { max(scale, 0.8) }

        var head: CGPath { ellipse(centre, 8.8 * scale, 8 * scale) }

        var ears: CGPath {
            let r = 3 * scale * (bigEars ? 1.28 : 1)
            let path = CGMutablePath()
            path.addPath(ellipse(at(5.3, 6.1), r, r))
            path.addPath(ellipse(at(18.7, 6.1), r, r))
            return path
        }

        /// The eye that blinks: the left one, or both on a cub. Nil when shut.
        var blinkingEyes: CGPath? {
            let r = 1.15 * eyeScale
            switch eyes {
            case .shut: return nil
            case .button: return ellipse(at(8, 11.6), r, r)
            case .plain:
                let path = CGMutablePath()
                path.addPath(ellipse(at(8, 11.6), r, r))
                path.addPath(ellipse(at(16, 11.6), r, r))
                return path
            }
        }

        /// The button sewn on in place of an eye. It's a button, so it doesn't blink.
        var buttonRing: CGPath? {
            eyes == .button ? ellipse(at(15.8, 11.4), 2.15 * scale, 2.15 * scale) : nil
        }
        var buttonPip: CGPath? {
            eyes == .button && !small ? ellipse(at(15.8, 11.4), 0.55 * eyeScale, 0.55 * eyeScale) : nil
        }
        static let buttonWidth = line * 0.72

        var shutEyes: CGPath? {
            guard eyes == .shut else { return nil }
            let path = CGMutablePath()
            for x: CGFloat in [8, 16] {
                let mid = at(x, 11.2), w = 1.6 * scale
                path.move(to: CGPoint(x: mid.x - w, y: mid.y))
                path.addQuadCurve(to: CGPoint(x: mid.x + w, y: mid.y), control: CGPoint(x: mid.x, y: mid.y + 1.4 * scale))
            }
            return path
        }
        static let shutWidth = line * 0.85

        /// The forehead stitch, over the good eye like a brow: a line and two ticks.
        var stitch: CGPath? {
            guard stitched, !small else { return nil }
            let path = CGMutablePath()
            for (from, to) in [(at(7.6, 8.4), at(11, 7.2)), (at(8.6, 7.1), at(9.1, 8.6)), (at(10, 6.6), at(10.4, 8.1))] {
                path.move(to: from)
                path.addLine(to: to)
            }
            return path
        }
        static let stitchWidth = line * 0.5

        var nose: CGPath { ellipse(at(12, 15.6), 1.9 * scale, 1.35 * scale) }

        var mouth: CGPath {
            let path = CGMutablePath()
            path.move(to: at(9.8, 18))
            path.addQuadCurve(to: at(14.2, 18), control: at(12, 19.7))
            return path
        }
        /// Thinner on a smaller head, where it would otherwise touch the nose.
        var mouthWidth: CGFloat { line * (scale < 0.75 ? 0.62 : 0.72) }

        // MARK: The December hat

        /// The fur across the crown: one thick line, as two thin ones would
        /// close up at this size. It sits above the stitch, so the bear keeps its scar.
        var hatBand: CGPath {
            let path = CGMutablePath()
            path.move(to: at(7.5, 6))
            path.addQuadCurve(to: at(16.7, 6.1), control: at(12.1, 2.9))
            return path
        }
        var bandWidth: CGFloat { small ? line * 1.3 : line * 1.5 }
        /// A soft cone up from the band, flopping over to the left, away from
        /// the waving paw, and open at the bottom where the band covers it.
        var hatCone: CGPath? {
            guard let hat else { return nil }
            let path = CGMutablePath()
            path.move(to: at(16.1, 4.4))
            path.addCurve(to: at(11.2, hat.peak), control1: at(15.9, hat.peak + 1.6), control2: at(14, hat.peak))
            path.addQuadCurve(to: at(hat.tip.x, hat.tip.y), control: at((hat.tip.x + 11.2) / 2 + 0.6, hat.peak - 0.1))
            path.addQuadCurve(to: at(8.7, 4.4), control: at(hat.tip.x + 2.2, (hat.tip.y + 4.4) / 2 - 0.2))
            return path
        }
        var hatWidth: CGFloat { line * 0.85 }
        /// Where the pom-pom hangs from; it swings about this on a bear that moves.
        var hatTip: CGPoint? { hat.map { at($0.tip.x, $0.tip.y) } }
        var hatPom: CGPath? {
            hatTip.map { tip in
                let r = BearGeometry.pomRadius
                return ellipse(CGPoint(x: tip.x - 1.15, y: tip.y + 0.95), r, r)
            }
        }
        /// What the hat covers, so the lines under it don't show through.
        var hatShape: CGPath? {
            guard let cone = hatCone?.mutableCopy() else { return nil }
            cone.closeSubpath()
            let band = hatBand.copy(strokingWithWidth: bandWidth, lineCap: .round, lineJoin: .round, miterLimit: 10)
            return band.union(cone)
        }

        /// All of the face but the eye that blinks, which moves on its own.
        var stillInks: [Ink] {
            var all = [Ink(path: ears, width: line, outside: head), Ink(path: head, width: line)]
            if let buttonRing { all.append(Ink(path: buttonRing, width: Self.buttonWidth)) }
            if let buttonPip { all.append(Ink(path: buttonPip, width: nil)) }
            if let shutEyes { all.append(Ink(path: shutEyes, width: Self.shutWidth)) }
            if let stitch { all.append(Ink(path: stitch, width: Self.stitchWidth)) }
            all.append(Ink(path: nose, width: nil))
            all.append(Ink(path: mouth, width: mouthWidth))
            guard let shape = hatShape, let hatCone else { return all }
            // Tucked under the hat: nothing of the head shows through it.
            let tucked = all.map { ink in
                Ink(path: ink.path, width: ink.width, outside: ink.outside.map { $0.union(shape) } ?? shape)
            }
            return tucked + [Ink(path: hatCone, width: hatWidth), Ink(path: hatBand, width: bandWidth)]
        }

        /// Separate from the hat, as it lags behind on a bear that moves.
        var pomInks: [Ink] { hatPom.map { [Ink(path: $0, width: nil)] } ?? [] }

        var eyeInks: [Ink] { blinkingEyes.map { [Ink(path: $0, width: nil)] } ?? [] }

        var inks: [Ink] { stillInks + pomInks + eyeInks }
    }

    // MARK: Waving

    /// The waving pose, in the parts the moving bears move.
    static func waveFace(small: Bool, hat: Bool = false) -> Face {
        Face(centre: CGPoint(x: 9, y: 12.76), scale: 0.8, small: small, hat: hat ? Hat(peak: -1.6, tip: CGPoint(x: 7.25, y: -0.75)) : nil)
    }
    /// Where the arm leaves the head; the paw swings about this.
    static let shoulder = CGPoint(x: 14.5, y: 16)
    /// The spot on the grid the bear rocks and breathes about.
    static let feet = CGPoint(x: 9, y: 19.2)

    /// A stubby capsule coming out from behind the head, drawn only outside
    /// it so it hugs the head. A stick and a ring read as a lollipop, an arm
    /// joined at both ends as a teacup handle, and a paw on its own as a blob.
    static var arm: CGPath { capsule(from: shoulder, to: CGPoint(x: 21, y: 9.8), halfWidth: 2.2) }
    /// The pad on the paw. Nil when small.
    static func pawPad(small: Bool) -> CGPath? { small ? nil : ellipse(CGPoint(x: 21.05, y: 9.9), 0.95, 0.85) }

    // MARK: Asleep

    /// The sleeping pose's head, without its Zs, which drift on their own on
    /// the moving bears.
    static func sleepingHead(small: Bool, hat: Bool = false) -> [Ink] {
        let face = Face(centre: sleepingCentre, scale: 0.8, eyes: .shut, small: small, hat: hat ? Hat(peak: -1.6, tip: CGPoint(x: 7.25, y: -0.75)) : nil)
        // The head tips over, as it drops off.
        var tip = CGAffineTransform(translationX: sleepingCentre.x, y: sleepingCentre.y).rotated(by: sleepingTilt * .pi / 180).translatedBy(x: -sleepingCentre.x, y: -sleepingCentre.y)
        return face.inks.map { ink in
            Ink(path: ink.path.copy(using: &tip) ?? ink.path, width: ink.width, outside: ink.outside?.copy(using: &tip))
        }
    }
    static let sleepingCentre = CGPoint(x: 8.5, y: 15.4)
    /// How far over the head tips, in degrees.
    static let sleepingTilt: CGFloat = 8
    /// The spot on the grid the sleeping bear breathes about.
    static let sleepingFeet = CGPoint(x: 8.5, y: 21.8)
    /// The small Z, then the big one.
    static var sleepZs: [CGPath] { [z(CGPoint(x: 18.4, y: 6.4), 2.2), z(CGPoint(x: 21, y: 1), 2.9)] }

    // MARK: Sat, and stretching

    /// The sat bear's head. `eyes` is `.shut` for a moment as it wakes up.
    static func sitFace(small: Bool, eyes: Eyes = .button, hat: Bool = false) -> Face {
        // In the hat it hunches down a little, as there's no room above it.
        hat ? Face(centre: CGPoint(x: 12, y: 10), scale: 0.68, eyes: eyes, small: small, hat: Hat(peak: -0.2, tip: CGPoint(x: 1.5, y: 0.6)))
            : Face(centre: CGPoint(x: 12, y: 8.9), scale: 0.72, eyes: eyes, small: small)
    }
    static func sitBody(face: Face) -> [Ink] {
        body(centre: sitBodyCentre, rx: 6, ry: 5, feetApart: 5.5, feetY: 21.7, footRx: 2.5, footRy: 1.8, face: face)
    }
    private static let sitBodyCentre = CGPoint(x: 12, y: 17.8)
    /// The spot on the grid the sat bear stretches up from.
    static let sitFeet = CGPoint(x: 12, y: 23.5)
    /// Where the stretching arm leaves the body; it turns about this.
    static let stretchShoulder = CGPoint(x: 16.6, y: 14.6)
    /// One arm up past the ear, for the stretch on waking. It only ever shows
    /// for a moment, from behind the bear (`sitOutline`).
    static var stretchArm: CGPath { capsule(from: stretchShoulder, to: stretchPaw, halfWidth: 1.75) }
    /// The pad on its paw. Nil when small.
    static func stretchPad(small: Bool) -> CGPath? { small ? nil : ellipse(stretchPaw, 0.8, 0.8) }
    private static let stretchPaw = CGPoint(x: 21.8, y: 5.6)
    /// The sat bear's head, ears and body, which the stretching arm goes behind.
    static func sitOutline(hat: Bool) -> CGPath {
        // Joined, not just added: where two overlap they'd count as outside.
        let face = sitFace(small: false, hat: hat)
        return face.head.union(face.ears).union(ellipse(sitBodyCentre, 6, 5))
    }

    // MARK: Poses

    /// Everything in a pose, in drawing order. `side` is the size it's shown at.
    /// `pom: false` leaves the waving bear's pom-pom out, for one that swings it itself.
    static func inks(_ pose: Pose, side: CGFloat, hat: Bool = false, pom: Bool = true) -> [Ink] {
        let small = side < smallSide
        switch pose {
        case .wave:
            let face = waveFace(small: small, hat: hat)
            var all = [Ink(path: arm, width: line, outside: face.head)]
            if let pad = pawPad(small: small) { all.append(Ink(path: pad, width: nil)) }
            return all + face.stillInks + (pom ? face.pomInks : []) + face.eyeInks
        case .sleep:
            return sleepingHead(small: small, hat: hat) + sleepZs.map { Ink(path: $0, width: Face.shutWidth) }
        case .sit:
            let face = sitFace(small: small, hat: hat)
            return sitBody(face: face) + face.inks
        case .cub:
            // Small and new: big ears, both its eyes, nothing stitched yet.
            let face = Face(centre: CGPoint(x: 12, y: 11.2), scale: 0.62, eyes: .plain, bigEars: true, stitched: false, small: small, hat: hat ? Hat(peak: -2.9, tip: CGPoint(x: 5.1, y: -2)) : nil)
            return body(centre: CGPoint(x: 12, y: 19.4), rx: 4.3, ry: 3.4, feetApart: 3.9, feetY: 22.2, footRx: 1.8, footRy: 1.3, face: face) + face.inks
        }
    }

    /// A plump body behind the head with two feet stuck out, which stop it
    /// looking like a snowman.
    private static func body(centre: CGPoint, rx: CGFloat, ry: CGFloat, feetApart: CGFloat, feetY: CGFloat, footRx: CGFloat, footRy: CGFloat, face: Face) -> [Ink] {
        let feet = CGMutablePath()
        feet.addPath(ellipse(CGPoint(x: centre.x - feetApart, y: feetY), footRx, footRy))
        feet.addPath(ellipse(CGPoint(x: centre.x + feetApart, y: feetY), footRx, footRy))
        let inFront = CGMutablePath()
        inFront.addPath(face.head)
        inFront.addPath(feet)
        return [Ink(path: ellipse(centre, rx, ry), width: line, outside: inFront), Ink(path: feet, width: line)]
    }

    private static func capsule(from: CGPoint, to: CGPoint, halfWidth w: CGFloat) -> CGPath {
        let dx = to.x - from.x, dy = to.y - from.y
        let length = (dx * dx + dy * dy).squareRoot()
        var place = CGAffineTransform(translationX: from.x, y: from.y).rotated(by: atan2(dy, dx))
        return CGPath(roundedRect: CGRect(x: -w, y: -w, width: length + 2 * w, height: 2 * w), cornerWidth: w, cornerHeight: w, transform: &place)
    }

    private static func z(_ origin: CGPoint, _ size: CGFloat) -> CGPath {
        let path = CGMutablePath()
        path.move(to: origin)
        path.addLine(to: CGPoint(x: origin.x + size, y: origin.y))
        path.addLine(to: CGPoint(x: origin.x, y: origin.y + size))
        path.addLine(to: CGPoint(x: origin.x + size, y: origin.y + size))
        return path
    }

    fileprivate static func ellipse(_ centre: CGPoint, _ rx: CGFloat, _ ry: CGFloat) -> CGPath {
        CGPath(ellipseIn: CGRect(x: centre.x - rx, y: centre.y - ry, width: 2 * rx, height: 2 * ry), transform: nil)
    }
}
