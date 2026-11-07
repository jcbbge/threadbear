import AppKit
import SwiftUI
import ThreadbearCore
import UniformTypeIdentifiers

/// The one way the app hands a link or a file to macOS (SECURITY.md, "Links
/// and files"). A link or path can come from an agent's words, a page, a
/// patch, the backend or another Mac's runner, and `NSWorkspace.open` runs
/// whatever app macOS has for it: a `file:` URL to a `.command` runs it in
/// Terminal, a custom scheme starts another app with what the link says
/// (Daybreak, 7 Nov). So:
///
/// - web addresses (http, https) open in the browser;
/// - any other scheme opens only once Mike says yes to that link, by name;
/// - a file is looked at after its symlinks are followed, and that real
///   file is what opens. One that runs as a program asks first on this
///   Mac's own threads, and is never opened from another Mac's copy;
/// - Threadbear's own pages and files (`openOwn`) are fixed in the code.
///
/// OpenGateSourceTests fails on a `NSWorkspace.shared.open` anywhere else.
@MainActor
enum OpenGate {
    /// Whose file it is, which decides what a program gets.
    enum Origin: Equatable {
        /// A file on this Mac: a link in this Mac's thread, a pin, a folder
        /// Mike's browsing. A program asks first.
        case thisMac
        /// This Mac's copy of another Mac's file (RemoteFileCache), from
        /// the runner called `name`: only a file in `root`, and never a
        /// program, as that runner chose what it is.
        case otherMac(name: String, root: URL)
    }

    /// What asks Mike: the question's words and its yes button.
    struct Question: Equatable {
        var title: String
        var detail: String
        var yes: String
    }

    // Seams, so tests see what would open and what was asked without
    // anything opening.
    static var workspaceOpen: (URL) -> Void = { url in
        guard !underTests else { return }
        NSWorkspace.shared.open(url)
    }
    static var workspaceOpenWith: (URL, URL) -> Void = { url, app in
        guard !underTests else { return }
        NSWorkspace.shared.open([url], withApplicationAt: app, configuration: NSWorkspace.OpenConfiguration())
    }

    /// Under the tests nothing really opens or asks, whichever test left a
    /// `Task` running (openWebPage's can outlive its test and its stubs). A
    /// real alert with nobody there froze the check host for 18 minutes on
    /// 7 Nov; no is the safe answer anyway.
    private static let underTests = NSClassFromString("XCTestCase") != nil
    static var ask: (Question) -> Bool = { askWithAlert($0) }
    static var refuse: (String) -> Void = { AppModel.shared.errorMessage = $0 }
    /// The app macOS would open a URL in (FileLinkAction asks it too).
    nonisolated(unsafe) static var appFor: (URL) -> URL? = { NSWorkspace.shared.urlForApplication(toOpen: $0) }

    /// An app's bundle id, which the code-runner and viewer lists go by.
    nonisolated(unsafe) static var appBundleId: (URL) -> String? = { Bundle(url: $0)?.bundleIdentifier }

    // MARK: Links

    /// A web address in the browser. Anything else is refused, said so.
    @discardableResult
    static func openWeb(_ url: URL) -> Bool {
        guard let web = LinkPolicy.web(url) else {
            refuse("That isn't a web address, so Threadbear didn't open it: \(LinkPolicy.shown(url))")
            return false
        }
        workspaceOpen(web)
        return true
    }

    /// A web address in a given browser (Mike's default, found earlier).
    @discardableResult
    static func openWeb(_ url: URL, withApplicationAt app: URL) -> Bool {
        guard let web = LinkPolicy.web(url) else { return openWeb(url) }
        workspaceOpenWith(web, app)
        return true
    }

    /// Any link from outside the app: a page in the browser, a file through
    /// `openFile`, a `threadbear://thread/<id>` its thread, anything else
    /// only once Mike says yes to it.
    @discardableResult
    static func openLink(_ url: URL, origin: Origin = .thisMac) -> Bool {
        switch LinkPolicy.kind(of: url) {
        case .web(let web):
            workspaceOpen(web)
            return true
        case .file(let file):
            guard let cleared = clear(file, origin: origin) else { return false }
            open(cleared)
            return true
        case .ask(let other):
            return openOther(other)
        case .refuse:
            refuse("Threadbear couldn't open that link: \(LinkPolicy.shown(url))")
            return false
        }
    }

