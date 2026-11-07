import Foundation

/// Files dropped from a temp folder, copied somewhere they'll stay.
///
/// Dragging a screenshot's floating thumbnail hands over a file in
/// `.../T/TemporaryItems/NSIRD_screencaptureui_*`, and macOS deletes it as
/// the drop ends: by the time the runner's `media.import` reads it, it's
/// gone, and that showed as "Not a supported image" (issue #2). Copying it
/// during the drop, in the app, keeps it.
public enum DroppedFiles {
    /// Where the composer keeps its own copies (pasted image data goes
    /// here too).
    public static var keepFolder: URL {
        FileManager.default.temporaryDirectory.appendingPathComponent("threadbear-paste", isDirectory: true)
    }

    /// Whether `url` is in a temp folder that may be cleared under us,
    /// other than the composer's own.
    public static func isTransient(_ url: URL, temp: URL = FileManager.default.temporaryDirectory, keep: URL = keepFolder) -> Bool {
        let path = canonical(url.path)
        if path.hasPrefix(canonical(keep.path) + "/") { return false }
        // By where the path starts, not a folder name within it: the copy
        // runs on the main thread during the drop, so a TemporaryItems on a
        // slow network share mustn't match.
        return path.hasPrefix("/var/folders/")
            || path.hasPrefix(canonical(temp.path) + "/")
    }

    /// Whether `url` is in the space macOS hands out for one drag and takes
    /// back as the drop ends, as a screen recording's thumbnail is. Narrower
    /// than `isTransient`, for files that go in as their path: a document in
    /// an ordinary temp folder has to stay where it is, or an agent asked to
    /// edit it would edit a copy.
    public static func isVanishing(_ url: URL) -> Bool {
        let path = canonical(url.path)
        return path.hasPrefix("/var/folders/") && path.contains("/TemporaryItems/")
    }

    /// `urls` with each transient one swapped for a copy under `folder` (an
    /// APFS clone, so a big recording costs nothing),
    /// keeping its name (the runner's messages name the file). One that
    /// can't be copied is passed on as it was, for the runner to explain.
    public static func keepingTransient(_ urls: [URL], temp: URL = FileManager.default.temporaryDirectory, into folder: URL = keepFolder) -> [URL] {
        urls.map { isTransient($0, temp: temp, keep: folder) ? kept($0, into: folder) : $0 }
    }

    /// The same for files that go in as their path, which only move if
    /// they'd otherwise vanish.
    public static func keepingVanishing(_ urls: [URL], into folder: URL = keepFolder) -> [URL] {
        urls.map { isVanishing($0) ? kept($0, into: folder) : $0 }
    }

    private static func kept(_ url: URL, into folder: URL) -> URL {
        // copyItem copies a symlink as a link, which would still lean on
        // the file that's about to go.
        let source = url.resolvingSymlinksInPath()
        // Files only: this runs on the main thread during the drop, and a
        // folder would be walked file by file however cheap the clones are.
        guard (try? source.resourceValues(forKeys: [.isRegularFileKey]).isRegularFile) == true else { return url }
        let dir = folder.appendingPathComponent(String(UUID().uuidString.prefix(8)), isDirectory: true)
        let copy = dir.appendingPathComponent(url.lastPathComponent)
        do {
            try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
            try FileManager.default.copyItem(at: source, to: copy)
            return copy
        } catch {
            try? FileManager.default.removeItem(at: dir)
            return url
        }
    }

    /// Whether `url` is inside a Photos library. Copying a photo in Photos
    /// puts such a file on the clipboard, which only apps with Photos
    /// access can read, alongside the image itself.
    public static func isInPhotosLibrary(_ url: URL) -> Bool {
        url.path.contains(".photoslibrary/")
    }

    /// Writes image data from the clipboard to a folder of its own under
    /// `folder`, as `name`. Nil if it couldn't be written.
    public static func save(_ data: Data, named name: String, into folder: URL = keepFolder) -> URL? {
        let dir = folder.appendingPathComponent(String(UUID().uuidString.prefix(8)), isDirectory: true)
        let url = dir.appendingPathComponent(name)
        do {
            try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
            try data.write(to: url)
            return url
        } catch {
            try? FileManager.default.removeItem(at: dir)
            return nil
        }
    }

    /// `/private/var/...` and `/var/...` are the same folder.
    private static func canonical(_ path: String) -> String {
        path.hasPrefix("/private/var/") ? String(path.dropFirst("/private".count)) : path
    }
}
