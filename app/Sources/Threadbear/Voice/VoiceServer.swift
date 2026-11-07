import CryptoKit
import Darwin
import Foundation
import ThreadbearCore

/// Kyutai's pocket-tts, which gives Voice mode its voice: a small program
/// that runs on the CPU. The first time Voice is used it's downloaded from
/// its GitHub release (that exact version, checked against its checksum)
/// into ~/Library/Application Support/Threadbear/voice/, and run there as
/// `pocket-tts serve` on a free port on 127.0.0.1 for as long as Voice is
/// in use (it stops a few minutes after, and when the app quits; if the app
/// crashes, the next launch stops it, from its serve.*.pid file). Its
/// model and voices come from Hugging Face on first use, into the usual
/// ~/.cache/huggingface (about 240 MB). docs/on-your-mac.md lists all of it.
@MainActor
final class VoiceServer {
    static let shared = VoiceServer()

    enum Failure: LocalizedError {
        case notAppleSilicon, download(String), checksum, start(String)
        var errorDescription: String? {
            switch self {
            case .notAppleSilicon: "Voice needs a Mac with Apple silicon."
            case .download(let why): "Couldn't download the voice engine: \(why)"
            case .checksum: "The voice engine download didn't match its checksum, so it wasn't used."
            case .start(let why): "The voice engine didn't start: \(why)"
            }
        }
    }

    static let release = "v4.0.1"
    static let asset = "pocket-tts-3.3.0-aarch64-apple-darwin.tar.gz"
    nonisolated static let sha256 = "ee9ca6c7c000ee72c5846e3a8ba01d08f56636d94a614d2259c3f12b8fd69afa"
    static var downloadURL: URL { URL(string: "https://github.com/kyutai-labs/pocket-tts/releases/download/\(release)/\(asset)")! }

    static var folder: URL {
        FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("Threadbear/voice", isDirectory: true)
    }
    static var binary: URL { folder.appendingPathComponent("\(release)/pocket-tts") }

    private var process: Process?
    private var port: Int?
    private var language: String?
    /// The start under way. A newer one replaces it, and it gives up: without
    /// the id, a language change mid-start left both running, with the old
    /// one's process overwriting the new one's.
    private var starting: (id: UUID, task: Task<URL, Error>)?
    private var idleStop: Task<Void, Never>?
    /// Says what it's doing while it gets ready ("Downloading the voice engine…").
    var onStatus: ((String) -> Void)?

    var isInstalled: Bool { FileManager.default.isExecutableFile(atPath: Self.binary.path) }

    /// The server's address once it's up, installing and starting it as
    /// needed, for the language's model.
    func ready(language: String) async throws -> URL {
        idleStop?.cancel()
        if let process, process.isRunning, let port, self.language == language {
            return URL(string: "http://127.0.0.1:\(port)")!
        }
        if let starting, self.language == language { return try await starting.task.value }
        stop()
        self.language = language
        let id = UUID()
        let task = Task { try await self.start(language: language, id: id) }
        starting = (id, task)
        defer { if starting?.id == id { starting = nil } }
        return try await task.value
    }

    /// Stops it a few minutes from now, unless it's wanted again first.
    func stopSoon() {
        idleStop?.cancel()
        idleStop = Task { [weak self] in
            try? await Task.sleep(for: .seconds(300))
            guard !Task.isCancelled else { return }
            self?.stop()
        }
    }

    func stop() {
        idleStop?.cancel()
        starting?.task.cancel()
        starting = nil
        if let process, process.isRunning { process.terminate() }
        process = nil
        port = nil
        language = nil
        try? FileManager.default.removeItem(at: Self.pidFile(owner: getpid()))
    }

    // MARK: A server left behind by a crash

    /// The running server's process id, in a file named for the app that
    /// started it, as a debug build shares this folder. The app quitting stops
    /// the server, but a crash can't, and one nobody talks to would hold its
    /// model in memory until the Mac restarts.
    private static func pidFile(owner: pid_t) -> URL { folder.appendingPathComponent("serve.\(owner).pid") }

    /// Stops a server an earlier run of the app left going, checking it's
    /// really ours first: pids get reused. On launch, whether or not Voice is
    /// on, so turning the experiment off can't strand one, and before a start.
    /// One whose app is still running is left alone: a debug build mustn't
    /// end Mike's conversation in the real app.
    static func reapLeftover() {
        let files = (try? FileManager.default.contentsOfDirectory(atPath: folder.path)) ?? []
        for name in files where name.hasPrefix("serve.") && name.hasSuffix(".pid") {
            let file = folder.appendingPathComponent(name)
            guard let owner = pid_t(name.dropFirst("serve.".count).dropLast(".pid".count)) else { continue }
            if owner != getpid(), kill(owner, 0) == 0 { continue }
            if let text = try? String(contentsOf: file, encoding: .utf8),
               let pid = pid_t(text.trimmingCharacters(in: .whitespacesAndNewlines)), pid > 1,
               // The real path of what's running against ours as written, so
               // a symlink swapped in at our path can't point this at another
               // program.
               executablePath(of: pid) == binary.standardizedFileURL.path {
                kill(pid, SIGTERM)
                VoiceLog.write("stopped pocket-tts left over from an earlier run")
            }
            try? FileManager.default.removeItem(at: file)
        }
    }

    private static func executablePath(of pid: pid_t) -> String? {
        var buffer = [CChar](repeating: 0, count: 4 * Int(MAXPATHLEN))
        guard proc_pidpath(pid, &buffer, UInt32(buffer.count)) > 0 else { return nil }
        return String(cString: buffer)
    }

    // MARK: Starting

