import AppKit
import ThreadbearCore

/// Pictures, long tool output and file links in another runner's thread
/// are paths on that Mac (docs/protocol.md, "Other runners' threads"). The
/// app gets each with `files.read` on that runner's connection, keeps a
/// copy (RemoteFileCache), and then uses the copy exactly as it would a
/// file of its own. This Mac's own threads never come here: their paths
/// are local.
@MainActor
final class RemoteFileStore {
    let cache: RemoteFileCache
    /// One fetch per file at a time, however many views ask.
    private var inFlight: [String: Task<RemoteFileCache.Copy, Error>] = [:]

    init(root: URL) {
        cache = RemoteFileCache(root: root)
    }

    /// The copy, if it can be used without asking that runner (fetched or
    /// checked since launch).
    func ready(_ path: String, runnerId: String) -> RemoteFileCache.Copy? {
        cache.ready(runnerId: runnerId, path: path)
    }

    /// The copy, fetching or checking it first as the cache says.
    func copy(_ path: String, runnerId: String, client: @escaping () async throws -> RPCClient) async throws -> RemoteFileCache.Copy {
        let key = runnerId + "\u{0}" + path
        if let pending = inFlight[key] { return try await pending.value }
        let cache = cache
        let task = Task { () throws -> RemoteFileCache.Copy in
            try await cache.copy(runnerId: runnerId, path: path) { known in
                try await client().readFile(path: path, known: known)
            }
        }
        inFlight[key] = task
        defer { inFlight[key] = nil }
        return try await task.value
    }

    /// Where the copies go: the app's cache folder for Mike's own app, and
    /// inside the data folder for a dev or scripted app on a dev runner or
    /// the mock, so those never mix with his (and go when it's deleted).
    static func root(dataDir: URL) -> URL {
        if dataDir.standardizedFileURL.path == RunnerConfig.defaultDataDir.standardizedFileURL.path {
            let caches = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask).first
                ?? URL(fileURLWithPath: NSHomeDirectory()).appendingPathComponent("Library/Caches")
            return caches.appendingPathComponent("Threadbear/remote", isDirectory: true)
        }
        return dataDir.appendingPathComponent("app-remote-files", isDirectory: true)
    }
}

/// The transcript's picture grids get their pictures through this: the
/// copy straight away when there is one, else a fetch that calls back.
struct RemoteImages {
    /// "bruce", for the tile's words.
    let name: String
    let ready: (String) -> RemoteFileCache.Copy?
    let fetch: (String, @escaping (Result<RemoteFileCache.Copy, Error>) -> Void) -> Void
}

extension AppModel {
    var remoteFiles: RemoteFileStore {
        if let remoteFileStore { return remoteFileStore }
        let store = RemoteFileStore(root: RemoteFileStore.root(dataDir: dataDir))
        remoteFileStore = store
        return store
    }

    /// This Mac's copy of a file in another runner's thread, fetched
    /// through that runner (connecting to it if need be).
    func remoteCopy(_ path: String, in thread: ThreadSummary) async throws -> RemoteFileCache.Copy {
        guard let runnerId = thread.runnerId else {
            // Never for this Mac's own threads: their paths are here.
            throw RPCError.badResponse("not another runner's thread")
        }
        let threadId = thread.id
        // Through Convex the files stay on that machine: this Mac's runner
        // would read its own file at that path, which isn't the one meant.
        if viaRelay(threadId) {
            throw RPCError.server(code: -32000, message: "This file is kept on \(runnerName(of: thread) ?? "the other machine"). Turn on Connect to other machines directly in Settings > Runners to open it here.")
        }
        return try await remoteFiles.copy(path, runnerId: runnerId) { [weak self] in
            guard let self else { throw RPCError.disconnected(nil) }
            return try await self.openClient(for: threadId)
        }
    }

    /// The picture source for a remote thread's transcript; nil for this
    /// Mac's own.
    func remoteImages(for thread: ThreadSummary) -> RemoteImages? {
        guard let runnerId = thread.runnerId, let name = runnerName(of: thread) else { return nil }
        return RemoteImages(
            name: name,
            ready: { [weak self] path in self?.remoteFiles.ready(path, runnerId: runnerId) },
            fetch: { [weak self] path, done in
                guard let self else { return }
                Task {
                    do { done(.success(try await self.remoteCopy(path, in: thread))) } catch { done(.failure(error)) }
                }
            }
        )
    }

