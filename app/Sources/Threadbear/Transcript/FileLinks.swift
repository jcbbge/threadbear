import AppKit
import ThreadbearCore

/// What a file link in the transcript can do, from its right-click menu.
/// The menu also sets which one a plain click does.
enum FileLinkAction: String, CaseIterable {
    /// Docs and pictures in the panel, anything else (code) in its app:
    /// how a click worked before there was a choice.
    case automatic
    case panel
    case app
    case finder

    private static let clickKey = "transcriptFileLinkClick"

    static var click: FileLinkAction {
        get { UserDefaults.standard.string(forKey: clickKey).flatMap(FileLinkAction.init(rawValue:)) ?? .automatic }
        set { UserDefaults.standard.set(newValue.rawValue, forKey: clickKey) }
    }

    /// What a click on a file link in the transcript does: ⌘ always means
    /// its app, and so does a project file on this Mac (a copy fetched from
    /// another Mac has none of its media, so that's left to the pane).
    static func forClick(on path: String, commandKey: Bool, remote: Bool, appFor: (URL) -> URL? = defaultApp) -> FileLinkAction {
        if commandKey { return .app }
        return !remote && opensInItsApp(path, appFor: appFor) ? .app : click
    }

    /// A project file with an app here to open it. Asking for the app means
    /// a missing file, or a Mac without that app, still gets the pane and
    /// its "isn't there any more" rather than a click that does nothing.
    /// The file itself counts, not the name a symlink gives it: a
    /// `project.tandem` linked to a `.command` isn't a project (Daybreak,
    /// 7 Nov). OpenGate looks again before anything opens.
    static func opensInItsApp(_ path: String, appFor: (URL) -> URL? = defaultApp) -> Bool {
        guard PreviewRules.isAppProject(path) else { return false }
        let real = URL(fileURLWithPath: path).resolvingSymlinksInPath()
        return PreviewRules.isAppProject(real.path) && appFor(real) != nil
    }

    static func defaultApp(_ url: URL) -> URL? {
        FileManager.default.fileExists(atPath: url.path) ? OpenGate.appFor(url) : nil
    }

    /// The app macOS opens `path` in, for "Open in Xcode".
    static func appName(for path: String) -> String? {
        guard let app = NSWorkspace.shared.urlForApplication(toOpen: URL(fileURLWithPath: path)) else { return nil }
        return FileManager.default.displayName(atPath: app.path).replacingOccurrences(of: ".app", with: "")
    }

    var symbol: String {
        switch self {
        case .automatic: return "wand.and.stars"
        case .panel: return "sidebar.right"
        case .app: return "arrow.up.forward.app"
        case .finder: return "folder"
        }
    }

    /// The app's own icon for "Open in Xcode", else the symbol.
    func image(path: String?) -> NSImage? {
        if self == .app, let path, let app = NSWorkspace.shared.urlForApplication(toOpen: URL(fileURLWithPath: path)) {
            let icon = NSWorkspace.shared.icon(forFile: app.path)
            icon.size = NSSize(width: 16, height: 16)
            return icon
        }
        return NSImage(systemSymbolName: symbol, accessibilityDescription: nil)
    }

    func title(path: String?) -> String {
        switch self {
        case .automatic: return "Panel for Docs and Pictures, App for the Rest"
        case .panel: return "Open in Panel"
        case .app: return path.flatMap(Self.appName).map { "Open in \($0)" } ?? "Open in Default App"
        case .finder: return "Show in Finder"
        }
    }
}

/// The right-click menu on a file link: the ways to open it, Copy Path,
/// and "Default", which sets what a plain click does.
@MainActor
final class FileLinkMenu: NSObject {
    /// The file, with any ?query its page is opened with.
    let file: URL?
    let open: (URL, FileLinkAction) -> Void
    var path: String? { file?.path }

    init(file: URL?, open: @escaping (URL, FileLinkAction) -> Void) {
        self.file = file
        self.open = open
    }

