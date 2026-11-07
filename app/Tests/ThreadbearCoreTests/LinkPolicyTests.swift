import Foundation
import XCTest
@testable import ThreadbearCore

/// What the Mac and the phone open without asking (LinkPolicy), and the
/// remote-runner answers it's applied to before anything reaches the
/// system: the Convex sign-in page, a review's live link, another Mac's
/// cached file names, a page's dialog (Daybreak, 7 Nov).
final class LinkPolicyTests: XCTestCase {
    private func kind(_ string: String) -> LinkPolicy.Kind? {
        URL(string: string).map(LinkPolicy.kind(of:))
    }

    func testOnlyWebAddressesOpenWithoutAsking() throws {
        for web in ["https://example.com/a?b#c", "http://localhost:5173/", "HTTPS://Example.com", "HtTp://x.test"] {
            guard case .web = kind(web) else { return XCTFail("\(web) is a web page") }
        }
        for other in ["slack://open?team=T1", "x-apple.systempreferences:com.apple.preference.security", "javascript:alert(1)",
                      "JaVaScRiPt:alert(1)", "mailto:a@b.c", "tel:123", "shortcuts://run-shortcut?name=x", "vscode://file/etc/passwd",
                      "threadbear://pair?url=x", "ssh://host", "smb://host/share", "data:text/html,hi"] {
            guard case .ask = kind(other) else { return XCTFail("\(other) has to ask") }
        }
        guard case .file = kind("file:///tmp/payload.terminal") else { return XCTFail("a file goes to the file check") }
        guard case .file = kind("FILE:///tmp/x") else { return XCTFail("FILE: is a file too") }
        // No host, no web.
        XCTAssertEqual(kind("https:///nohost"), .refuse)
        XCTAssertEqual(kind("relative/path.md"), .refuse)
    }

    /// Case, spaces, tabs and escapes around a scheme never make a web
    /// address out of something else.
    func testDisguisedSchemesAreNotWeb() {
        for disguised in [" javascript:alert(1)", "java\tscript:alert(1)", "https%3A//evil.example", "\u{0}https://evil.example",
                          "file%3A///etc/passwd", " file:///etc/passwd", "%66ile:///etc/passwd"] {
            guard let url = URL(string: disguised) else { continue }
            if case .web = LinkPolicy.kind(of: url) { XCTFail("\(disguised) read as web: \(url)") }
            XCTAssertNil(LinkPolicy.web(disguised), disguised)
        }
        XCTAssertNil(LinkPolicy.web("file:///etc/passwd"))
        XCTAssertNil(LinkPolicy.web(nil as String?))
        XCTAssertNotNil(LinkPolicy.web("https://ok.example/"))
    }

    // MARK: Convex sign-in

    func testTheConvexSignInPageIsOnlyConvexsDevicePage() {
        XCTAssertEqual(LinkPolicy.convexSignIn("https://auth.convex.dev/device?user_code=BRTV-XJWX")?.absoluteString,
                       "https://auth.convex.dev/device?user_code=BRTV-XJWX")
        XCTAssertNotNil(LinkPolicy.convexSignIn("https://auth.convex.dev/device"))
        XCTAssertNotNil(LinkPolicy.convexSignIn("https://auth.convex.dev:443/device/activate"))
        for bad in [
            "file:///Users/me/Library/Caches/Threadbear/remote/r-evil/92c2a677376dc56b/approval.terminal",
            "http://auth.convex.dev/device?user_code=X", "https://auth.convex.dev.evil.example/device",
            "https://evil.example/device?user_code=X", "https://auth.convex.dev:8443/device", "https://me@auth.convex.dev/device",
            "https://me:pw@auth.convex.dev/device", "https://auth.convex.dev/devicex", "https://auth.convex.dev/other/device",
            "https://AUTH.convex.dev@evil.example/device", "x-terminal://auth.convex.dev/device", "ssh://auth.convex.dev/device",
            "https://auth.convex.dev%2F@evil.example/device", "", "auth.convex.dev/device",
        ] {
            XCTAssertNil(LinkPolicy.convexSignIn(bad), bad)
        }
        XCTAssertNil(LinkPolicy.convexSignIn(nil))
    }

    /// The runner's answer, first or on a later look: a page that isn't
    /// Convex's is never offered, and says why.
    func testALoginAnswerWithAnotherPageIsRefused() {
        let good = ConvexLogin(state: "waiting", url: "https://auth.convex.dev/device?user_code=AB-CD", code: "AB-CD")
        XCTAssertNotNil(good.page)
        XCTAssertNil(good.refusedPage)
        let forged = ConvexLogin(state: "waiting", url: "file:///tmp/payload.terminal")
        XCTAssertNil(forged.page)
        XCTAssertNotNil(forged.refusedPage)
        let custom = ConvexLogin(state: "waiting", url: "x-apple.systempreferences:com.apple.preference.security")
        XCTAssertNil(custom.page)
        XCTAssertNotNil(custom.refusedPage)
        XCTAssertNil(ConvexLogin(state: "waiting").refusedPage, "no page yet isn't a refusal")
    }

    // MARK: Reviews