    /// Why a fetch failed, in words for a tooltip.
    static func remoteFileReason(_ error: Error) -> String {
        if let unreachable = error as? RemoteUnreachable { return unreachable.headline + " " + unreachable.detail }
        return error.localizedDescription
    }

    /// What `files.read` answers for a folder (runner/src/files.ts).
    static func isFolderError(_ error: Error) -> Bool {
        if case RPCError.server(_, let message) = error { return message.hasPrefix("Not a file") }
        return false
    }

    /// The home folder on that Mac, for a `~/` path in its thread: from the
    /// thread's folder or that runner's default one when either is under
    /// /Users, else this Mac's (the runner expands `~` itself anyway).
    func remoteHome(of thread: ThreadSummary) -> String {
        let candidates = [thread.cwd, thread.runnerId.flatMap { remoteLogins[$0]?.defaults.cwd } ?? ""]
        for folder in candidates {
            let parts = folder.split(separator: "/", omittingEmptySubsequences: true)
            if parts.count >= 2, parts[0] == "Users" { return "/Users/" + parts[1] }
        }
        return NSHomeDirectory()
    }

    /// A file in another runner's thread, opened as `action` says once
    /// it's here. The pane shows it loading, then the copy; a failure says
    /// so there, or in the banner for the other ways of opening it. A
    /// plain click (`automatic`) previews it in the pane whatever it is:
    /// a copy opened in an editor would look like the real file. `from` is
    /// the section it opens over, when that isn't the one the thread
    /// would pick (the rail's Files panel).
    func openRemoteFile(_ url: URL, _ action: FileLinkAction, in thread: ThreadSummary, title: String? = nil, back: [PanePreview] = [], from: PaneSection? = nil) {
        let path = url.path
        let name = runnerName(of: thread) ?? "another Mac"
        let title = title ?? (path as NSString).lastPathComponent
        switch action {
        case .panel, .automatic:
            // The pane belongs to a thread; on a project page there's none.
            guard openProjectId == nil else { return openRemoteFile(url, .app, in: thread, title: title) }
            var preview = PanePreview(target: .remote(path: path, failed: nil), title: title, from: from ?? paneSection(for: thread))
            preview.away = name
            preview.back = back
            show(preview, in: thread.id)
            let opened = panePreview[thread.id]?.opened
            Task {
                let result: Result<RemoteFileCache.Copy, Error>
                do { result = .success(try await remoteCopy(path, in: thread)) } catch { result = .failure(error) }
                // Unless Mike has opened something else meanwhile.
                guard var current = panePreview[thread.id], current.opened == opened, case .remote = current.target else { return }
                switch result {
                case .success(let copy):
                    // A page keeps the ?query and #fragment it was linked with.
                    if url.query != nil || url.fragment != nil, PreviewRules.viewer(forPath: path) == .web {
                        current.target = .page(FilePathRefs.withQuery(copy.url, query: url.query, fragment: url.fragment))
                    } else {
                        current.target = .file(copy.path)
                    }
                    current.cut = copy.truncated
                case .failure(let error) where Self.isFolderError(error):
                    // A link to a folder there: `files.read` won't, so browse it.
                    current.target = .folder(path)
                case .failure(let error):
                    AppLog.write("rpc", "files.read \(path) on \(name) failed: \(error.localizedDescription)")
                    current.target = .remote(path: path, failed: Self.remoteFileReason(error))
                }
                panePreview[thread.id] = current
            }
        case .app, .finder:
            // It can take a while over the network, and a menu or a row has
            // nothing to spin. A second click on the same file does nothing.
            whileBusy(BusyKey.fetching(path, runner: thread.runnerId, action: action), note: "Getting \(title) from \(name)…") { [self] in
                do {
                    let copy = try await remoteCopy(path, in: thread)
                    if action == .finder {
                        revealInFinder(copy.path)
                    } else {
                        // Never a program: that Mac chose what the file is.
                        openExternally(url.query != nil || url.fragment != nil ? FilePathRefs.withQuery(copy.url, query: url.query, fragment: url.fragment) : copy.url,
                                       from: copyOrigin(of: thread))
                    }
                } catch where Self.isFolderError(error) && openProjectId == nil {
                    // Nothing here to open it in: the pane can browse it.
                    openRemoteFile(url, .panel, in: thread, title: title)
                } catch {
                    AppLog.write("rpc", "files.read \(path) on \(name) failed: \(error.localizedDescription)")
                    errorMessage = "Couldn't get \(title) from \(name). \(Self.remoteFileReason(error))"
                }
            }
        }
    }
}