    func menu() -> NSMenu {
        let menu = NSMenu()
        guard let path else {
            let missing = NSMenuItem(title: "Couldn't Find This File", symbol: "questionmark.folder", action: nil)
            missing.isEnabled = false
            menu.addItem(missing)
            return menu
        }
        let click = FileLinkAction.click
        for action in [FileLinkAction.panel, .app, .finder] {
            let item = NSMenuItem(title: action.title(path: path), symbol: action.symbol, action: #selector(openItem(_:)), target: self)
            item.setIcon(action.image(path: path))
            item.representedObject = action.rawValue
            menu.addItem(item)
        }
        let copy = NSMenuItem(title: "Copy Path", symbol: "doc.on.doc", action: #selector(copyPath), target: self)
        menu.addItem(.separator())
        menu.addItem(copy)
        menu.addItem(.separator())
        let defaults = NSMenu()
        for action in [FileLinkAction.automatic, .panel, .app, .finder] {
            // "Default App" rather than this file's app: the choice is for
            // every file link, and they open in different apps.
            let title = action == .app ? "Open in Default App" : action.title(path: path)
            let item = NSMenuItem(title: title, symbol: action.symbol, action: #selector(setClick(_:)), target: self)
            item.representedObject = action.rawValue
            item.state = action == click ? .on : .off
            defaults.addItem(item)
        }
        let submenu = NSMenuItem(title: "Default", symbol: "cursorarrow.click", action: nil)
        submenu.submenu = defaults
        menu.addItem(submenu)
        // The menu holds its items' target weakly; keep this alive with it.
        objc_setAssociatedObject(menu, &FileLinkMenu.retainKey, self, .OBJC_ASSOCIATION_RETAIN)
        return menu
    }

    nonisolated(unsafe) private static var retainKey: UInt8 = 0

    @objc private func openItem(_ item: NSMenuItem) {
        guard let file, let action = (item.representedObject as? String).flatMap(FileLinkAction.init(rawValue:)) else { return }
        open(file, action)
    }

    @objc private func setClick(_ item: NSMenuItem) {
        guard let action = (item.representedObject as? String).flatMap(FileLinkAction.init(rawValue:)) else { return }
        FileLinkAction.click = action
    }

    @objc private func copyPath() {
        guard let path else { return }
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(path, forType: .string)
    }
}

/// What a click on a web link does, in the transcript and in the pane's
/// Links: Mike's browser by default (where his sign-ins are), or the
/// panel. Set from "Default" in a link's right-click menu, as for
/// files.
enum WebLinkAction: String, CaseIterable {
    case browser
    case panel

    static let clickKey = "webLinkClick"

    static var click: WebLinkAction {
        get { UserDefaults.standard.string(forKey: clickKey).flatMap(WebLinkAction.init(rawValue:)) ?? .browser }
        set { UserDefaults.standard.set(newValue.rawValue, forKey: clickKey) }
    }

    /// The default browser, for "Open in Google Chrome".
    private static var browserApp: URL? {
        URL(string: "https://example.com").flatMap { NSWorkspace.shared.urlForApplication(toOpen: $0) }
    }

    static var browserName: String? {
        browserApp.map { FileManager.default.displayName(atPath: $0.path).replacingOccurrences(of: ".app", with: "") }
    }

    var symbol: String {
        switch self {
        case .browser: return "safari"
        case .panel: return "sidebar.right"
        }
    }

    var title: String {
        switch self {
        case .browser: return Self.browserName.map { "Open in \($0)" } ?? "Open in Browser"
        case .panel: return "Open in Panel"
        }
    }

    /// The browser's own icon, else the symbol.
    var image: NSImage? {
        if self == .browser, let app = Self.browserApp {
            let icon = NSWorkspace.shared.icon(forFile: app.path)
            icon.size = NSSize(width: 16, height: 16)
            return icon
        }
        return NSImage(systemSymbolName: symbol, accessibilityDescription: nil)
    }
}

/// The right-click menu on a web link in the transcript: browser or
/// panel, Copy Link, and "Default", like FileLinkMenu. With more than one
/// Chrome profile open, the browser item is one per profile.
@MainActor
final class WebLinkMenu: NSObject {
    let url: URL
    let open: (URL, WebLinkAction) -> Void
    let profiles: [ChromeProfile]
    let openInProfile: (URL, ChromeProfile) -> Void

    init(
        url: URL,
        open: @escaping (URL, WebLinkAction) -> Void,
        profiles: [ChromeProfile] = ChromeProfiles.open(),
        openInProfile: @escaping (URL, ChromeProfile) -> Void = { url, profile in MainActor.assumeIsolated { ChromeProfiles.open(url, in: profile) } }
    ) {
        self.url = url
        self.open = open
        self.profiles = profiles
        self.openInProfile = openInProfile
    }

    func menu() -> NSMenu {
        let menu = NSMenu()
        if profiles.isEmpty {
            menu.addItem(actionItem(.browser))
        } else {
            for (index, profile) in profiles.enumerated() {
                let item = NSMenuItem(title: ChromeProfiles.title(profile), symbol: WebLinkAction.browser.symbol, action: #selector(openProfile(_:)), target: self)
                item.setIcon(ChromeProfiles.icon(profile))
                item.tag = index
                menu.addItem(item)
            }
        }
        menu.addItem(actionItem(.panel))
        menu.addItem(.separator())
        menu.addItem(NSMenuItem(title: "Copy Link", symbol: "link", action: #selector(copyLink), target: self))
        menu.addItem(.separator())
        let defaults = NSMenu()
        let click = WebLinkAction.click
        for action in [WebLinkAction.browser, .panel] {
            let item = NSMenuItem(title: action.title, symbol: action.symbol, action: #selector(setClick(_:)), target: self)
            item.representedObject = action.rawValue
            item.state = action == click ? .on : .off
            defaults.addItem(item)
        }
        let submenu = NSMenuItem(title: "Default", symbol: "cursorarrow.click", action: nil)
        submenu.submenu = defaults
        menu.addItem(submenu)
        // The menu holds its items' target weakly; keep this alive with it.
        objc_setAssociatedObject(menu, &WebLinkMenu.retainKey, self, .OBJC_ASSOCIATION_RETAIN)
        return menu
    }

    nonisolated(unsafe) private static var retainKey: UInt8 = 0

    private func actionItem(_ action: WebLinkAction) -> NSMenuItem {
        let item = NSMenuItem(title: action.title, symbol: action.symbol, action: #selector(openItem(_:)), target: self)
        item.setIcon(action.image)
        item.representedObject = action.rawValue
        return item
    }

    @objc private func openProfile(_ item: NSMenuItem) {
        guard profiles.indices.contains(item.tag) else { return }
        openInProfile(url, profiles[item.tag])
    }

    @objc private func openItem(_ item: NSMenuItem) {
        guard let action = (item.representedObject as? String).flatMap(WebLinkAction.init(rawValue:)) else { return }
        open(url, action)
    }

    @objc private func setClick(_ item: NSMenuItem) {
        guard let action = (item.representedObject as? String).flatMap(WebLinkAction.init(rawValue:)) else { return }
        WebLinkAction.click = action
    }

    @objc private func copyLink() {
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(url.absoluteString, forType: .string)
    }
}
