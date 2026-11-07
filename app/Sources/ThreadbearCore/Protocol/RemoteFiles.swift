import CryptoKit
import Foundation

/// A file's size and modification time as its runner reports them, which
/// `files.read` takes back as `known` to ask "is my copy still current?".
/// `modifiedAt` stays the runner's own string: it's compared, not read.
public struct FileStamp: Sendable, Hashable, Codable {
    public var size: Int
    public var modifiedAt: String

    public init(size: Int, modifiedAt: String) {
        self.size = size
        self.modifiedAt = modifiedAt
    }
}

/// What `files.read` answers (docs/protocol.md, "Other runners' threads"):
/// the bytes (at most `maxBytes`, `truncated` when the file is longer), or
/// `unchanged` with no bytes when `known` still matched the file.
public struct FileRead: Sendable, Equatable, Decodable {
    public var path: String
    public var stamp: FileStamp
    public var unchanged: Bool
    public var mediaType: String?
    public var data: Data?
    public var truncated: Bool

    public init(path: String, stamp: FileStamp, unchanged: Bool = false, mediaType: String? = nil, data: Data? = nil, truncated: Bool = false) {
        self.path = path
        self.stamp = stamp
        self.unchanged = unchanged
        self.mediaType = mediaType
        self.data = data
        self.truncated = truncated
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        path = (try? c.decodeIfPresent(String.self, forKey: .path)) ?? ""
        // Sizes come as JSON numbers, which may decode as Double, from
        // another runner: one that isn't a whole number of bytes is 0.
        let size = (try? c.decodeIfPresent(Double.self, forKey: .size)).flatMap { $0 }.flatMap { $0.wholeCount() } ?? 0
        stamp = FileStamp(size: size, modifiedAt: (try? c.decodeIfPresent(String.self, forKey: .modifiedAt)).flatMap { $0 } ?? "")
        unchanged = (try? c.decodeIfPresent(Bool.self, forKey: .unchanged)).flatMap { $0 } ?? false
        mediaType = (try? c.decodeIfPresent(String.self, forKey: .mediaType)).flatMap { $0 }
        truncated = (try? c.decodeIfPresent(Bool.self, forKey: .truncated)).flatMap { $0 } ?? false
        if let base64 = (try? c.decodeIfPresent(String.self, forKey: .data)).flatMap({ $0 }) {
            guard let bytes = Data(base64Encoded: base64) else {
                throw DecodingError.dataCorruptedError(forKey: .data, in: c, debugDescription: "data isn't base64")
            }
            data = bytes
        } else {
            data = nil
        }
        // Neither the bytes nor "unchanged" is no answer at all.
        if !unchanged, data == nil {
            throw DecodingError.dataCorruptedError(forKey: .data, in: c, debugDescription: "no data and not unchanged")
        }
    }

    enum CodingKeys: String, CodingKey { case path, size, modifiedAt, unchanged, mediaType, data, truncated }
}

public extension RPCClient {
    /// A file on that runner's Mac, for one of its threads shown here
    /// (`files.read`). With `known`, a copy that's still current comes
    /// back `unchanged`, with no bytes. Big files take a while over the
    /// tailnet, so it waits longer than a usual call.
    func readFile(path: String, maxBytes: Int? = nil, known: FileStamp? = nil) async throws -> FileRead {
        var params: [String: JSONValue] = ["path": .string(path)]
        if let maxBytes { params["maxBytes"] = .number(Double(maxBytes)) }
        if let known {
            params["known"] = .object(["size": .number(Double(known.size)), "modifiedAt": .string(known.modifiedAt)])
        }
        return try await call("files.read", .object(params), as: FileRead.self, timeout: .seconds(120))
    }
}

