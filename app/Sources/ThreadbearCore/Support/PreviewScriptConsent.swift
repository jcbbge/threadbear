import Foundation

/// Which local pages Mike has let run their scripts in the pane's preview:
/// one digest per file (LocalPreviewSite.digest), so a page an agent
/// rewrites has to be allowed again, and only the bytes he allowed are ever
/// served to a view with JavaScript on (LocalPreviewSite's `pageDigest`).
/// Asked on 6 Nov 2026, after a page that draws itself showed as empty
/// boxes with scripts off (Daybreak finding 6's fix).
public struct PreviewScriptConsent {
    static let key = "previewScriptsAllowed"
    /// Plenty for the pages someone looks at; the oldest go first.
    static let limit = 200
    private let defaults: UserDefaults

    public init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
    }

    private var entries: [[String]] {
        (defaults.array(forKey: Self.key) as? [[String]]) ?? []
    }

    public func allows(path: String, digest: String) -> Bool {
        entries.contains { $0 == [path, digest] }
    }

    public func allow(path: String, digest: String) {
        var list = entries.filter { $0.first != path }
        list.append([path, digest])
        defaults.set(Array(list.suffix(Self.limit)), forKey: Self.key)
    }
}
