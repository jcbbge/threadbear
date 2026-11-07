import Foundation

/// A text file open in the pane: what's on disk, read and written as
/// UTF-8, and a watch on it, so a file an agent rewrites while Mike is
/// reading it (or editing it) is reloaded rather than shown stale. No
/// AppKit: the view binds to it (TextFileView).
public final class TextFileDocument: @unchecked Sendable {
    public let url: URL
    /// Read no more than this; the pane is for a look and small edits,
    /// not a log viewer.
    public static let limit = 2_000_000

    /// The text as last read from or written to the file.
    public private(set) var saved = ""
    /// Only the start of the file was read (over `limit`): shown, but
    /// never written back, which would cut the file off.
    public private(set) var truncated = false
    /// The bytes weren't UTF-8 (shown with replacement characters), so
    /// saving would change what the file holds: read only.
    public private(set) var lossy = false

    public var isEditable: Bool { !truncated && !lossy }

    /// What the watch found when the file changed on disk.
    public enum Change: Equatable, Sendable {
        /// The file now says what the view already has (its own write, a
        /// touch): nothing to do.
        case same
        /// Nothing unsaved in the view, or the file changed to exactly
        /// what's typed: show the file's text.
        case reload(String)
        /// Someone else wrote the file while the view holds unsaved edits.
        /// Neither side is thrown away until Mike picks one.
        case conflict(String)
        /// The file is gone (renamed away, deleted).
        case gone
    }

    private var source: DispatchSourceFileSystemObject?
    private var rewatch: DispatchWorkItem?
    private var onChange: ((Change) -> Void)?
    private var shownText: (() -> String)?

    public init(url: URL) {
        self.url = url
    }

    deinit { stopWatching() }

    // MARK: Reading and writing

    /// Reads the file. Throws if it can't be read at all.
    @discardableResult
    public func load() throws -> String {
        let read = try read()
        truncated = read.truncated
        lossy = read.lossy
        saved = read.text
        return saved
    }

    private func read() throws -> (text: String, truncated: Bool, lossy: Bool) {
        let handle = try FileHandle(forReadingFrom: url)
        defer { try? handle.close() }
        let data = try handle.read(upToCount: Self.limit) ?? Data()
        if let text = String(data: data, encoding: .utf8) {
            return (text, data.count == Self.limit, false)
        }
        return (String(decoding: data, as: UTF8.self), data.count == Self.limit, true)
    }

    /// Writes `text` over the file, in place: the same inode, mode and
    /// owner (an atomic replace would give it the temp file's, and lose
    /// an executable bit). Does nothing when the file is read only or
    /// `text` is what's there already.
    public func save(_ text: String) throws {
        guard isEditable, text != saved else { return }
        let handle = try FileHandle(forWritingTo: url)
        defer { try? handle.close() }
        try handle.truncate(atOffset: 0)
        try handle.write(contentsOf: Data(text.utf8))
        saved = text
    }

    /// The file's text if it no longer says what was last read or written
    /// (someone else wrote it), else nil. Read just before a save, so an
    /// edit the watch hasn't reported yet isn't written over. Throws if it
    /// can't be read, as then nobody can say it's safe to write. A change
    /// to something too big or not UTF-8 makes the file read only, as a
    /// load would, so nothing cut off or mangled is ever written back.
    public func changedOnDisk() throws -> String? {
        let read = try read()
        // Even when it decodes to the same text: bytes that aren't UTF-8
        // can read as what was saved and still be mangled by a write.
        truncated = read.truncated
        lossy = read.lossy
        return read.text == saved ? nil : read.text
    }

    // MARK: Deciding what a change on disk means

    /// What to do when the file on disk has changed: `onDisk` is its text
    /// now, `shown` what the view holds (which differs from `saved` only
    /// by unsaved edits).
    public static func change(onDisk: String, saved: String, shown: String) -> Change {
        if onDisk == saved { return .same }
        if shown == saved || onDisk == shown { return .reload(onDisk) }
        return .conflict(onDisk)
    }