    private static func openOther(_ url: URL) -> Bool {
        if let threadId = ThreadLink.threadId(from: url) {
            AppModel.shared.openThread(threadId)
            return true
        }
        let scheme = url.scheme ?? ""
        // Threadbear's own scheme only ever means a thread here; anything
        // else would come straight back to this app.
        guard scheme.lowercased() != ThreadLink.scheme, let app = appFor(url) else {
            refuse("Nothing on this Mac opens \(scheme): links.")
            return false
        }
        let name = appName(app)
        let question = Question(
            title: "Open this link in \(name)?",
            detail: "It isn't a web page: it starts \(name), which acts on what the link says. It's from a thread, so Threadbear asks first.\n\n\(LinkPolicy.shown(url))",
            yes: "Open in \(name)")
        guard ask(question) else { return false }
        workspaceOpen(url)
        return true
    }

    // MARK: Files

    /// A file that's been looked at and may be opened: only `clear` makes
    /// one, so nothing opens a file that hasn't been through it.
    struct Cleared: Equatable {
        /// The file itself, symlinks followed, with the link's ?query and
        /// #fragment for a page.
        let url: URL
        fileprivate init(url: URL) { self.url = url }
    }

    /// What `clear` found out about a file.
    struct Look: Equatable {
        /// The real file, symlinks followed.
        var resolved: URL
        /// Why it's a program, or nil when it isn't one.
        var runs: String?
        /// The path given was a symlink (or went through one).
        var linked: Bool
    }

    /// Looks at the file `url` names, after following its symlinks. Nil
    /// when nothing's there.
    static func look(_ url: URL) -> Look? {
        let given = URL(fileURLWithPath: url.path).standardizedFileURL
        let resolved = given.resolvingSymlinksInPath()
        guard FileManager.default.fileExists(atPath: resolved.path) else { return nil }
        let linked = (try? given.resourceValues(forKeys: [.isSymbolicLinkKey]).isSymbolicLink) == true
            || resolved.lastPathComponent != given.lastPathComponent
        return Look(resolved: resolved, runs: runs(resolved), linked: linked)
    }

    /// Kinds of file that open to be looked at: pictures, films, sound,
    /// PDFs, text (code and pages included) and office documents. Anything
    /// else counts as a program, whatever its name says: an app can claim
    /// any extension (a `.love` game, a `.vncloc` that connects), so only
    /// what's known to be a document opens without asking (Codex review).
    static let documentTypes: [UTType] = [.image, .audiovisualContent, .pdf, .text, .rtfd, .spreadsheet, .presentation, .font]

    /// Why opening `file` would or might run something, or nil for a
    /// document or a plain folder that opens in an app that only shows it.
    private static func runs(_ file: URL) -> String? {
        if LinkPolicy.runsCode(path: file.path) { return "It's a .\(file.pathExtension.lowercased()) file, which runs when it's opened." }
        let values = try? file.resourceValues(forKeys: [.contentTypeKey, .isDirectoryKey, .isPackageKey])
        let type = values?.contentType
        // A program; text that macOS also counts as one (JavaScript, for
        // JXA) is judged by the app that opens it, below, like other code.
        if let type, type.conforms(to: .executable) && !type.conforms(to: .text) || type.conforms(to: .application) || type.conforms(to: .applicationBundle) {
            return "It's a program."
        }
        let app = appFor(file)
        if let app, LinkPolicy.isCodeRunner(bundleId: appBundleId(app)) {
            return "It opens in \(appName(app)), which runs it."
        }
        let viewer = LinkPolicy.isViewer(bundleId: app.flatMap(appBundleId))
        // A folder goes to the Finder.
        if values?.isDirectory == true, values?.isPackage != true { return nil }
        // A project file in its own app (a .tandem in Tandem).
        if PreviewRules.isAppProject(file.path), viewer { return nil }
        // A script (JavaScript, Python, shell) is text, but an app that
        // isn't known to only show it may run it as it opens (Codex review).
        if let type, type.conforms(to: .script), !viewer, let app { return "It's a script, and it opens in \(appName(app)), which may run it." }
        if let type, documentTypes.contains(where: { type.conforms(to: $0) }) { return nil }
        let opener = app.map { " It opens in \(appName($0))," } ?? ""
        return "Threadbear can't tell what this kind of file does when it's opened.\(opener) which may run what's in it."
    }

