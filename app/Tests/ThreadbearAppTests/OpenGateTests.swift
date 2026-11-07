import AppKit
import XCTest
import ThreadbearCore
@testable import Threadbear

/// OpenGate, the app's one way to hand a link or file to macOS, played
/// against Daybreak's 7 Nov findings: a symlinked project pin, another
/// Mac's copies, custom-scheme links in replies, picture chips and file
/// links from another Mac's thread, the sign-in script, and page dialogs.
/// Nothing really opens: the gate's seams record what would have.
@MainActor
final class OpenGateTests: XCTestCase {
    private var folder: URL!
    private var opened: [URL] = []
    private var asked: [OpenGate.Question] = []
    private var refused: [String] = []
    private var answer = false
    private var savedBundleId: (URL) -> String? = { _ in nil }
    private var saved: (open: (URL) -> Void, openWith: (URL, URL) -> Void, ask: (OpenGate.Question) -> Bool, refuse: (String) -> Void, appFor: (URL) -> URL?)!

    override func setUp() async throws {
        folder = FileManager.default.temporaryDirectory.appendingPathComponent("tb-open-gate-\(UUID().uuidString)", isDirectory: true)
            .resolvingSymlinksInPath()
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        saved = (OpenGate.workspaceOpen, OpenGate.workspaceOpenWith, OpenGate.ask, OpenGate.refuse, OpenGate.appFor)
        opened = []; asked = []; refused = []; answer = false
        OpenGate.workspaceOpen = { [unowned self] in self.opened.append($0) }
        OpenGate.workspaceOpenWith = { [unowned self] url, _ in self.opened.append(url) }
        OpenGate.ask = { [unowned self] in self.asked.append($0); return self.answer }
        OpenGate.refuse = { [unowned self] in self.refused.append($0) }
        // A Tandem here whichever Mac the tests run on.
        savedBundleId = OpenGate.appBundleId
        OpenGate.appBundleId = { $0.lastPathComponent == "Tandem.app" ? "com.mikerosoft.tandem" : Bundle(url: $0)?.bundleIdentifier }
        // Tandem for .tandem, Terminal for .command, TextEdit for the rest.
        OpenGate.appFor = { url in
            switch url.pathExtension {
            case "tandem": URL(fileURLWithPath: "/Applications/Tandem.app")
            case "command", "terminal": URL(fileURLWithPath: "/System/Applications/Utilities/Terminal.app")
            case "love": URL(fileURLWithPath: "/Applications/love.app")
            case "js": URL(fileURLWithPath: "/Applications/RunJS.app")
            case "vncloc": URL(fileURLWithPath: "/System/Library/CoreServices/Applications/Screen Sharing.app")
            case "": url.scheme == "file" ? nil : URL(fileURLWithPath: "/Applications/Slack.app")
            default: URL(fileURLWithPath: "/System/Applications/TextEdit.app")
            }
        }
    }

    override func tearDown() async throws {
        (OpenGate.workspaceOpen, OpenGate.workspaceOpenWith, OpenGate.ask, OpenGate.refuse, OpenGate.appFor) = saved
        OpenGate.appBundleId = savedBundleId
        try? FileManager.default.removeItem(at: folder)
    }