    /// Takes the file's text as the saved one, for `.conflict` when Mike
    /// keeps the file's (the view then shows it) or the view's (its next
    /// save then writes over it). Whether it can be written stays as the
    /// read that found it said (`changedOnDisk`): a conflict over a file
    /// that's become too big or not UTF-8 mustn't make it editable.
    public func adopt(_ text: String) {
        saved = text
    }

    // MARK: Watching

    /// Calls `onChange` on the main queue when the file changes on disk,
    /// with what to do about it; `shown` says what the view holds at that
    /// moment. An agent's atomic write renames a new file over this one,
    /// so the watch follows the path, not the open descriptor.
    public func watch(shown: @escaping () -> String, onChange: @escaping (Change) -> Void) {
        self.shownText = shown
        self.onChange = onChange
        startWatching()
    }

    public func stopWatching() {
        source?.cancel()
        source = nil
        rewatch?.cancel()
        rewatch = nil
    }

    private func startWatching() {
        source?.cancel()
        source = nil
        let fd = open(url.path, O_EVTONLY)
        guard fd >= 0 else {
            // Not there (yet): look again shortly, in case it's mid-replace.
            scheduleRewatch(after: .milliseconds(300))
            return
        }
        let source = DispatchSource.makeFileSystemObjectSource(fileDescriptor: fd, eventMask: [.write, .extend, .rename, .delete, .attrib], queue: .main)
        source.setEventHandler { [weak self] in
            guard let self, let current = self.source, current === source else { return }
            let flags = source.data
            if flags.contains(.rename) || flags.contains(.delete) {
                // The path may now be a new file (an atomic write), or
                // nothing: reopen it after the write has settled.
                self.scheduleRewatch(after: .milliseconds(150))
            } else {
                self.scheduleCheck()
            }
        }
        source.setCancelHandler { close(fd) }
        source.resume()
        self.source = source
    }

    private func scheduleRewatch(after delay: DispatchTimeInterval) {
        rewatch?.cancel()
        let item = DispatchWorkItem { [weak self] in
            guard let self else { return }
            if FileManager.default.fileExists(atPath: self.url.path) {
                self.startWatching()
                self.check()
            } else {
                self.onChange?(.gone)
            }
        }
        rewatch = item
        DispatchQueue.main.asyncAfter(deadline: .now() + delay, execute: item)
    }

    private var pendingCheck: DispatchWorkItem?

    /// A write comes as a burst of events; one read a short while after
    /// the last of them.
    private func scheduleCheck() {
        pendingCheck?.cancel()
        let item = DispatchWorkItem { [weak self] in self?.check() }
        pendingCheck = item
        DispatchQueue.main.asyncAfter(deadline: .now() + .milliseconds(120), execute: item)
    }

    /// Reads the file and says what changed. Public so a view can ask
    /// straight away (after its own `opened` bump).
    public func check() {
        guard let onChange, let shownText else { return }
        guard let read = try? read() else {
            onChange(.gone)
            return
        }
        let shown = shownText()
        // Whether it can be written changed, even with the same text (a
        // binary file put back as UTF-8).
        let flagsChanged = read.truncated != truncated || read.lossy != lossy
        var change: Change
        if shown == saved {
            // No unsaved edits: show the file as it is now.
            change = read.text == saved && !flagsChanged ? .same : .reload(read.text)
        } else if !isEditable || read.truncated || read.lossy {
            // Unsaved edits, and a file that can't take them now (too big,
            // not UTF-8) or couldn't before: they're never thrown away by
            // the watch. Whether it can be written follows this read, so
            // no save writes it back cut off or mangled.
            truncated = read.truncated
            lossy = read.lossy
            if read.text == shown {
                change = .reload(read.text)
            } else {
                change = read.text == saved && !flagsChanged ? .same : .conflict(read.text)
            }
        } else {
            change = Self.change(onDisk: read.text, saved: saved, shown: shown)
        }
        if case .reload = change {
            truncated = read.truncated
            lossy = read.lossy
            saved = read.text
        }
        if change != .same { onChange(change) }
    }
}