    private func start(language: String, id: UUID) async throws -> URL {
        #if !arch(arm64)
        throw Failure.notAppleSilicon
        #endif
        if !isInstalled { try await install(id: id) }
        // A newer start (or a stop) took over during the download.
        guard starting?.id == id, !Task.isCancelled else { throw CancellationError() }
        Self.reapLeftover()
        onStatus?("Starting the voice engine…")
        let port = try Self.freePort()
        let process = Process()
        process.executableURL = Self.binary
        process.arguments = ["serve", "--host", "127.0.0.1", "--port", String(port), "--language", language]
        process.currentDirectoryURL = Self.folder
        let log = Self.folder.appendingPathComponent("serve.log")
        FileManager.default.createFile(atPath: log.path, contents: nil)
        let handle = try FileHandle(forWritingTo: log)
        process.standardOutput = handle
        process.standardError = handle
        do { try process.run() } catch { throw Failure.start(error.localizedDescription) }
        self.process = process
        self.port = port
        try? String(process.processIdentifier).write(to: Self.pidFile(owner: getpid()), atomically: true, encoding: .utf8)
        let base = URL(string: "http://127.0.0.1:\(port)")!
        // The first start downloads the model, which can take a minute.
        onStatus?(FileManager.default.fileExists(atPath: Self.hubCache.path) ? "Starting the voice engine…" : "Downloading the voice model (about 240 MB)…")
        for _ in 0..<600 {
            // Overtaken: stop() has ended this process, or is about to find
            // the newer one in its place, so don't touch self.process.
            guard starting?.id == id, !Task.isCancelled else {
                if process.isRunning { process.terminate() }
                throw CancellationError()
            }
            guard process.isRunning else {
                let tail = (try? String(contentsOf: log, encoding: .utf8))?.split(separator: "\n").suffix(2).joined(separator: " ") ?? ""
                throw Failure.start(tail.isEmpty ? "it stopped" : tail)
            }
            if let (_, response) = try? await URLSession.shared.data(from: base), (response as? HTTPURLResponse)?.statusCode == 200 {
                VoiceLog.write("pocket-tts \(Self.release) up on \(port) (\(language))")
                return base
            }
            try await Task.sleep(for: .milliseconds(500))
        }
        if starting?.id == id { stop() } else if process.isRunning { process.terminate() }
        throw Failure.start("it took too long")
    }

    static var hubCache: URL {
        FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".cache/huggingface/hub/models--kyutai--pocket-tts-without-voice-cloning")
    }

    private func install(id: UUID) async throws {
        onStatus?("Downloading the voice engine…")
        let (file, response): (URL, URLResponse)
        do { (file, response) = try await URLSession.shared.download(from: Self.downloadURL) } catch { throw Failure.download(error.localizedDescription) }
        defer { try? FileManager.default.removeItem(at: file) }
        guard (response as? HTTPURLResponse)?.statusCode == 200 else { throw Failure.download("the server said \((response as? HTTPURLResponse)?.statusCode ?? 0)") }
        let unpack = Self.folder.appendingPathComponent("unpack-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: unpack) }
        // Checking and unpacking a big archive isn't for the main thread.
        let inner = try await Task.detached(priority: .userInitiated) {
            try Self.checkAndUnpack(file, into: unpack)
        }.value
        // Overtaken while unpacking: the newer start installs its own, and
        // the two mustn't both move into place.
        guard starting?.id == id else { throw CancellationError() }
        let dest = Self.binary.deletingLastPathComponent()
        try? FileManager.default.removeItem(at: dest)
        try FileManager.default.createDirectory(at: dest.deletingLastPathComponent(), withIntermediateDirectories: true)
        try FileManager.default.moveItem(at: inner, to: dest)
        VoiceLog.write("installed pocket-tts \(Self.release)")
    }

    /// The archive's checksum, then its contents into `unpack`: the folder
    /// holding the program. Nothing is unpacked from one that doesn't match.
    private nonisolated static func checkAndUnpack(_ file: URL, into unpack: URL) throws -> URL {
        let data = try Data(contentsOf: file, options: .mappedIfSafe)
        guard SHA256.hash(data: data).map({ String(format: "%02x", $0) }).joined() == sha256 else { throw Failure.checksum }
        try FileManager.default.createDirectory(at: unpack, withIntermediateDirectories: true)
        let tar = Process()
        tar.executableURL = URL(fileURLWithPath: "/usr/bin/tar")
        tar.arguments = ["-xzf", file.path, "-C", unpack.path]
        try tar.run()
        tar.waitUntilExit()
        guard tar.terminationStatus == 0,
              let inner = try FileManager.default.contentsOfDirectory(at: unpack, includingPropertiesForKeys: nil).first(where: { $0.hasDirectoryPath }),
              FileManager.default.fileExists(atPath: inner.appendingPathComponent("pocket-tts").path)
        else { throw Failure.download("the archive wasn't as expected") }
        return inner
    }

    /// A port nothing's listening on, from the kernel.
    static func freePort() throws -> Int {
        let fd = socket(AF_INET, SOCK_STREAM, 0)
        guard fd >= 0 else { throw Failure.start("no socket") }
        defer { close(fd) }
        var addr = sockaddr_in()
        addr.sin_family = sa_family_t(AF_INET)
        addr.sin_addr.s_addr = inet_addr("127.0.0.1")
        addr.sin_port = 0
        var len = socklen_t(MemoryLayout<sockaddr_in>.size)
        let bound = withUnsafeMutablePointer(to: &addr) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { bind(fd, $0, len) == 0 && getsockname(fd, $0, &len) == 0 }
        }
        guard bound else { throw Failure.start("no free port") }
        return Int(UInt16(bigEndian: addr.sin_port))
    }
}
