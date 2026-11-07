// Real mouse events for a drag test on Tinker Desk's desktop (never Mike's, as
// it takes the pointer: app/README.md, "A real drag"):
//   realdrag <fromX> <fromY> <toX> <toY> <holdSeconds> <shotPath>
// Screen points, from the top left. With a path, and a window number in
// RD_WINDOW, takes a picture of that window mid-drag before letting go. The
// same point twice is a click.
import AppKit
import CoreGraphics

let a = CommandLine.arguments
let from = CGPoint(x: Double(a[1])!, y: Double(a[2])!)
let to = CGPoint(x: Double(a[3])!, y: Double(a[4])!)
let hold = Double(a[5])!
let shot = a[6]

func post(_ type: CGEventType, _ p: CGPoint) {
    CGEvent(mouseEventSource: nil, mouseType: type, mouseCursorPosition: p, mouseButton: .left)?.post(tap: .cghidEventTap)
}
func wait(_ s: Double) { Thread.sleep(forTimeInterval: s) }

post(.mouseMoved, from); wait(0.25)
post(.leftMouseDown, from); wait(0.12)
let steps = 40
for i in 1...steps {
    let t = Double(i) / Double(steps)
    post(.leftMouseDragged, CGPoint(x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t))
    wait(0.016)
}
wait(hold)
if !shot.isEmpty, let id = ProcessInfo.processInfo.environment["RD_WINDOW"] {
    let p = Process()
    p.executableURL = URL(fileURLWithPath: "/usr/sbin/screencapture")
    p.arguments = ["-x", "-o", "-l", id, shot]
    try? p.run(); p.waitUntilExit()
}
post(.leftMouseUp, to); wait(0.6)
