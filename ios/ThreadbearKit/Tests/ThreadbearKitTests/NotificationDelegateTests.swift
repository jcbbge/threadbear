import Foundation
import Testing

/// Tapping a push crashed the App Store build (THREADBEAR-12, 6 Nov):
/// the notification delegate's methods were `nonisolated ... async`, so
/// Swift called UIKit's completion handler from a background thread when
/// the task finished, and UIKit asserts "Call must be made on main thread".
/// The completion-handler forms, called on main, can't do that. This reads
/// the app's source, as QuietLaunchTests does, since only a real push on a
/// real phone shows the crash.
struct NotificationDelegateTests {
    @Test func notificationDelegateCallsBackOnMain() throws {
        let ios = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent().deletingLastPathComponent()
        let text = try String(contentsOf: ios.appendingPathComponent("Threadbear/ThreadbearApp.swift"), encoding: .utf8)
        let declarations = text.components(separatedBy: "func userNotificationCenter(").dropFirst()
            .map { $0.prefix { $0 != "{" } }
        #expect(declarations.count == 2, "expected willPresent and didReceive")
        for declaration in declarations {
            #expect(declaration.contains("withCompletionHandler"), "use the completion-handler form: \(declaration)")
            #expect(!declaration.contains(" async"), "an async delegate method calls UIKit back off the main thread: \(declaration)")
        }
    }
}
