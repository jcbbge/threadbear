import Foundation

/// One thing in a folder the side pane is showing: read from this Mac's
/// disk (`FolderListing.read`), or sent by another runner (`files.list`).
public struct FolderEntry: Sendable, Hashable {
    public var name: String
    public var path: String
    /// One you can go into. A package (an `.app`, an `.xcodeproj`) isn't:
    /// as in the Finder, it opens in its app.
    public var isFolder: Bool
    public var isPackage: Bool
    public var hidden: Bool
    /// A file's. A folder has none of its own, as in the Finder.
    public var size: Int?
    public var modifiedAt: Date?

    public init(name: String, path: String, isFolder: Bool, isPackage: Bool = false, hidden: Bool = false, size: Int? = nil, modifiedAt: Date? = nil) {
        self.name = name
        self.path = path
        self.isFolder = isFolder
        self.isPackage = isPackage
        self.hidden = hidden
        self.size = size
        self.modifiedAt = modifiedAt
    }
}

/// What a folder holds. `truncated` is another runner saying there's more
/// than it would send (`files.list`'s cap).
public struct FolderContents: Sendable, Equatable, Decodable {
    public var path: String
    public var entries: [FolderEntry]
    public var truncated: Bool

    public init(path: String, entries: [FolderEntry], truncated: Bool = false) {
        self.path = path
        self.entries = entries
        self.truncated = truncated
    }

    /// Tolerant, like the rest of the protocol: an entry with no name is
    /// dropped, and anything else it doesn't say is left out.
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        path = try c.decode(String.self, forKey: .path)
        truncated = (try? c.decodeIfPresent(Bool.self, forKey: .truncated)).flatMap { $0 } ?? false
        let wire = (try? c.decodeIfPresent([Wire].self, forKey: .entries)).flatMap { $0 } ?? []
        let parent = path
        entries = wire.compactMap { item in
            guard let name = item.name, !name.isEmpty else { return nil }
            return FolderEntry(
                name: name,
                path: FolderListing.join(parent, name),
                isFolder: item.isFolder ?? false,
                hidden: item.hidden ?? name.hasPrefix("."),
                // Another runner sends it: a size that isn't a whole number of
                // bytes is none, not Int(_:) trapping on 1e100 (Daybreak, 7 Nov).
                size: item.size.flatMap { $0.wholeCount() },
                modifiedAt: item.modifiedAt.flatMap(FolderListing.date)
            )
        }
    }

    private enum CodingKeys: String, CodingKey { case path, entries, truncated }

    private struct Wire: Decodable {
        var name: String?
        var isFolder: Bool?
        var hidden: Bool?
        var size: Double?
        var modifiedAt: String?
    }
}

public extension RPCClient {
    /// A folder on that runner's Mac (`files.list`), for one of its threads
    /// shown here.
    /// With `runnerId`, a folder on that runner, asked through this Mac's
    /// runner and Convex.
    func listFolder(path: String, runnerId: String? = nil) async throws -> FolderContents {
        var params: [String: JSONValue] = ["path": .string(path)]
        if let runnerId { params["runnerId"] = .string(runnerId) }
        return try await call("files.list", .object(params), as: FolderContents.self, timeout: RPCClient.sendTimeout)
    }
}

/// How a folder's rows are ordered: the column Mike last clicked.
public struct FolderSort: Sendable, Equatable {
    public enum Key: String, Sendable, CaseIterable {
        case name, modified, size
    }

    public var key: Key
    public var ascending: Bool

    public init(key: Key = .name, ascending: Bool = true) {
        self.key = key
        self.ascending = ascending
    }

    /// Folders first whatever the column, then by it. Names sort as the
    /// Finder sorts them (`clip 2` before `clip 10`). A row with nothing in
    /// the column goes last either way, and ties go by name, so the order
    /// never jumps when something else in the folder changes.
    public func apply(_ entries: [FolderEntry]) -> [FolderEntry] {
        entries.sorted { a, b in
            if a.isFolder != b.isFolder { return a.isFolder }
            switch key {
            case .name:
                break
            case .modified:
                if let order = Self.order(a.modifiedAt, b.modifiedAt, ascending: ascending) { return order }
            case .size:
                if let order = Self.order(a.size, b.size, ascending: ascending) { return order }
            }
            let names = a.name.localizedStandardCompare(b.name)
            if names == .orderedSame { return a.path < b.path }
            // Only the name column's own direction flips the names.
            return (key != .name || ascending) == (names == .orderedAscending)
        }
    }

