import Foundation

// `Int(someDouble)` stops the app when the Double is NaN, an infinity or
// outside Int's range, and no `try?` or `do/catch` can catch that. Every
// number another runner, the backend or model output sends is a JSON
// number, so a Double, and a size of 1e100 in a folder listing or a
// runner's `cores: 1e20` crashed the Mac app that way (Daybreak, 7 Nov
// 2026). Convert those with these instead: `checked` where a bad value
// should be refused, `saturating` where it's only for words on screen.
// The iPhone's ThreadbearKit has the same pair (SafeNumbers.swift there).

public extension Int {
    /// `Int(value)`, rounding toward zero as it does, or nil where that
    /// would trap.
    init?(checked value: Double) {
        // 2^63 is exact as a Double (Int.max isn't), so it's the bound.
        guard value.isFinite, value >= -9_223_372_036_854_775_808.0, value < 9_223_372_036_854_775_808.0 else { return nil }
        self = Int(value)
    }

    /// `Int(value)` held to Int's range, and 0 for NaN: never traps.
    init(saturating value: Double) {
        if value.isNaN {
            self = 0
        } else if value >= 9_223_372_036_854_775_808.0 {
            self = .max
        } else if value < -9_223_372_036_854_775_808.0 {
            self = .min
        } else {
            self = Int(value)
        }
    }
}

public extension Int {
    /// `self + other` held at Int's ends rather than trapping, for sums
    /// over rows someone else sent: each can be in range and the sum not.
    func adding(saturating other: Int) -> Int {
        let (sum, over) = addingReportingOverflow(other)
        return over ? (other > 0 ? .max : .min) : sum
    }
}

public extension Double {
    /// A count or size as the wire sends it: a whole, finite number from 0
    /// to `most`, or nil. For fields where any other value is a lie (a
    /// file's size, a token count, a picture's width).
    func wholeCount(atMost most: Double = 9_007_199_254_740_991) -> Int? {
        guard isFinite, self >= 0, self <= most, rounded(.towardZero) == self else { return nil }
        return Int(checked: self)
    }
}