    /// Clears `url` to be opened, asking Mike first if it's a program on
    /// this Mac, saying no (with why) if it's another Mac's program, a
    /// copy from outside the cache, or not there.
    static func clear(_ url: URL, origin: Origin) -> Cleared? {
        let name = (url.path as NSString).lastPathComponent
        guard url.isFileURL, let look = look(url) else {
            refuse("\(name.isEmpty ? "That file" : name) isn't there any more.")
            return nil
        }
        switch origin {
        case .otherMac(let runner, let root):
            let cache = root.standardizedFileURL.resolvingSymlinksInPath().path
            guard look.resolved.path.hasPrefix(cache.hasSuffix("/") ? cache : cache + "/") else {
                refuse("Threadbear only opens \(runner)'s files from its own copies of them.")
                return nil
            }
            // Only a document, and only in an app that just shows it: that
            // Mac chose the bytes, and an app on this one may run them (a
            // .js in an editor that runs it, Codex review, 7 Nov).
            let app = appFor(look.resolved)
            guard look.runs == nil, let app, LinkPolicy.isViewer(bundleId: appBundleId(app)) else {
                refuse("Threadbear won't open \(name) from \(runner) in \(app.map(appName) ?? "an app"): it could run as a program on this Mac. It shows in the pane instead.")
                return nil
            }
        case .thisMac:
            if let why = look.runs {
                let link = look.linked ? "\n\n\(name) is a link to \(look.resolved.lastPathComponent)." : ""
                let question = Question(
                    title: "Open \(look.resolved.lastPathComponent)?",
                    detail: "\(why) It's from a thread, so Threadbear asks before running it.\(link)\n\n\(look.resolved.path)",
                    yes: "Open")
                guard ask(question) else { return nil }
            }
        }
        let kept = FilePathRefs.withQuery(look.resolved, query: url.query, fragment: url.fragment)
        return Cleared(url: kept)
    }

    /// Opens a cleared file in its app. A page's `?clean&s=45` would be
    /// dropped on the way to the browser (macOS passes a file URL on
    /// without them), so the page goes by a little one that forwards to
    /// it, opened in the same app.
    static func open(_ file: Cleared) {
        let url = file.url
        if url.query != nil || url.fragment != nil, PreviewRules.viewer(forPath: url.path) == .web,
           let app = appFor(URL(fileURLWithPath: url.path)) {
            let folder = FileManager.default.temporaryDirectory.appendingPathComponent("Threadbear-links", isDirectory: true)
            let page = folder.appendingPathComponent(UUID().uuidString + ".html")
            do {
                try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
                try FilePathRefs.forwardingPage(to: url).write(to: page, atomically: true, encoding: .utf8)
                workspaceOpenWith(page, app)
                return
            } catch {}
        }
        workspaceOpen(URL(fileURLWithPath: url.path))
    }

    /// `clear` then `open`, for a caller that needn't see between.
    @discardableResult
    static func openFile(_ url: URL, origin: Origin = .thisMac) -> Bool {
        guard let cleared = clear(url, origin: origin) else { return false }
        open(cleared)
        return true
    }

    // MARK: SwiftUI's links

    /// Whose file a link in SwiftUI text names.
    enum Files {
        /// A thread's: another Mac's is fetched from that Mac.
        case thread(String)
        /// This Mac's own (a project's notes, written here).
        case thisMac
        /// Nobody can say: a file link isn't followed.
        case unknown
    }

    /// For SwiftUI text with links in it (a project's notes, an answer):
    /// a web page as SwiftUI would, anything else through `openLink`, a
    /// file as `files` says. Set as `openURL` at the window's root (where
    /// no file is followed) and on each such text, as a docked panel's own
    /// window doesn't inherit the root's.
    static func urlAction(files: Files) -> OpenURLAction {
        OpenURLAction { url in
            if let web = LinkPolicy.web(url) { return .systemAction(web) }
            guard url.isFileURL else {
                _ = openLink(url)
                return .handled
            }
            switch files {
            case .thread(let threadId):
                let app = AppModel.shared
                let saved = app.linkThreadId
                app.linkThreadId = threadId
                defer { app.linkThreadId = saved }
                _ = app.openTranscriptFileLink(url, commandKey: false)
            case .thisMac:
                _ = openFile(url)
            case .unknown:
                refuse("Open \((url.path as NSString).lastPathComponent) from the thread it's in.")
            }
            return .handled
        }
    }

    // MARK: Threadbear's own

    /// A page or file the code itself names: Threadbear's docs and
    /// website, its own logs, a script or page it has just written. Never
    /// anything a runner, a page, the backend or an agent gave.
    static func openOwn(_ url: URL) {
        workspaceOpen(url)
    }

    // MARK: Asking

    static func appName(_ app: URL) -> String {
        FileManager.default.displayName(atPath: app.path).replacingOccurrences(of: ".app", with: "")
    }

    /// The question as an alert over the app, Cancel first so Return is no.
    private static func askWithAlert(_ question: Question) -> Bool {
        guard !underTests else { return false }
        let alert = NSAlert()
        alert.alertStyle = .warning
        alert.messageText = question.title
        alert.informativeText = question.detail
        alert.addButton(withTitle: "Cancel")
        alert.addButton(withTitle: question.yes)
        return alert.runModal() == .alertSecondButtonReturn
    }
}