/// This Mac's copies of other runners' files (pictures, long tool output,
/// linked files in their threads), so each is fetched once rather than on
/// every look. Each copy keeps the size and time its runner gave, and is
/// checked against the runner (`known`, so an unchanged file isn't sent
/// again) at most once per launch: a new cache object is a new launch.
/// Bounded: copies unused for `maxAge` go, then the least recently used
/// until the whole is under `maxBytes`.
public final class RemoteFileCache: @unchecked Sendable {
    /// A local copy, used exactly as a local file would be.
    public struct Copy: Sendable, Equatable {
        public var url: URL
        public var stamp: FileStamp
        /// The runner sent only the start of it (over the size cap).
        public var truncated: Bool
        public var mediaType: String?

        public var path: String { url.path }
    }

    /// What to do for a file: use the copy as it is (checked this launch),
    /// ask with `known` (a copy from an earlier launch), or fetch it whole.
    public enum Plan: Sendable, Equatable {
        case use(Copy)
        case check(FileStamp)
        case fetch
    }

    struct Entry: Codable, Equatable {
        var runnerId: String
        var path: String
        /// Under `root`.
        var file: String
        var stamp: FileStamp
        var truncated: Bool
        var mediaType: String?
        var bytes: Int
        var usedAt: Date
    }

    public let root: URL
    public let maxBytes: Int
    public let maxAge: TimeInterval
    private let now: @Sendable () -> Date
    private let lock = NSLock()
    private var entries: [String: Entry] = [:]
    /// Checked with the runner (or fetched) since this cache was made.
    private var checked: Set<String> = []

    public init(root: URL, maxBytes: Int = 512 * 1024 * 1024, maxAge: TimeInterval = 30 * 86_400, now: @escaping @Sendable () -> Date = Date.init) {
        self.root = root
        self.maxBytes = maxBytes
        self.maxAge = maxAge
        self.now = now
        if let data = try? Data(contentsOf: indexURL), let saved = try? JSONDecoder().decode([String: Entry].self, from: data) {
            entries = saved
        }
        lock.withLock { pruneLocked(keeping: nil) }
    }

    private var indexURL: URL { root.appendingPathComponent("index.json") }

    static func key(_ runnerId: String, _ path: String) -> String { runnerId + "\u{0}" + path }

    /// The copy, if there is one on disk, whether or not it's been checked.
    private func copyLocked(_ key: String) -> Copy? {
        guard let entry = entries[key] else { return nil }
        let url = root.appendingPathComponent(entry.file)
        guard FileManager.default.fileExists(atPath: url.path) else {
            entries[key] = nil
            checked.remove(key)
            return nil
        }
        return Copy(url: url, stamp: entry.stamp, truncated: entry.truncated, mediaType: entry.mediaType)
    }

    /// A copy that can be used straight away: checked this launch.
    public func ready(runnerId: String, path: String) -> Copy? {
        lock.withLock {
            let key = Self.key(runnerId, path)
            guard checked.contains(key), let copy = copyLocked(key) else { return nil }
            entries[key]?.usedAt = now()
            return copy
        }
    }

    public func plan(runnerId: String, path: String) -> Plan {
        lock.withLock {
            let key = Self.key(runnerId, path)
            guard let copy = copyLocked(key) else { return .fetch }
            if checked.contains(key) {
                entries[key]?.usedAt = now()
                return .use(copy)
            }
            return .check(copy.stamp)
        }
    }

    /// Takes the runner's answer. Nil when it said `unchanged` but the
    /// copy has gone meanwhile: then it has to be fetched whole.
    @discardableResult
    public func store(_ read: FileRead, runnerId: String, path: String) throws -> Copy? {
        try lock.withLock {
            let key = Self.key(runnerId, path)
            if read.unchanged {
                guard let copy = copyLocked(key), copy.stamp == read.stamp else { return nil }
                checked.insert(key)
                entries[key]?.usedAt = now()
                saveLocked()
                return copy
            }
            guard let data = read.data else { return nil }
            let file = Self.fileName(runnerId: runnerId, path: path)
            let url = root.appendingPathComponent(file)
            try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
            try data.write(to: url, options: .atomic)
            entries[key] = Entry(runnerId: runnerId, path: path, file: file, stamp: read.stamp, truncated: read.truncated,
                                 mediaType: read.mediaType, bytes: data.count, usedAt: now())
            checked.insert(key)
            pruneLocked(keeping: key)
            saveLocked()
            return Copy(url: url, stamp: read.stamp, truncated: read.truncated, mediaType: read.mediaType)
        }
    }

