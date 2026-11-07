import Foundation
import XCTest

/// The iPhone app crashed when a push was tapped (THREADBEAR-12, 6 Nov):
/// `nonisolated ... async` notification delegate methods have Swift call
/// the system's completion handler from a background thread. The Mac's
/// AppDelegate had the same shape, so it uses the completion-handler forms
/// too, calling back on main.
final class NotificationDelegateTests: XCTestCase {
    func testNotificationDelegateCallsBackOnMain() throws {
        let file = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("Sources/Threadbear/ThreadbearApp.swift")
        let text = try String(contentsOf: file, encoding: .utf8)
        let declarations = text.components(separatedBy: "func userNotificationCenter(").dropFirst()
            .map { $0.prefix { $0 != "{" } }
        XCTAssertEqual(declarations.count, 2, "expected willPresent and didReceive")
        for declaration in declarations {
            XCTAssertTrue(declaration.contains("withCompletionHandler"), "use the completion-handler form: \(declaration)")
            XCTAssertFalse(declaration.contains(" async"), "an async delegate method calls back off the main thread: \(declaration)")
        }
    }
}
