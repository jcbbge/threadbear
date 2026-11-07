// Posts trackpad gestures through the window server at a screen point, as a
// trackpad sends them: fingers touch, then movement, then lift (or momentum).
// They go through the app's real dispatch, which the automation's made-up
// events don't: the window under the pointer, every monitor, and scroll views
// that take the rest of a gesture for themselves. Moves the real pointer, so
// run it on Tinker Desk's desktop, never Mike's (AGENTS.md, "Tests that need
// the real screen"). Build with `swiftc -O -o post-gesture post-gesture.swift`.
//
// usage: post-gesture <x> <y> <hold ms at end> <token>...
//   dx,dy  a movement (fingers' way; right and down positive)
//   M      after the lift, 10 momentum events down the same way
import CoreGraphics
import Foundation
import AppKit

let args = CommandLine.arguments
let p = CGPoint(x: Double(args[1])!, y: Double(args[2])!)
let holdMs = UInt32(args[3])!
let tokens = Array(args[4...])
CGWarpMouseCursorPosition(p)
CGAssociateMouseAndMouseCursorPosition(1)
// A warp alone sends no move, and a row's hover needs one.
CGEvent(mouseEventSource: nil, mouseType: .mouseMoved, mouseCursorPosition: p, mouseButton: .left)?.post(tap: .cghidEventTap)
usleep(350_000)
func post(_ dx: Double, _ dy: Double, phase: Int64, momentum: Int64 = 0) {
    let cg = CGEvent(scrollWheelEvent2Source: nil, units: .pixel, wheelCount: 2, wheel1: 0, wheel2: 0, wheel3: 0)!
    cg.setIntegerValueField(.scrollWheelEventIsContinuous, value: 1)
    cg.setIntegerValueField(.scrollWheelEventScrollPhase, value: phase)
    cg.setIntegerValueField(.scrollWheelEventMomentumPhase, value: momentum)
    let inverted = NSEvent(cgEvent: cg)!.isDirectionInvertedFromDevice
    let x = inverted ? dx : -dx, y = inverted ? dy : -dy
    cg.setDoubleValueField(.scrollWheelEventPointDeltaAxis2, value: x)
    cg.setDoubleValueField(.scrollWheelEventFixedPtDeltaAxis2, value: x)
    cg.setDoubleValueField(.scrollWheelEventPointDeltaAxis1, value: y)
    cg.setDoubleValueField(.scrollWheelEventFixedPtDeltaAxis1, value: y)
    cg.location = p
    cg.post(tap: .cghidEventTap)
}
post(0, 0, phase: 128) // CGScrollPhaseMayBegin: fingers touched
usleep(30_000)
post(0, 0, phase: 1)
usleep(16_000)
var last = (0.0, 0.0)
for t in tokens where t != "M" {
    let m = t.split(separator: ",").map { Double($0)! }
    post(m[0], m[1], phase: 2); last = (m[0], m[1]); usleep(16_000)
}
if holdMs > 0 { usleep(holdMs * 1000) }
post(0, 0, phase: 4)
if tokens.contains("M") {
    usleep(16_000)
    post(last.0, last.1, phase: 0, momentum: 1)
    for i in 1...10 { usleep(16_000); post(last.0 * 0.8, last.1 * 0.8, phase: 0, momentum: i == 10 ? 3 : 2) }
}
