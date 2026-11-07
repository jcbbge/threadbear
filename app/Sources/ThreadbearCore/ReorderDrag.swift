import CoreGraphics

/// The arithmetic of dragging one row through a list of equal rows: pure, so
/// it's tested apart from the view that draws it (RunnerOrderList).
public struct ReorderDrag: Equatable, Sendable {
    public let from: Int
    public let count: Int
    public let rowHeight: CGFloat

    public init(from: Int, count: Int, rowHeight: CGFloat) {
        self.from = from
        self.count = count
        self.rowHeight = rowHeight
    }

    /// How far past either end the dragged row may go, as a share of a row:
    /// enough to feel loose without being cut off by the list's bounds.
    private static let overshoot: CGFloat = 0.25

    /// The slot the row is over: it changes as the row passes halfway over
    /// the next one.
    public func slot(translationY: CGFloat) -> Int {
        let index = ((CGFloat(from) * rowHeight + translationY) / rowHeight).rounded()
        return Int(min(max(0, index), CGFloat(count - 1)))
    }

    /// Where a row other than the dragged one sits with the dragged one over `slot`.
    public func restingY(ofRow row: Int, slot: Int) -> CGFloat {
        var place = row
        if row > from { place -= 1 }
        if place >= slot { place += 1 }
        return CGFloat(place) * rowHeight
    }

    /// Where the dragged row floats.
    public func draggedY(translationY: CGFloat) -> CGFloat {
        let y = CGFloat(from) * rowHeight + translationY
        return min(max(-rowHeight * Self.overshoot, y), (CGFloat(count - 1) + Self.overshoot) * rowHeight)
    }

    public static func moving(_ ids: [String], from: Int, to: Int) -> [String] {
        guard ids.indices.contains(from), ids.indices.contains(to), from != to else { return ids }
        var next = ids
        next.insert(next.remove(at: from), at: to)
        return next
    }
}
