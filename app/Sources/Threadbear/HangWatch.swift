import CoreGraphics
import Foundation
import ThreadbearCore

/// Catches the main thread stuck, while it's stuck. A freeze ends in a
/// force-quit, which leaves no crash report, and by then there's nothing left
/// to sample: Mike hit several in a day (29 and 30 Oct) and all the logs could
/// say was where they began. So a background queue posts a beat to the main
/// queue each second, and when one hasn't arrived after `stallAfter` it runs
/// `/usr/bin/sample` on this process, which works however stuck the main
/// thread is. The file goes in `folder` with a note of how the stall ended.
///
/// Sentry's own hang tracking stays off (CrashReporting): it reports every
/// slow render. Here the next launch sends only stalls long enough to be
/// freezes, as their frames (never the file), so the watcher opens a thread.
final class HangWatch: @unchecked Sendable {
    /// Long enough that no ordinary busy moment gets sampled, short enough
    /// that the sample is done before anyone reaches for Force Quit.
    static let stallAfter: TimeInterval = 4
    static let sampleSeconds = 3
    /// What the next launch reports. Shorter ones stay in the folder.
    static let reportAfter: TimeInterval = 15
    /// Files older than this at launch are finished: a sample outlives the
    /// app it's sampling, and may still be writing just after a force-quit.
    static let settledAfter: TimeInterval = 30
    static let keep = 10

    static var defaultFolder: URL {
        FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/Logs/Threadbear/hangs")
    }

    struct Record: Codable {
        var at: Date
        var build: String?
        /// Seconds until the main thread came back; nil if it never did.
        var recoveredAfter: TimeInterval?
        var reported: Bool?
        var context: Context?

        /// What goes to Sentry with the frames: symbol names and numbers, no
        /// user text. Out here so a test can see it, as the send itself is
        /// only in release builds, and Sentry wants plain JSON values.
        func extras(frames: [String]) -> [String: Any] {
            var extras: [String: Any] = [
                "frames": Array(frames.suffix(60)),
                "seconds": recoveredAfter.map { Int($0) } ?? "never came back",
                "build": build ?? "unknown",
            ]
            // Records from before these were kept have none.
            if let priority = context?.mainPriority { extras["mainPriority"] = priority }
            if let load = context?.loadAverage { extras["loadAverage"] = load }
            if let idle = context?.idleSeconds { extras["idleSeconds"] = Int(idle) }
            return extras
        }
    }

    /// How the Mac was when the stall was noticed, sent with the report. A
    /// stall at low priority on an overloaded Mac with nobody there
    /// (THREADBEAR-1B: 33 s, display off, load 60 to 77) isn't the same bug as
    /// one under Mike's hands, and afterwards nothing could say what the
    /// priority had been.
    struct Context: Codable, Equatable {
        /// The main thread's scheduling priority at that moment: 46 or so
        /// normally, 4 when something has clamped it to background (seen
        /// with the display off; App Nap is the likely reason, not a proven
        /// one).
        var mainPriority: Int?
        var loadAverage: Double?
        var idleSeconds: Double?
    }

    static func currentContext(mainThread: mach_port_t) -> Context {
        var load = [0.0]
        let gotLoad = getloadavg(&load, 1) == 1
        return Context(mainPriority: priority(of: mainThread), loadAverage: gotLoad ? load[0] : nil,
                       // ~0 is kCGAnyInputEventType, which Swift doesn't import.
                       idleSeconds: CGEventType(rawValue: ~0).map { CGEventSource.secondsSinceLastEventType(.combinedSessionState, eventType: $0) })
    }

    private static func priority(of thread: mach_port_t) -> Int? {
        var info = thread_extended_info_data_t()
        var count = mach_msg_type_number_t(MemoryLayout<thread_extended_info_data_t>.size / MemoryLayout<natural_t>.size)
        let result = withUnsafeMutablePointer(to: &info) { pointer in
            pointer.withMemoryRebound(to: integer_t.self, capacity: Int(count)) {
                thread_info(thread, thread_flavor_t(THREAD_EXTENDED_INFO), $0, &count)
            }
        }
        return result == KERN_SUCCESS ? Int(info.pth_curpri) : nil
    }

    nonisolated(unsafe) private static var current: HangWatch?

    /// `report` gets the frames of each past stall that's long enough.
    static func start(folder: URL, build: String?, report: @escaping @Sendable (_ frames: [String], _ record: Record) -> Void) {
        guard current == nil else { return }
        let watch = HangWatch(folder: folder, build: build)
        current = watch
        watch.queue.async {
            watch.reportPast(report)
            watch.prune()
        }
        watch.beginBeating()
    }

    private let queue = DispatchQueue(label: "com.mikerosoft.threadbear.hangwatch", qos: .utility)
    private let folder: URL
    private let build: String?
    private var timer: DispatchSourceTimer?
    // All on `queue`.
    private var beatPostedAt: UInt64?
    private var stall: (name: String, startedAt: UInt64)?

