import Foundation
import XCTest

/// Settings shows what's set with few controls, and every section's ⓘ says what
/// it is and to ask your agent (Mike, 5 Nov). `SettingsSection` makes both
/// required, so this only has to keep sections from going round it.
final class SettingsInfoTests: XCTestCase {
    private func source(_ name: String) throws -> String {
        let views = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("Sources/Threadbear/Views")
        return try String(contentsOf: views.appendingPathComponent(name), encoding: .utf8)
    }

    private let files = ["SettingsView.swift", "DevicesSettings.swift", "RunnersSettings.swift", "KeyboardSettings.swift", "VoiceSettings.swift"]

    func testPlainSectionsOnlyHoldAMessage() throws {
        var found: [String] = []
        for file in files {
            let lines = try source(file).components(separatedBy: "\n")
            for (index, line) in lines.enumerated() where line.trimmingCharacters(in: .whitespaces) == "Section {" {
                let next = lines[index + 1].trimmingCharacters(in: .whitespaces)
                if !next.hasPrefix("Text(") && !next.hasPrefix("Label(") && next != "content()" {
                    found.append("\(file):\(index + 1)")
                }
            }
        }
        XCTAssertEqual(found, [], "a section of settings is a SettingsSection, with an ⓘ")
    }

    func testNoFootnotesOrBareHeaders() throws {
        for file in files {
            let text = try source(file)
            XCTAssertFalse(text.contains("footer:"), "\(file): put the footnote behind the section's ⓘ")
            XCTAssertFalse(text.contains("Footnote("), "\(file): put the footnote behind the section's ⓘ")
        }
        // The one header is SettingsSection's own, which has the ⓘ.
        XCTAssertEqual(try source("SettingsView.swift").components(separatedBy: "header:").count, 2)
        XCTAssertFalse(try source("DevicesSettings.swift").contains("header:"))
        XCTAssertFalse(try source("RunnersSettings.swift").contains("header:"))
    }
}
