import Foundation

/// What Threadbear opens without asking, for a link or file that came from
/// anything it doesn't fully trust: an agent's words, a web page, another
/// Mac's runner or the backend (SECURITY.md, "Links and files"). The Mac's
/// OpenGate and the phone's LinkGate are the only places that hand a URL to
/// the system, and both decide with this.
///
/// The phone has a copy, ios/ThreadbearKit/Sources/ThreadbearKit/LinkPolicy.swift,
/// as it can't import ThreadbearCore. LinkPolicyCopyTests keeps the two the same.
public enum LinkPolicy {
    /// What a link is, for opening it.
    public enum Kind: Equatable, Sendable {
        /// http or https with a host: the browser, without asking.
        case web(URL)
        /// A file: the file check decides (OpenGate.openFile).
        case file(URL)
        /// Any other scheme (`mailto:`, `slack:`, `x-apple.systempreferences:`):
        /// it starts another app, which can act on what the link says, so only
        /// once Mike has said yes to that link by name.
        case ask(URL)
        /// Nothing that can be opened: no scheme, or web with no host.
        case refuse
    }

    public static func kind(of url: URL) -> Kind {
        guard let scheme = url.scheme?.lowercased(), !scheme.isEmpty else { return .refuse }
        switch scheme {
        case "http", "https": return web(url).map(Kind.web) ?? .refuse
        case "file": return .file(url)
        default: return .ask(url)
        }
    }

    /// An http(s) address with a host, else nil. The scheme is compared
    /// without case (`HTTPS:` is web too); anything else is not web.
    public static func web(_ url: URL) -> URL? {
        guard let scheme = url.scheme?.lowercased(), scheme == "http" || scheme == "https",
              let host = url.host, !host.isEmpty else { return nil }
        return url
    }

    public static func web(_ string: String?) -> URL? {
        guard let string, string.count <= 8_192, let url = URL(string: string) else { return nil }
        return web(url)
    }

    /// The Convex CLI's device sign-in page (`panels.convexLogin`), which a
    /// runner, maybe another Mac's, says to open: only Convex's own sign-in
    /// site, at its device page. Anything else (a file, another site,
    /// another port, a user name in front of the host) is nil, and the app
    /// says the runner sent a page that isn't Convex's rather than opening it.
    public static let convexSignInHost = "auth.convex.dev"

    public static func convexSignIn(_ string: String?) -> URL? {
        guard let string, string.count <= 2_048, let parts = URLComponents(string: string),
              parts.scheme == "https", parts.percentEncodedHost == convexSignInHost,
              parts.port == nil || parts.port == 443, parts.user == nil, parts.password == nil,
              parts.percentEncodedPath.wholeMatch(of: /\/device(\/[A-Za-z0-9_-]+)*\/?/) != nil,
              let url = parts.url, web(url) != nil else { return nil }
        return url
    }

    /// Extensions macOS opens by running something: a program, a script
    /// Terminal runs, an installer, a link file that opens whatever it
    /// points at (a `.webloc` can point at a file), a profile or extension
    /// System Settings installs. OpenGate also asks the file's own type and
    /// the app that would open it, so this is the floor, not the whole check.
    public static let codeExtensions: Set<String> = [
        "app", "command", "tool", "terminal", "workflow", "action", "scpt", "scptd",
        "pkg", "mpkg", "webloc", "inetloc", "fileloc", "url", "shortcut", "mobileconfig",
        "prefpane", "saver", "qlgenerator", "appex", "kext", "osax", "jar", "jnlp",
    ]

    public static func runsCode(path: String) -> Bool {
        codeExtensions.contains((path as NSString).pathExtension.lowercased())
    }

    /// Apps that run the file they're given rather than show it: Terminal
    /// and the other terminals (a `.command`, or a script set to open in
    /// one), Python Launcher, the installer, Shortcuts, Java.
    public static let codeRunnerApps: Set<String> = [
        "com.apple.terminal", "com.googlecode.iterm2", "org.python.pythonlauncher", "com.apple.installer",
        "com.apple.shortcuts", "com.apple.jarlauncher", "com.apple.automator.automator-application-stub",
        "com.apple.systempreferences", "com.apple.systemsettings", "com.apple.scripteditor.id.scriptapplet",
        "net.kovidgoyal.kitty", "dev.warp.warp-stable", "com.mitchellh.ghostty", "io.alacritty",
        "co.zeit.hyper", "com.github.wez.wezterm", "com.panic.prompt3",
    ]

    public static func isCodeRunner(bundleId: String?) -> Bool {
        guard let bundleId else { return false }
        return codeRunnerApps.contains(bundleId.lowercased())
    }

    /// Apps that show a file without running it: Apple's viewers, the
    /// browsers and the usual editors. Another Mac's copy only ever opens
    /// in one of these; the rest stays in the pane.
    public static let viewerApps: Set<String> = [
        "com.apple.preview", "com.apple.quicktimeplayerx", "com.apple.textedit", "com.apple.safari", "com.apple.finder",
        "com.apple.iwork.pages", "com.apple.iwork.numbers", "com.apple.iwork.keynote", "com.apple.dt.xcode",
        "com.google.chrome", "com.google.chrome.canary", "org.mozilla.firefox", "company.thebrowser.browser", "com.brave.browser",
        "com.microsoft.vscode", "com.todesktop.230313mzl4w4u92", "dev.zed.zed", "com.sublimetext.4", "com.barebones.bbedit",
        "com.microsoft.word", "com.microsoft.excel", "com.microsoft.powerpoint", "org.videolan.vlc", "com.colliderli.iina",
        "com.apple.scripteditor2", "com.jetbrains.intellij", "com.jetbrains.webstorm", "com.jetbrains.pycharm",
        "com.panic.nova", "com.mikerosoft.tandem", "net.imput.helium", "com.apple.numbers", "com.apple.pages",
        "com.apple.keynote", "com.apple.console",
    ]

    public static func isViewer(bundleId: String?) -> Bool {
        guard let bundleId else { return false }
        return viewerApps.contains(bundleId.lowercased())
    }

    /// A link shown in a question about it: long ones cut in the middle, so
    /// both the scheme and the end of it show.
    public static func shown(_ url: URL, limit: Int = 300) -> String {
        let text = url.absoluteString
        guard text.count > limit else { return text }
        return String(text.prefix(limit * 2 / 3)) + "…" + String(text.suffix(limit / 3))
    }
}