    /// Taken at startup, on the main thread (`start`'s callers are). Looking
    /// it up during a stall would take libpthread's thread-list lock, which
    /// the stuck thread might be holding, and this queue must never wait on
    /// anything the main thread could have.
    private let mainThread = pthread_mach_thread_np(pthread_self())

    private init(folder: URL, build: String?) {
        self.folder = folder
        self.build = build
    }

    private func beginBeating() {
        let timer = DispatchSource.makeTimerSource(queue: queue)
        timer.schedule(deadline: .now() + 1, repeating: 1, leeway: .milliseconds(500))
        timer.setEventHandler { [self] in tick() }
        timer.resume()
        self.timer = timer
    }

    private func tick() {
        // Uptime, which stands still while the Mac sleeps.
        let now = DispatchTime.now().uptimeNanoseconds
        guard let postedAt = beatPostedAt else {
            beatPostedAt = now
            DispatchQueue.main.async { [self] in
                queue.async { self.beatArrived() }
            }
            return
        }
        if stall == nil, TimeInterval(now - postedAt) / 1e9 >= Self.stallAfter {
            stall = (name: Self.fileName(for: Date()), startedAt: postedAt)
            beginSample(stall!.name)
        }
    }

    private func beatArrived() {
        defer { beatPostedAt = nil }
        guard let stall else { return }
        self.stall = nil
        let seconds = TimeInterval(DispatchTime.now().uptimeNanoseconds - stall.startedAt) / 1e9
        AppLog.write("hang", "main thread back after \(String(format: "%.1f", seconds)) s")
        var record = read(stall.name) ?? Record(at: Date(), build: build)
        record.recoveredAfter = seconds
        write(record, stall.name)
    }

    private func beginSample(_ name: String) {
        try? FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        write(Record(at: Date(), build: build), name)
        let path = folder.appendingPathComponent(name + ".sample").path
        AppLog.write("hang", "main thread stuck for \(Int(Self.stallAfter)) s, sampling to \(path)")
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/sandbox-exec")
        let profile = HangSample.sandboxProfile(home: FileManager.default.homeDirectoryForCurrentUser.path)
        process.arguments = ["-p", profile, "/usr/bin/sample", String(ProcessInfo.processInfo.processIdentifier), String(Self.sampleSeconds), "-file", path]
        process.standardOutput = FileHandle.nullDevice
        process.standardError = FileHandle.nullDevice
        do {
            try process.run()
        } catch {
            AppLog.write("hang", "couldn't run sample: \(error.localizedDescription)")
        }
        // After the sample's away: asking for the idle time goes through the
        // window server, and whatever that does, the sample is what counts.
        if var record = read(name) {
            record.context = Self.currentContext(mainThread: mainThread)
            write(record, name)
        }
    }

    private func reportPast(_ report: (_ frames: [String], _ record: Record) -> Void) {
        for name in names() {
            guard var record = read(name), record.reported != true,
                  Date().timeIntervalSince(record.at) >= Self.settledAfter else { continue }
            record.reported = true
            write(record, name)
            if let seconds = record.recoveredAfter, seconds < Self.reportAfter { continue }
            let sample = try? String(contentsOf: folder.appendingPathComponent(name + ".sample"), encoding: .utf8)
            let frames = HangSample.heaviestMainThreadPath(sample ?? "")
            guard !frames.isEmpty, !HangSample.isIdle(frames) else { continue }
            report(frames, record)
        }
    }

    private func prune() {
        for name in names().dropLast(Self.keep) {
            try? FileManager.default.removeItem(at: folder.appendingPathComponent(name + ".json"))
            try? FileManager.default.removeItem(at: folder.appendingPathComponent(name + ".sample"))
        }
    }

    /// Oldest first: the names sort by time.
    private func names() -> [String] {
        let files = (try? FileManager.default.contentsOfDirectory(atPath: folder.path)) ?? []
        return files.filter { $0.hasSuffix(".json") }.map { String($0.dropLast(5)) }.sorted()
    }

    private func read(_ name: String) -> Record? {
        guard let data = try? Data(contentsOf: folder.appendingPathComponent(name + ".json")) else { return nil }
        return try? Self.decoder.decode(Record.self, from: data)
    }

    private func write(_ record: Record, _ name: String) {
        guard let data = try? Self.encoder.encode(record) else { return }
        try? data.write(to: folder.appendingPathComponent(name + ".json"), options: .atomic)
    }

    private static func fileName(for date: Date) -> String {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.dateFormat = "yyyy-MM-dd-HHmmss"
        return "hang-" + formatter.string(from: date)
    }

    private static let encoder: JSONEncoder = {
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        return encoder
    }()

    private static let decoder: JSONDecoder = {
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        return decoder
    }()
}
