import AppKit
import XCTest
@testable import Threadbear

@MainActor
final class ChromeProfilesTests: XCTestCase {
    /// Chrome's "Local State", cut down: two of four profiles have a window.
    private let localState = Data("""
    {"profile": {
      "last_used": "Profile 5",
      "last_active_profiles": ["Profile 5", "Default", "Profile 9"],
      "info_cache": {
        "Default": {"name": "Michael", "gaia_picture_file_name": "Google Profile Picture.png"},
        "Profile 4": {"name": "cannstudios.com"},
        "Profile 5": {"name": "convex.dev", "gaia_picture_file_name": ""}
      }
    }}
    """.utf8)

    func testOpenProfilesComeFromLastActiveInChromesOrder() throws {
        let folder = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true)
        defer { try? FileManager.default.removeItem(at: folder) }
        let picture = folder.appendingPathComponent("Default/Google Profile Picture.png")
        try FileManager.default.createDirectory(at: picture.deletingLastPathComponent(), withIntermediateDirectories: true)
        try Data().write(to: picture)

        let profiles = ChromeProfiles.parse(localState: localState, folder: folder)
        // Profile 9 is listed open but Chrome has no record of it: skipped.
        XCTAssertEqual(profiles, [
            ChromeProfile(directory: "Profile 5", name: "convex.dev", picture: nil),
            ChromeProfile(directory: "Default", name: "Michael", picture: picture),
        ])
        XCTAssertEqual(ChromeProfiles.parse(localState: Data("{}".utf8), folder: folder), [])
    }

    func testTheMenuHasAnItemPerOpenProfile() throws {
        let profiles = [
            ChromeProfile(directory: "Profile 5", name: "convex.dev"),
            ChromeProfile(directory: "Default", name: "Michael"),
        ]
        let page = try XCTUnwrap(URL(string: "https://www.notion.so/page"))
        var opened: [(URL, String)] = []
        let menu = WebLinkMenu(url: page, open: { _, _ in }, profiles: profiles, openInProfile: { opened.append(($0, $1.directory)) }).menu()
        let titles = menu.items.map(\.title)
        XCTAssertEqual(Array(titles.prefix(3)), ["Open in Chrome: convex.dev", "Open in Chrome: Michael", "Open in Panel"])

        // A menu sends its actions through NSApp, which is nil until
        // something makes the shared app (this test alone doesn't).
        _ = NSApplication.shared
        menu.performActionForItem(at: 1)
        XCTAssertEqual(opened.map(\.0), [page])
        XCTAssertEqual(opened.map(\.1), ["Default"])
    }

    func testWithOneProfileTheMenuKeepsTheBrowserItem() {
        let menu = WebLinkMenu(url: URL(string: "https://example.com")!, open: { _, _ in }, profiles: [], openInProfile: { _, _ in }).menu()
        XCTAssertEqual(menu.items.first?.title, WebLinkAction.browser.title)
        XCTAssertEqual(menu.items.dropFirst().first?.title, "Open in Panel")
    }
}
