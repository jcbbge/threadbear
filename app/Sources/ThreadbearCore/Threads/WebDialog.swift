import Foundation

/// A page's `alert`, `confirm` or `prompt` in the Browser panel
/// (`Page.javascriptDialogOpening`). It's drawn over the page it came
/// from, under the site's own name, never as one of Threadbear's alerts:
/// a page could otherwise ask, in Threadbear's voice, for a password and
/// read back what was typed (Daybreak, 7 Nov).
public struct WebDialog: Equatable, Sendable {
    public enum Kind: String, Sendable { case alert, confirm, prompt, beforeunload }

    public var kind: Kind
    /// Who's asking, from the address Chrome gives, never the page's words.
    public var site: String
    /// The page's own words, cut to a length that fits.
    public var message: String
    public var defaultPrompt: String

    public static let maxMessage = 1_000

    public init(type: String?, url: String?, message: String?, defaultPrompt: String?) {
        kind = Kind(rawValue: type ?? "") ?? .alert
        site = Self.site(of: url)
        let words = message ?? ""
        self.message = words.count > Self.maxMessage ? String(words.prefix(Self.maxMessage)) + "…" : words
        self.defaultPrompt = String((defaultPrompt ?? "").prefix(Self.maxMessage))
    }

    /// "example.com says", in the app's words around the site's name.
    public var heading: String { "\(site) says" }

    /// Under a prompt's box: where what's typed goes.
    public var sendsTo: String { "What you type goes to \(site), not to Threadbear." }

    /// A web page's host (and port, if it isn't the usual one); http is
    /// said as such, being sent in the open. A file, a data: or blank page
    /// has no site to name.
    public static func site(of url: String?) -> String {
        guard let url, let parts = URLComponents(string: url), let scheme = parts.scheme?.lowercased() else { return "This page" }
        switch scheme {
        case "https", "http":
            guard let host = parts.host, !host.isEmpty else { return "This page" }
            let port = parts.port.map { ":\($0)" } ?? ""
            return (scheme == "http" ? "http://" : "") + host.lowercased() + port
        case "file": return "A file on this Mac"
        default: return "This page"
        }
    }
}

/// How many dialogs a page gets before the rest are answered no by
/// themselves: a page can open one after another as fast as each is closed.
public struct WebDialogPace: Sendable {
    public var window: TimeInterval = 10
    public var allowed = 3
    private var times: [Date] = []

    public init() {}

    /// Whether this one may be shown.
    public mutating func allow(at now: Date = Date()) -> Bool {
        times = times.filter { now.timeIntervalSince($0) < window }
        guard times.count < allowed else { return false }
        times.append(now)
        return true
    }
}
