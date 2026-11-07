import CryptoKit
import Foundation
import Observation
import os

/// Which engine the new-thread mic uses. Unset until the first tap, which
/// asks (Mike, 6 Nov): Whisper is far better at his short dictations than
/// Apple's, but it's an 874 MB download, which shouldn't happen unasked.
enum DictationEngine: String, CaseIterable {
    case apple, whisper

    static let key = "dictation.engine"

    static var chosen: DictationEngine? {
        get { UserDefaults.standard.string(forKey: key).flatMap(DictationEngine.init) }
        set { UserDefaults.standard.set(newValue?.rawValue, forKey: key) }
    }

    var label: String {
        switch self {
        case .apple: "Apple"
        case .whisper: "Whisper"
        }
    }
}

/// Whisper large-v3-turbo (q8_0), from Hugging Face at a pinned commit: the
/// same file Voice Type runs on the Mac, from the same place the Voice Type
/// iPhone keyboard fetched it. Only the weights: in the foreground the GPU
/// runs the encoder, so the 1.2 GB Core ML encoder the keyboard needed for
/// the background isn't wanted here.
///
/// A background download, so it carries on with the app closed.
@MainActor @Observable
final class WhisperModel: NSObject {
    static let shared = WhisperModel()

    nonisolated private static let url = URL(string: "https://huggingface.co/ggerganov/whisper.cpp/resolve/5359861c739e955e79d9a303bcbc70fb988958b1/ggml-large-v3-turbo-q8_0.bin")!
    nonisolated private static let sha256 = "317eb69c11673c9de1e1f0d459b253999804ec71ac4c23c17ecf5fbe24e259a1"
    static let bytes: Int64 = 874_188_075
    static let sizeText = "874 MB"
    nonisolated static let sessionId = "com.mikecann.threadbear.whisper"

    /// Application Support, not Documents, so it isn't in the Files app, and
    /// left out of iCloud backups since it can always be fetched again.
    nonisolated static var fileURL: URL {
        URL.applicationSupportDirectory.appendingPathComponent("Whisper/ggml-large-v3-turbo-q8_0.bin")
    }

    private(set) var installed = FileManager.default.fileExists(atPath: WhisperModel.fileURL.path)
    /// 0 to 1 while downloading, nil otherwise.
    private(set) var progress: Double?
    private(set) var problem: String?
    @ObservationIgnored var backgroundCompletion: (() -> Void)?

    private let log = Logger(subsystem: "com.mikecann.threadbear", category: "whisper")
    @ObservationIgnored private lazy var session: URLSession = {
        let config = URLSessionConfiguration.background(withIdentifier: Self.sessionId)
        // Asked for with the size in front of him, so mobile data is fine;
        // the system still holds it for wifi in Low Data Mode.
        config.allowsConstrainedNetworkAccess = false
        config.sessionSendsLaunchEvents = true
        return URLSession(configuration: config, delegate: Delegate(), delegateQueue: nil)
    }()

    /// Starts the download, or picks up one already going.
    func download() {
        guard !installed else { return }
        problem = nil
        if progress == nil { progress = 0 }
        let session = session
        let url = Self.url
        session.getAllTasks { tasks in
            guard tasks.isEmpty else { return }
            session.downloadTask(with: url).resume()
        }
    }

    /// At launch: hears about a download that went on while the app was
    /// closed. Doesn't start one, as a finished download's file can still be
    /// on its way in; the next mic tap does that.
    func reconnect() {
        if !installed, DictationEngine.chosen == .whisper { _ = session }
    }

    func delete() {
        try? FileManager.default.removeItem(at: Self.fileURL)
        installed = false
    }

    fileprivate func received(_ written: Int64) {
        progress = min(Double(written) / Double(Self.bytes), 1)
    }

    fileprivate func finished(_ error: String?) {
        installed = FileManager.default.fileExists(atPath: Self.fileURL.path)
        progress = nil
        problem = installed ? nil : error ?? "The download didn't finish."
        if let error { log.error("Whisper download: \(error, privacy: .public)") }
    }

    fileprivate func eventsDone() {
        backgroundCompletion?()
        backgroundCompletion = nil
    }

    /// The download's callbacks come on URLSession's own queue.
    private final class Delegate: NSObject, URLSessionDownloadDelegate {
        func urlSession(_ session: URLSession, downloadTask: URLSessionDownloadTask, didWriteData _: Int64,
                        totalBytesWritten written: Int64, totalBytesExpectedToWrite _: Int64) {
            Task { @MainActor in WhisperModel.shared.received(written) }
        }

        func urlSession(_ session: URLSession, downloadTask: URLSessionDownloadTask, didFinishDownloadingTo location: URL) {
            // The file is gone once this returns, so it's checked and moved here.
            var problem: String?
            do {
                guard try Self.sha256(of: location) == WhisperModel.sha256 else { throw CocoaError(.fileReadCorruptFile) }
                var folder = WhisperModel.fileURL.deletingLastPathComponent()
                try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
                var values = URLResourceValues()
                values.isExcludedFromBackup = true
                try? folder.setResourceValues(values)
                try? FileManager.default.removeItem(at: WhisperModel.fileURL)
                try FileManager.default.moveItem(at: location, to: WhisperModel.fileURL)
            } catch {
                problem = error.localizedDescription
            }
            Task { @MainActor in WhisperModel.shared.finished(problem) }
        }

        func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
            guard let error else { return }
            Task { @MainActor in WhisperModel.shared.finished(error.localizedDescription) }
        }

        func urlSessionDidFinishEvents(forBackgroundURLSession session: URLSession) {
            Task { @MainActor in WhisperModel.shared.eventsDone() }
        }

        private static func sha256(of url: URL) throws -> String {
            let handle = try FileHandle(forReadingFrom: url)
            defer { try? handle.close() }
            var hash = SHA256()
            while let data = try handle.read(upToCount: 1 << 20), !data.isEmpty { hash.update(data: data) }
            return hash.finalize().map { String(format: "%02x", $0) }.joined()
        }
    }
}
