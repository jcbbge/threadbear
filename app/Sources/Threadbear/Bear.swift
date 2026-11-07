import AppKit

/// The bear: Threadbear's mascot, drawn as line glyphs in code rather than
/// the PNG sprites it started with (docs/threadbear-design/sprites). At
/// sidebar and work-line sizes a painted sprite was a brown smudge; a
/// stroked outline reads at 16 pt and can be drawn at any size. The
/// images are templates, so they take the text colour around them like
/// an SF Symbol. One bear for the app, not one per thread. The drawing
/// itself is BearGeometry, shared with the iPhone app.
enum Bear {
    typealias Pose = BearGeometry.Pose

    /// The working line's bear, in points. A touch bigger than a 16 pt tool
    /// icon so it reads as a character, not a glyph.
    static var workingSide: CGFloat { TypeScale.scaled(26) }

    private static var cache: [String: NSImage] = [:]

    /// The pose as a square template image `side` points across. The
    /// drawing is redone at whatever resolution it's shown at, so the
    /// lines stay crisp on any screen and at any zoom.
    @MainActor
    static func image(_ pose: Pose, side: CGFloat = 24, hat: Bool = BearGeometry.wearsHat(), pom: Bool = true) -> NSImage {
        let key = "\(pose.rawValue)@\(side)\(hat ? "+hat" : "")\(pom ? "" : "-pom")"
        if let cached = cache[key] { return cached }
        let image = NSImage(size: NSSize(width: side, height: side), flipped: true) { rect in
            draw(BearGeometry.inks(pose, side: side, hat: hat, pom: pom), in: rect)
            return true
        }
        image.isTemplate = true
        image.accessibilityDescription = description(pose)
        cache[key] = image
        return image
    }

    static func description(_ pose: Pose) -> String {
        switch pose {
        case .sit: return "The bear, sat waiting"
        case .wave: return "The bear, waving"
        case .sleep: return "The bear, asleep"
        case .cub: return "A bear cub"
        }
    }

    // MARK: Drawing

    /// The waving bear's Santa-hat pom-pom on its own, in the same square, for
    /// InboxZero to swing beside `image(.wave, pom: false)`.
    @MainActor
    static func wavePom(side: CGFloat) -> NSImage {
        let key = "wavePom@\(side)"
        if let cached = cache[key] { return cached }
        let image = NSImage(size: NSSize(width: side, height: side), flipped: true) { rect in
            draw(BearGeometry.wavePom(small: side < BearGeometry.smallSide), in: rect)
            return true
        }
        image.isTemplate = true
        cache[key] = image
        return image
    }

    /// Draws the pose from BearGeometry, scaled to the rect.
    static func draw(_ pose: Pose, in rect: NSRect, hat: Bool = BearGeometry.wearsHat()) {
        draw(BearGeometry.inks(pose, side: min(rect.width, rect.height), hat: hat), in: rect)
    }

    /// It's in black, as the image is a template and takes its colour from around it.
    static func draw(_ inks: [BearGeometry.Ink], in rect: NSRect) {
        guard let context = NSGraphicsContext.current?.cgContext else { return }
        let side = min(rect.width, rect.height)
        let scale = side / 24
        context.saveGState()
        context.translateBy(x: rect.minX, y: rect.minY)
        context.scaleBy(x: scale, y: scale)
        context.setFillColor(.black)
        context.setStrokeColor(.black)
        context.setLineCap(.round)
        context.setLineJoin(.round)
        for ink in inks {
            context.saveGState()
            if let outside = ink.outside {
                context.addRect(CGRect(x: -24, y: -24, width: 72, height: 72))
                context.addPath(outside)
                context.clip(using: .evenOdd)
            }
            context.addPath(ink.path)
            if let width = ink.width {
                context.setLineWidth(width)
                context.strokePath()
            } else {
                context.fillPath()
            }
            context.restoreGState()
        }
        context.restoreGState()
    }
}
