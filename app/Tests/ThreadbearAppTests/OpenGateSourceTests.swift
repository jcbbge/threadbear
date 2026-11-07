import Foundation
import XCTest

/// Every link or file the Mac app or the phone hands to the system goes
/// through its gate (OpenGate, LinkGate), so a new button can't open what
/// a runner or a page said without the check (Daybreak, 7 Nov: seven
/// separate places did). This fails on a direct open anywhere else.
final class OpenGateSourceTests: XCTestCase {
    private var repo: URL {
        URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent().deletingLastPathComponent()
    }

    private func matches(_ pattern: String, in folder: String, except allowed: Set<String>) throws -> [String] {
        let regex = try NSRegularExpression(pattern: pattern)
        var found: [String] = []
        let root = repo.appendingPathComponent(folder)
        let files = FileManager.default.enumerator(at: root, includingPropertiesForKeys: nil)!
        for case let file as URL in files where file.pathExtension == "swift" && !allowed.contains(file.lastPathComponent) {
            // Tests and scripts open nothing of Mike's.
            if file.path.contains("/Tests/") || file.path.contains("/scripts/") { continue }
            let lines = try String(contentsOf: file, encoding: .utf8).components(separatedBy: "\n")
            for (index, line) in lines.enumerated() {
                let code = line.components(separatedBy: "//").first ?? line
                if regex.firstMatch(in: code, range: NSRange(code.startIndex..., in: code)) != nil {
                    found.append("\(file.lastPathComponent):\(index + 1): \(line.trimmingCharacters(in: .whitespaces))")
                }
            }
        }
        return found
    }

    func testTheMacOpensThroughOpenGateOnly() throws {
        XCTAssertEqual(try matches(#"NSWorkspace\.shared\.open\s*\("#, in: "app/Sources", except: ["OpenGate.swift"]), [],
                       "open links and files with OpenGate (openWeb, openLink, openFile, or openOwn for Threadbear's own)")
    }

    /// NSTextView follows a link's URL itself, any scheme: only the two
    /// views that hand it on just for web pages may call through.
    func testOnlyGatedTextViewsLetAppKitFollowALink() throws {
        let found = try matches(#"super\.clicked\(onLink"#, in: "app/Sources", except: ["TextKit.swift", "TextFileView.swift"])
        XCTAssertEqual(found, [], "route the link through OpenGate.openLink unless LinkPolicy.web says it's a web page")
    }

    /// SwiftUI text made from Markdown opens its links through the
    /// environment's openURL: those views set OpenGate's.
    func testMarkdownTextOpensItsLinksThroughTheGate() throws {
        let root = repo.appendingPathComponent("app/Sources/Threadbear")
        let files = FileManager.default.enumerator(at: root, includingPropertiesForKeys: nil)!
        var missing: [String] = []
        for case let file as URL in files where file.pathExtension == "swift" {
            let source = try String(contentsOf: file, encoding: .utf8)
            if source.contains("AttributedString(markdown"), !source.contains("OpenGate.urlAction") { missing.append(file.lastPathComponent) }
        }
        XCTAssertEqual(missing, [], "set .environment(\\.openURL, OpenGate.urlAction) on the Text")
    }

    func testThePhoneOpensThroughLinkGateOnly() throws {
        XCTAssertEqual(try matches(#"UIApplication\.shared\.open\s*\(|\.systemAction\b|openURL\s*\("#, in: "ios", except: ["LinkGate.swift"]), [],
                       "open links with LinkGate (decide, or openOwn for the app's own)")
    }
}