    /// `project.tandem`, a symlink to an executable `payload.command`: what
    /// a repo can hold and an agent can pin.
    private func symlinkedProject() throws -> (link: URL, payload: URL) {
        let payload = folder.appendingPathComponent("payload.command")
        try "#!/bin/sh\ntouch /tmp/tb-should-not-run\n".write(to: payload, atomically: true, encoding: .utf8)
        try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: payload.path)
        let link = folder.appendingPathComponent("project.tandem")
        try FileManager.default.createSymbolicLink(at: link, withDestinationURL: payload)
        return (link, payload)
    }

    // MARK: Symlinked project pins

    func testASymlinkedProjectIsNotAProject() throws {
        let (link, _) = try symlinkedProject()
        XCTAssertFalse(FileLinkAction.opensInItsApp(link.path), "the file itself is a .command")
        let real = folder.appendingPathComponent("real.tandem")
        try "{}".write(to: real, atomically: true, encoding: .utf8)
        XCTAssertTrue(FileLinkAction.opensInItsApp(real.path))
    }

    func testAPinShownByTheAgentOnlyEverPreviews() throws {
        let (link, _) = try symlinkedProject()
        let real = folder.appendingPathComponent("real.tandem")
        try "{}".write(to: real, atomically: true, encoding: .utf8)
        let app = AppModel()
        let thread = ThreadSummary(id: "t1", title: "Local", status: .idle)
        app.threads["t1"] = thread
        for path in [link.path, real.path] {
            app.open(Highlight(id: "p:\(path)", kind: .file, title: "project.tandem", path: path), in: thread, external: false, shownByAgent: true)
            XCTAssertEqual(app.panePreview["t1"]?.target, .file(path), "shown in the pane")
        }
        // A link pin to another app isn't opened by itself either.
        app.open(Highlight(id: "l", kind: .link, title: "x", url: "x-apple.systempreferences:com.apple.preference.security"), in: thread, external: false, shownByAgent: true)
        XCTAssertEqual(opened, [], "nothing started on its own")
        XCTAssertEqual(asked, [])
    }

    func testOpeningASymlinkedProgramAsksAndOpensTheRealFile() throws {
        let (link, payload) = try symlinkedProject()
        XCTAssertFalse(OpenGate.openFile(link))
        XCTAssertEqual(opened, [], "no to the question: nothing opens")
        XCTAssertEqual(asked.count, 1)
        let detail = try XCTUnwrap(asked.first?.detail)
        XCTAssertTrue(detail.contains("project.tandem is a link to payload.command"), detail)
        answer = true
        XCTAssertTrue(OpenGate.openFile(link))
        XCTAssertEqual(opened.map(\.path), [payload.path], "the file the question named, not the link")
    }

    func testAPlainFileOpensWithoutAQuestion() throws {
        let notes = folder.appendingPathComponent("notes.md")
        try "# hi".write(to: notes, atomically: true, encoding: .utf8)
        XCTAssertTrue(OpenGate.openFile(notes))
        XCTAssertEqual(opened.map(\.path), [notes.path])
        XCTAssertEqual(asked, [])
    }

    func testAnExecutableWithNoExtensionIsAProgram() throws {
        let tool = folder.appendingPathComponent("tool")
        try "#!/bin/sh\necho\n".write(to: tool, atomically: true, encoding: .utf8)
        try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: tool.path)
        XCTAssertNotNil(OpenGate.look(tool)?.runs)
        XCTAssertFalse(OpenGate.openFile(tool))
        XCTAssertEqual(asked.count, 1)
    }

    // MARK: Another Mac's copies

    func testAnotherMacsProgramNeverOpens() throws {
        let cache = folder.appendingPathComponent("remote", isDirectory: true)
        try FileManager.default.createDirectory(at: cache, withIntermediateDirectories: true)
        let origin = OpenGate.Origin.otherMac(name: "bruce", root: cache)
        let profile = cache.appendingPathComponent("approval.terminal")
        try "<plist/>".write(to: profile, atomically: true, encoding: .utf8)
        answer = true
        XCTAssertFalse(OpenGate.openFile(profile, origin: origin))
        let doc = cache.appendingPathComponent("notes.md")
        try "x".write(to: doc, atomically: true, encoding: .utf8)
        XCTAssertTrue(OpenGate.openFile(doc, origin: origin))
        // A file outside the cache isn't that Mac's copy of anything.
        let mine = folder.appendingPathComponent("mine.md")
        try "x".write(to: mine, atomically: true, encoding: .utf8)
        XCTAssertFalse(OpenGate.openFile(mine, origin: origin))
        // Nor is one a symlink in the cache points out at.
        let escape = cache.appendingPathComponent("escape.md")
        try FileManager.default.createSymbolicLink(at: escape, withDestinationURL: mine)
        XCTAssertFalse(OpenGate.openFile(escape, origin: origin))
        XCTAssertEqual(opened.map(\.path), [doc.path])
        XCTAssertEqual(asked, [], "another Mac's program isn't even asked about")
        XCTAssertEqual(refused.count, 3)
    }

    // MARK: Links

    func testALinkToAnotherAppAsksFirst() throws {
        let slack = try XCTUnwrap(URL(string: "slack://open?team=T1"))
        XCTAssertFalse(OpenGate.openLink(slack))
        XCTAssertEqual(opened, [])
        XCTAssertEqual(asked.first?.title, "Open this link in Slack?")
        XCTAssertTrue(asked.first?.detail.contains("slack://open?team=T1") == true)
        answer = true
        XCTAssertTrue(OpenGate.openLink(slack))
        XCTAssertEqual(opened, [slack])
    }

    func testOpenWebOpensOnlyWebPages() throws {
        for bad in ["file:///tmp/payload.terminal", "javascript:alert(1)", "slack://x", "x-apple.systempreferences:x"] {
            XCTAssertFalse(OpenGate.openWeb(try XCTUnwrap(URL(string: bad))), bad)
        }
        XCTAssertTrue(OpenGate.openWeb(try XCTUnwrap(URL(string: "HTTPS://example.com/"))))
        XCTAssertEqual(opened.count, 1)
        XCTAssertEqual(asked, [])
    }

    /// A reply's `[open](slack://...)`: AppKit would start Slack on the
    /// click alone.
    func testATranscriptLinkWithAnotherSchemeGoesToTheGate() throws {
        let view = TranscriptTextView()
        let delegate = SchemeLinkDelegate()
        view.delegate = delegate
        var gated: Any?
        view.openOtherLink = { gated = $0 }
        for raw in ["slack://open?team=T1", "x-apple.systempreferences:com.apple.preference.security", "JaVaScRiPt:alert(1)"] {
            gated = nil
            let url = try XCTUnwrap(URL(string: raw))
            view.clicked(onLink: url, at: 0)
            XCTAssertEqual(gated as? URL, url, raw)
        }
        XCTAssertNil(delegate.clicked, "AppKit never got one to open")
    }

    // MARK: Drags from another Mac's thread

    /// A picture chip whose picture isn't here: no grid to ask, so nothing
    /// to drag, where the message's path used to be read as this Mac's.
    func testAPictureChipWithNoCopyHasNothingToDrag() throws {
        let secret = folder.appendingPathComponent("id_ed25519")
        try "PRIVATE KEY".write(to: secret, atomically: true, encoding: .utf8)
        let text = RowRenderer.userText(UserMessage(text: "see [Picture 1]", images: [ImageRef(path: secret.path, mediaType: "image/png")]))
        let view = TranscriptTextView()
        view.show(text, width: 400)
        let chip = (text.string as NSString).length - 1
        XCTAssertNotNil(text.attribute(.tbPictureChip, at: chip, effectiveRange: nil))
        XCTAssertNil(view.dragURL(atCharacter: chip), "no copy here, nothing to drag")
    }

    func testAnotherMacsFileLinkDragsOnlyItsCopy() throws {
        let app = AppModel()
        var remote = ThreadSummary(id: "r1", title: "On bruce", status: .idle)
        remote.runnerId = "r-bruce"
        app.threads["r1"] = remote
        let local = ThreadSummary(id: "l1", title: "Here", status: .idle)
        app.threads["l1"] = local
        let secret = folder.appendingPathComponent("credentials.json")
        try "{}".write(to: secret, atomically: true, encoding: .utf8)
        XCTAssertNil(app.localCopy(of: secret, in: remote), "that Mac's path is never this Mac's file")
        XCTAssertEqual(app.localCopy(of: secret, in: local), secret)
        let web = try XCTUnwrap(URL(string: "https://example.com"))
        XCTAssertEqual(app.localCopy(of: web, in: remote), web)

        // In the transcript: the hover card and the drag ask the same.
        let view = TranscriptTextView()
        view.show(MarkdownRenderer.render("[creds](<\(secret.path)>)").string, width: 400)
        view.fileLinkTarget = { $0 }
        view.localCopy = { app.localCopy(of: $0, in: remote) }
        XCTAssertNil(view.dragURL(atCharacter: 0))
        view.localCopy = { app.localCopy(of: $0, in: local) }
        XCTAssertEqual(view.dragURL(atCharacter: 0)?.path, secret.path)
    }

    // MARK: Signing in

    func testAnotherMacsThreadNeverPicksALocalSignIn() {
        var remote = ThreadSummary(id: "r1", title: "x", accountId: "nobody-here", status: .error)
        remote.runnerId = "r-evil"
        remote.provider = "claude$(printf TB_SIGNIN_INJECTION >&2)"
        XCTAssertNil(AppModel.signInAccount(for: remote, known: nil))
        remote.provider = "claude"
        XCTAssertNil(AppModel.signInAccount(for: remote, known: Account(id: "claude-main", provider: "claude", title: "me")),
                     "even with a login of that id here")

        var local = ThreadSummary(id: "l1", title: "x", accountId: "gone", status: .error)
        local.provider = "claude$(touch /tmp/x)"
        XCTAssertNil(AppModel.signInAccount(for: local, known: nil), "no such provider: no sign-in")
        local.provider = "codex"
        XCTAssertEqual(AppModel.signInAccount(for: local, known: nil), Account(id: "codex-main", provider: "codex", title: "Codex"))
    }

    /// The login's name is printed, never run: command substitution,
    /// backticks, quotes and newlines all come out as the words.
    func testTheSignInScriptPrintsTheNameAsData() throws {
        let marker = folder.appendingPathComponent("injected")
        // Relative to the script's folder, so the name stays short enough to print whole.
        let title = "claude$(touch injected) `touch injected` \"q\" 'q' \\ $HOME\nsecond line; touch injected"
        let script = SignIn.script(Account(id: "../../evil id", provider: "claude", title: title), cliPath: "/usr/bin/true")
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/bin/zsh")
        process.arguments = ["-f", "-c", script]
        process.currentDirectoryURL = folder
        let out = Pipe()
        process.standardOutput = out
        try process.run()
        process.waitUntilExit()
        let printed = String(data: out.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? ""
        XCTAssertFalse(FileManager.default.fileExists(atPath: marker.path), "nothing in the name ran")
        XCTAssertTrue(printed.contains("claude$(touch injected) `touch injected`"), printed)
        XCTAssertTrue(printed.contains("$HOME second line"), printed)
        XCTAssertEqual(SignIn.fileSafe("../../evil id"), "______evil_id")
    }

    // MARK: Page dialogs

    func testAPagesDialogIsDrawnOverThePageUnderItsSite() {
        let surface = AgentSurfaceView(port: 0, tab: AgentTab(tabId: 1, url: "https://evil.example/", title: "Evil"), thread: "t1")
        surface.frame = NSRect(x: 0, y: 0, width: 600, height: 400)
        var answers: [[String: Any]] = []
        surface.answerDialog = { answers.append($0) }
        surface.showDialog(["type": "prompt", "message": "Threadbear needs your password", "url": "https://evil.example/login", "defaultPrompt": ""])
        XCTAssertEqual(surface.shownDialog?.heading, "evil.example says")
        XCTAssertTrue(surface.dialogView.map { $0.superview === surface } == true, "in the page's own view, not a sheet on the window")
        XCTAssertTrue(NSApp.windows.allSatisfy { $0.attachedSheet == nil })
        // Dialog after dialog: past three in ten seconds, answered no unseen.
        for _ in 0..<4 {
            surface.closeDialog()
            surface.showDialog(["type": "alert", "message": "again", "url": "https://evil.example/"])
        }
        XCTAssertEqual(answers.last?["accept"] as? Bool, false)
    }

    // MARK: Codex review, round one

    /// Only what's known to be a document opens unasked: an app can claim
    /// any extension (`.love` runs the Lua inside, `.vncloc` connects).
    func testAKindOfFileItCantPlaceIsAProgram() throws {
        for name in ["preview.love", "screen.vncloc", "bundle.zip", "thing.unknownext"] {
            let file = folder.appendingPathComponent(name)
            try Data("PK".utf8).write(to: file)
            XCTAssertNotNil(OpenGate.look(file)?.runs, name)
        }
        for name in ["notes.md", "shot.png", "page.html", "code.swift", "data.json", "film.mov", "doc.pdf", "real.tandem"] {
            let file = folder.appendingPathComponent(name)
            try Data("x".utf8).write(to: file)
            XCTAssertNil(OpenGate.look(file)?.runs, name)
        }
        let sub = folder.appendingPathComponent("a folder", isDirectory: true)
        try FileManager.default.createDirectory(at: sub, withIntermediateDirectories: true)
        XCTAssertNil(OpenGate.look(sub)?.runs, "a folder goes to the Finder")

        // From another Mac: never opened.
        let cache = folder.appendingPathComponent("remote", isDirectory: true)
        try FileManager.default.createDirectory(at: cache, withIntermediateDirectories: true)
        let game = cache.appendingPathComponent("preview.love")
        try Data("PK".utf8).write(to: game)
        answer = true
        XCTAssertFalse(OpenGate.openFile(game, origin: .otherMac(name: "bruce", root: cache)))
        // Text, but going to an app that isn't known to only show it (an
        // editor that runs JavaScript as it opens).
        let script = cache.appendingPathComponent("payload.js")
        try "require('child_process').execSync('touch /tmp/x')".write(to: script, atomically: true, encoding: .utf8)
        XCTAssertNotNil(OpenGate.look(script)?.runs, "a script going to an app not known to only show it asks, here too")
        XCTAssertFalse(OpenGate.openFile(script, origin: .otherMac(name: "bruce", root: cache)))
        XCTAssertEqual(opened, [])
    }

    func testTheConvexPageCantClimbOutOfDevice() {
        for bad in ["https://auth.convex.dev/device/../", "https://auth.convex.dev/device/%2e%2e/", "https://auth.convex.dev/device/%2E%2E/x",
                    "https://auth.convex.dev/device/./", "https://auth.convex.dev/device//x", "https://auth.convex.dev/device%2F..%2F"] {
            XCTAssertNil(LinkPolicy.convexSignIn(bad), bad)
        }
        XCTAssertNotNil(LinkPolicy.convexSignIn("https://auth.convex.dev/device/"))
    }

    /// A Markdown file in the pane (this Mac's, or another Mac's copy) with
    /// a link to another app: asked about, not handed to AppKit.
    func testAFilesLinkToAnotherAppAsksFirst() throws {
        let view = FileTextView()
        let delegate = SchemeLinkDelegate()
        view.delegate = delegate
        view.clicked(onLink: try XCTUnwrap(URL(string: "x-apple.systempreferences:com.apple.preference.security")), at: 0)
        XCTAssertNil(delegate.clicked)
        XCTAssertEqual(asked.count, 1)
        XCTAssertEqual(opened, [])
    }

    /// `![preview](/Users/me/private.png)` in another Mac's reply names a
    /// picture on this Mac; it's never read or drawn.
    func testAnotherMacsReplyDrawsNoPictureFromThisMac() throws {
        let rep = try XCTUnwrap(NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: 40, pixelsHigh: 20, bitsPerSample: 8, samplesPerPixel: 4,
                                                 hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0))
        let picture = folder.appendingPathComponent("private.png")
        try XCTUnwrap(rep.representation(using: .png, properties: [:])).write(to: picture)
        let markdown = "see ![preview](\(picture.path))"
        func attachments(_ text: NSAttributedString) -> Int {
            var count = 0
            text.enumerateAttribute(.attachment, in: NSRange(location: 0, length: text.length)) { value, _, _ in if value != nil { count += 1 } }
            return count
        }
        XCTAssertEqual(attachments(MarkdownRenderer.render(markdown).string), 1, "this Mac's own reply draws it")
        XCTAssertEqual(attachments(MarkdownRenderer.withLocalPictures(false) { MarkdownRenderer.render(markdown).string }), 0)

        // Through the row cache, keyed apart so the two never mix.
        let row = TranscriptRow(id: "a1", version: 1, seq: 1, content: .assistant(TextItem(itemId: "a1", text: markdown, isStreaming: false)))
        let cache = RenderCache()
        XCTAssertEqual(attachments(try XCTUnwrap(cache.render(row, expanded: false, width: 600, localPictures: false).text)), 0)
        XCTAssertEqual(attachments(try XCTUnwrap(cache.render(row, expanded: false, width: 600).text)), 1)
    }

    /// A remote URL panel's `file:` page is that Mac's: fetched from it,
    /// never this Mac's file at that path.
    func testARemotePanelsFilePageIsNeverThisMacsFile() throws {
        let app = AppModel()
        var remote = ThreadSummary(id: "r1", title: "On bruce", status: .idle)
        remote.runnerId = "r-bruce"
        app.threads["r1"] = remote
        let secret = folder.appendingPathComponent("private.pdf")
        try "%PDF".write(to: secret, atomically: true, encoding: .utf8)
        app.openLink(secret, in: remote, external: true)
        XCTAssertEqual(opened, [])
    }

    /// A link in a thread open in a panel (A, this Mac's) while another
    /// Mac's thread (B) is selected: A's file, not a fetch from B.
    func testALinkIsFollowedInItsOwnThread() throws {
        let app = AppModel()
        app.threads["a"] = ThreadSummary(id: "a", title: "Here", status: .idle)
        var b = ThreadSummary(id: "b", title: "On bruce", status: .idle)
        b.runnerId = "r-bruce"
        app.threads["b"] = b
        app.selection = "b"
        let notes = folder.appendingPathComponent("notes.md")
        try "# A".write(to: notes, atomically: true, encoding: .utf8)
        app.linkThreadId = "a"
        defer { app.linkThreadId = nil }
        XCTAssertTrue(app.openTranscriptFile(notes, .panel))
        XCTAssertNil(app.panePreview["b"], "nothing asked of bruce or shown over its thread")
        XCTAssertEqual(opened.map(\.path), [notes.path], "A's own file, in its app, as A's pane isn't showing")
    }

    // MARK: Codex review, round three

    /// SwiftUI text's links: a file is only followed where the text says
    /// whose it is.
    func testSwiftUITextFollowsFilesOnlyWhereItKnowsWhose() throws {
        let (link, _) = try symlinkedProject()
        OpenGate.urlAction(files: .unknown)(link)
        XCTAssertEqual(opened, [])
        XCTAssertEqual(refused.count, 1)
        OpenGate.urlAction(files: .thisMac)(link)
        XCTAssertEqual(asked.count, 1, "this Mac's program still asks")
        XCTAssertEqual(opened, [])
        OpenGate.urlAction(files: .unknown)(try XCTUnwrap(URL(string: "slack://open")))
        XCTAssertEqual(asked.count, 2, "another app's link asks whoever's text it is")
    }
}

private final class SchemeLinkDelegate: NSObject, NSTextViewDelegate {
    var clicked: Any?
    func textView(_ textView: NSTextView, clickedOnLink link: Any, at charIndex: Int) -> Bool {
        clicked = link
        return true // Records AppKit's own handling without starting anything.
    }
}