    private static func order<T: Comparable>(_ a: T?, _ b: T?, ascending: Bool) -> Bool? {
        switch (a, b) {
        case (nil, nil): return nil
        case (nil, _): return false
        case (_, nil): return true
        case let (a?, b?):
            if a == b { return nil }
            return ascending ? a < b : a > b
        }
    }
}

public enum FolderListing {
    /// One step of the path bar.
    public struct Crumb: Sendable, Equatable {
        public var name: String
        public var path: String

        public init(name: String, path: String) {
            self.name = name
            self.path = path
        }
    }

    /// Whether a link to `path` should open in the folder browser: a folder
    /// here, or a link to one, and not a package (which opens in its app).
    public static func isBrowsable(_ path: String) -> Bool {
        let url = URL(fileURLWithPath: path).resolvingSymlinksInPath()
        guard let values = try? url.resourceValues(forKeys: [.isDirectoryKey, .isPackageKey]) else { return false }
        return values.isDirectory == true && values.isPackage != true
    }

    /// A folder on this Mac. It touches the disk, so never on the main
    /// thread: a folder can hold thousands, or be on a sleeping drive.
    public static func read(_ path: String) throws -> FolderContents {
        let keys: [URLResourceKey] = [.isDirectoryKey, .isPackageKey, .isSymbolicLinkKey, .isHiddenKey, .fileSizeKey, .contentModificationDateKey]
        let folder = URL(fileURLWithPath: path).resolvingSymlinksInPath()
        let urls = try FileManager.default.contentsOfDirectory(at: folder, includingPropertiesForKeys: keys)
        let entries = urls.map { url -> FolderEntry in
            var values = try? url.resourceValues(forKeys: Set(keys))
            // What a link points at decides how it opens and what it shows.
            if values?.isSymbolicLink == true, let target = try? url.resolvingSymlinksInPath().resourceValues(forKeys: Set(keys)) {
                let hidden = values?.isHidden
                values = target
                values?.isHidden = hidden
            }
            let isPackage = values?.isPackage == true
            let isFolder = values?.isDirectory == true && !isPackage
            return FolderEntry(
                name: url.lastPathComponent,
                // By the folder as it was asked for, so a link's rows stay
                // under the link rather than jumping to where it points.
                path: join(path, url.lastPathComponent),
                isFolder: isFolder,
                isPackage: isPackage,
                hidden: values?.isHidden ?? url.lastPathComponent.hasPrefix("."),
                size: isFolder ? nil : values?.fileSize,
                modifiedAt: values?.contentModificationDate
            )
        }
        return FolderContents(path: path, entries: entries)
    }

    /// The path bar's steps to `path`: from the home folder when it's under
    /// there (the Finder's long run up from the disk says nothing Mike
    /// wants to click), else from the top of the disk.
    public static func crumbs(to path: String, home: String) -> [Crumb] {
        let home = trimmed(home)
        let path = trimmed(path)
        if path == home || path.hasPrefix(home + "/") {
            var crumbs = [Crumb(name: (home as NSString).lastPathComponent, path: home)]
            var at = home
            for part in path.dropFirst(home.count).split(separator: "/") {
                at += "/" + part
                crumbs.append(Crumb(name: String(part), path: at))
            }
            return crumbs
        }
        var crumbs = [Crumb(name: "/", path: "/")]
        var at = ""
        for part in path.split(separator: "/") {
            at += "/" + part
            crumbs.append(Crumb(name: String(part), path: at))
        }
        return crumbs
    }

    /// The folder above, or nil at the top of the disk.
    public static func parent(of path: String) -> String? {
        let path = trimmed(path)
        if path == "/" || path.isEmpty { return nil }
        let up = (path as NSString).deletingLastPathComponent
        return up.isEmpty ? "/" : up
    }

    public static func join(_ folder: String, _ name: String) -> String {
        folder.hasSuffix("/") ? folder + name : folder + "/" + name
    }

    private static func trimmed(_ path: String) -> String {
        var path = path
        while path.count > 1, path.hasSuffix("/") { path.removeLast() }
        return path
    }

    /// A runner's `modifiedAt`: JavaScript's toISOString, with milliseconds.
    static func date(_ text: String) -> Date? {
        (try? Date(text, strategy: .iso8601.year().month().day().time(includingFractionalSeconds: true)))
            ?? (try? Date(text, strategy: .iso8601))
    }
}
