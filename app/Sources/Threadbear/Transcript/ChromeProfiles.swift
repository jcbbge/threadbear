import AppKit
import ThreadbearCore

/// A Chrome profile with a window open, for "Open in Chrome: convex.dev"
/// in a web link's menu. Mike runs a Chrome window per account (personal,
/// Convex, ...), and a plain open goes to whichever he used last, which
/// is often the wrong sign-in (Mike, 6 Nov).
struct ChromeProfile: Equatable {
    /// The profile's folder in Chrome's data, "Default" or "Profile 5":
    /// what `--profile-directory` takes.
    var directory: String
    /// The name Chrome shows on the profile ("convex.dev").
    var name: String
    /// Its Google account picture, when Chrome has saved one.
    var picture: URL?
}

enum ChromeProfiles {
    static let bundleId = "com.google.Chrome"

    static var dataFolder: URL {
        FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent("Library/Application Support/Google/Chrome", isDirectory: true)
    }

    /// The profiles with a window open, when Chrome is the default browser
    /// and more than one is: with only one there's nothing to choose, so
    /// the menu keeps its single "Open in Google Chrome".
    static func open() -> [ChromeProfile] {
        guard let app = DefaultBrowser.current()?.url, Bundle(url: app)?.bundleIdentifier == bundleId,
              NSRunningApplication.runningApplications(withBundleIdentifier: bundleId).isEmpty == false,
              let data = try? Data(contentsOf: dataFolder.appendingPathComponent("Local State"))
        else { return [] }
        let profiles = parse(localState: data, folder: dataFolder)
        return profiles.count > 1 ? profiles : []
    }

    /// The open profiles in Chrome's "Local State": `last_active_profiles`
    /// is the ones with a window, which Chrome rewrites as windows open and
    /// close (a few seconds late, as it batches writes), named from
    /// `info_cache`. In Chrome's order, so the menu doesn't reshuffle.
    static func parse(localState: Data, folder: URL) -> [ChromeProfile] {
        guard let root = try? JSONSerialization.jsonObject(with: localState) as? [String: Any],
              let profile = root["profile"] as? [String: Any],
              let active = profile["last_active_profiles"] as? [String],
              let info = profile["info_cache"] as? [String: Any]
        else { return [] }
        return active.compactMap { directory in
            guard let entry = info[directory] as? [String: Any] else { return nil }
            let name = (entry["name"] as? String).flatMap { $0.isEmpty ? nil : $0 } ?? directory
            let picture = (entry["gaia_picture_file_name"] as? String).flatMap { file -> URL? in
                guard !file.isEmpty else { return nil }
                let url = folder.appendingPathComponent(directory, isDirectory: true).appendingPathComponent(file)
                return FileManager.default.fileExists(atPath: url.path) ? url : nil
            }
            return ChromeProfile(directory: directory, name: name, picture: picture)
        }
    }

    static func title(_ profile: ChromeProfile) -> String { "Open in Chrome: \(profile.name)" }

    /// The account picture as a round menu icon, else Chrome's own.
    static func icon(_ profile: ChromeProfile) -> NSImage? {
        let size = NSSize(width: 16, height: 16)
        guard let path = profile.picture?.path, let picture = NSImage(contentsOfFile: path) else {
            guard let app = NSWorkspace.shared.urlForApplication(withBundleIdentifier: bundleId) else { return nil }
            let icon = NSWorkspace.shared.icon(forFile: app.path)
            icon.size = size
            return icon
        }
        return NSImage(size: size, flipped: false) { rect in
            NSBezierPath(ovalIn: rect).addClip()
            picture.draw(in: rect)
            return true
        }
    }

    /// Opens the page in that profile's window. A second Chrome started
    /// with `--profile-directory` hands the page to the running one and
    /// quits, which is the only way in: Chrome has no AppleScript or URL
    /// scheme for picking a profile.
    /// Only a web address: it goes to Chrome as an argument, so anything
    /// else (`--some-flag`, a `file:` URL) would be Chrome's to act on.
    @MainActor static func open(_ url: URL, in profile: ChromeProfile) {
        guard let web = LinkPolicy.web(url) else {
            OpenGate.openWeb(url)
            return
        }
        guard let app = NSWorkspace.shared.urlForApplication(withBundleIdentifier: bundleId) else {
            OpenGate.openWeb(web)
            return
        }
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/open")
        process.arguments = ["-na", app.path, "--args", "--profile-directory=\(profile.directory)", web.absoluteString]
        do { try process.run() } catch { OpenGate.openWeb(web) }
    }
}