    /// Fetches through `read` as the plan says: nothing for a copy checked
    /// this launch, `known` for an older one, the whole file otherwise.
    public func copy(runnerId: String, path: String, read: (FileStamp?) async throws -> FileRead) async throws -> Copy {
        switch plan(runnerId: runnerId, path: path) {
        case .use(let copy):
            return copy
        case .check(let stamp):
            let answer: FileRead
            do {
                answer = try await read(stamp)
            } catch {
                // That Mac asleep or out of reach: the copy from last time
                // beats nothing, and the next look asks again. One the
                // runner says has gone (a server error) isn't shown.
                if case .server? = error as? RPCError { throw error }
                if let copy = lock.withLock({ copyLocked(Self.key(runnerId, path)) }) { return copy }
                throw error
            }
            if let copy = try store(answer, runnerId: runnerId, path: path) { return copy }
        case .fetch:
            break
        }
        guard let copy = try store(try await read(nil), runnerId: runnerId, path: path) else {
            throw RPCError.badResponse("files.read said unchanged for a file this Mac has no copy of")
        }
        return copy
    }

    /// `<runner>/<hash of the path>/<its name>`: the name kept so the
    /// copy opens in the same viewer as the file would. Not one that runs
    /// when it's opened (a `.command`, a `.terminal`, a `.webloc`): that
    /// gets `.txt` after it, so what another Mac sent is never a program
    /// here, whatever opens it (Daybreak, 7 Nov). OpenGate refuses to open
    /// such a copy in an app anyway; this is the second lock.
    static func fileName(runnerId: String, path: String) -> String {
        let digest = SHA256.hash(data: Data(path.utf8)).prefix(8).map { String(format: "%02x", $0) }.joined()
        let safeRunner = runnerId.map { $0.isLetter || $0.isNumber || $0 == "-" || $0 == "_" ? $0 : "_" }
        var name = (path as NSString).lastPathComponent
        if name.isEmpty || name == "/" || name == "." || name == ".." { name = "file" }
        if LinkPolicy.runsCode(path: name) { name += ".txt" }
        return String(safeRunner) + "/" + digest + "/" + name
    }

    private func saveLocked() {
        do {
            try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
            try JSONEncoder().encode(entries).write(to: indexURL, options: .atomic)
        } catch {
            // A cache that can't save its index just fetches again next time.
        }
    }

    /// Drops copies unused for `maxAge`, then the least recently used
    /// until it's under `maxBytes` (never `keeping`, the one just stored).
    private func pruneLocked(keeping: String?) {
        let cutoff = now().addingTimeInterval(-maxAge)
        var drop = entries.filter { $0.key != keeping && $0.value.usedAt < cutoff }.map(\.key)
        var total = entries.filter { !drop.contains($0.key) }.values.reduce(0) { $0 + $1.bytes }
        if total > maxBytes {
            for (key, entry) in entries.sorted(by: { $0.value.usedAt < $1.value.usedAt }) where key != keeping && !drop.contains(key) {
                guard total > maxBytes else { break }
                drop.append(key)
                total -= entry.bytes
            }
        }
        guard !drop.isEmpty else { return }
        for key in drop {
            guard let entry = entries.removeValue(forKey: key) else { continue }
            checked.remove(key)
            // The hash folder with it.
            try? FileManager.default.removeItem(at: root.appendingPathComponent(entry.file).deletingLastPathComponent())
        }
        saveLocked()
    }
}