    func testAReviewOptionKeepsOnlyAWebLink() throws {
        func option(_ url: Any) throws -> ReviewOption {
            let json: [String: Any] = ["id": "A", "title": "A", "image": ["path": "/tmp/a.png", "mediaType": "image/png"], "url": url]
            return try JSONDecoder().decode(ReviewOption.self, from: JSONSerialization.data(withJSONObject: json))
        }
        XCTAssertEqual(try option("http://localhost:5173/").url, "http://localhost:5173/")
        for bad in ["file:///Users/me/Library/Caches/Threadbear/remote/r/abc/payload.terminal", "javascript:alert(1)",
                    "vscode://file/etc/passwd", "x-apple.systempreferences:x", "not a url", "/tmp/x.html"] {
            XCTAssertNil(try option(bad).url, bad)
        }
        XCTAssertNil(try option(42).url)
    }

    // MARK: Another Mac's files

    func testAnotherMacsProgramIsNeverCachedAsOne() {
        for name in ["approval.terminal", "payload.command", "x.webloc", "Run.app", "a.tool", "s.scpt", "i.pkg", "p.mobileconfig", "UPPER.COMMAND"] {
            let file = RemoteFileCache.fileName(runnerId: "r-evil", path: "/Users/evil/" + name)
            XCTAssertTrue(file.hasSuffix("/" + name + ".txt"), file)
        }
        for name in ["shot.png", "notes.md", "page.html", "run.sh", "film.mov"] {
            XCTAssertTrue(RemoteFileCache.fileName(runnerId: "r", path: "/x/" + name).hasSuffix("/" + name))
        }
    }

    func testTheCopyIsWrittenUnderItsSafeName() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("tb-link-policy-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: root) }
        let cache = RemoteFileCache(root: root)
        let profile = Data("<?xml version=\"1.0\"?><plist><dict><key>CommandString</key><string>touch /tmp/x</string></dict></plist>".utf8)
        let copy = try XCTUnwrap(try cache.store(FileRead(path: "/Users/evil/approval.terminal", stamp: FileStamp(size: profile.count, modifiedAt: "t"),
                                                          mediaType: "image/png", data: profile), runnerId: "r-evil", path: "/Users/evil/approval.terminal"))
        XCTAssertEqual(copy.url.lastPathComponent, "approval.terminal.txt")
        XCTAssertFalse(FileManager.default.isExecutableFile(atPath: copy.url.path))
    }

    // MARK: Page dialogs

    func testAPagesDialogIsHeadedByItsSiteNotItsWords() {
        let spoof = WebDialog(type: "prompt", url: "https://evil.example/login", message: "Threadbear needs your password to keep going",
                              defaultPrompt: "")
        XCTAssertEqual(spoof.heading, "evil.example says")
        XCTAssertEqual(spoof.kind, .prompt)
        XCTAssertTrue(spoof.sendsTo.contains("evil.example"))
        XCTAssertNotEqual(WebDialog(type: "alert", url: "https://other.example/", message: spoof.message, defaultPrompt: nil).heading,
                          spoof.heading, "the site, not the words, says who's asking")
        XCTAssertEqual(WebDialog.site(of: "http://plain.example:8080/x"), "http://plain.example:8080")
        XCTAssertEqual(WebDialog.site(of: "HTTPS://Mixed.Example/"), "mixed.example")
        for none in [nil, "", "about:blank", "data:text/html,<b>Threadbear</b>", "javascript:1", "https:///x"] {
            XCTAssertEqual(WebDialog.site(of: none), "This page", none ?? "nil")
        }
        XCTAssertEqual(WebDialog.site(of: "file:///Users/me/a.html"), "A file on this Mac")
        let long = WebDialog(type: "alert", url: "https://a.example", message: String(repeating: "x", count: 50_000), defaultPrompt: nil)
        XCTAssertLessThanOrEqual(long.message.count, WebDialog.maxMessage + 1)
        XCTAssertEqual(WebDialog(type: "weird", url: nil, message: nil, defaultPrompt: nil).kind, .alert)
    }

    func testAPageOpeningDialogAfterDialogIsSlowedDown() {
        var pace = WebDialogPace()
        let start = Date(timeIntervalSince1970: 1_000)
        XCTAssertTrue(pace.allow(at: start))
        XCTAssertTrue(pace.allow(at: start.addingTimeInterval(1)))
        XCTAssertTrue(pace.allow(at: start.addingTimeInterval(2)))
        XCTAssertFalse(pace.allow(at: start.addingTimeInterval(3)), "the fourth in ten seconds is answered no")
        XCTAssertTrue(pace.allow(at: start.addingTimeInterval(11)), "and later ones show again")
    }

    // MARK: The phone's copy

    /// The phone can't import ThreadbearCore, so it has a copy; the two
    /// must decide the same.
    func testThePhonesCopyIsTheSame() throws {
        let app = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        let mac = try String(contentsOf: app.appendingPathComponent("Sources/ThreadbearCore/Threads/LinkPolicy.swift"), encoding: .utf8)
        let phone = try String(contentsOf: app.deletingLastPathComponent().appendingPathComponent("ios/ThreadbearKit/Sources/ThreadbearKit/LinkPolicy.swift"), encoding: .utf8)
        XCTAssertEqual(mac, phone, "copy app/Sources/ThreadbearCore/Threads/LinkPolicy.swift over the phone's")
    }
}
