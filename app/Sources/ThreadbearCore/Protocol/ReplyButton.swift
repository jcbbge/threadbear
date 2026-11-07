import Foundation
import Synchronization

/// A button an agent put in its reply (docs/protocol.md, "Reply buttons"):
/// `add_button` stores one on the thread, the reply links it as
/// `[title](button:<id>)`, and Mike's press starts a thread with the brief
/// or sends the message, once. Exactly one of `start` and `send`.
public struct ReplyButton: Sendable, Hashable, Decodable, Identifiable {
    public struct Start: Sendable, Hashable, Decodable {
        public var text: String
        public var title: String?
        public var cwd: String
        public var accountId: String?
        public var model: String?
        public var permissionMode: String?

        public init(text: String, title: String? = nil, cwd: String, accountId: String? = nil, model: String? = nil, permissionMode: String? = nil) {
            self.text = text
            self.title = title
            self.cwd = cwd
            self.accountId = accountId
            self.model = model
            self.permissionMode = permissionMode
        }

        public init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            text = (try? c.decodeIfPresent(String.self, forKey: .text)) ?? ""
            title = try? c.decodeIfPresent(String.self, forKey: .title)
            cwd = (try? c.decodeIfPresent(String.self, forKey: .cwd)) ?? ""
            accountId = try? c.decodeIfPresent(String.self, forKey: .accountId)
            model = try? c.decodeIfPresent(String.self, forKey: .model)
            permissionMode = try? c.decodeIfPresent(String.self, forKey: .permissionMode)
        }

        enum CodingKeys: String, CodingKey { case text, title, cwd, accountId, model, permissionMode }
    }

    public struct Send: Sendable, Hashable, Decodable {
        public var threadId: String
        public var threadTitle: String
        public var text: String

        public init(threadId: String, threadTitle: String, text: String) {
            self.threadId = threadId
            self.threadTitle = threadTitle
            self.text = text
        }

        public init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            threadId = (try? c.decodeIfPresent(String.self, forKey: .threadId)) ?? ""
            threadTitle = (try? c.decodeIfPresent(String.self, forKey: .threadTitle)) ?? ""
            text = (try? c.decodeIfPresent(String.self, forKey: .text)) ?? ""
        }

        enum CodingKeys: String, CodingKey { case threadId, threadTitle, text }
    }

    public struct Pressed: Sendable, Hashable, Decodable {
        public var at: String
        public var threadId: String
        public init(at: String, threadId: String) { self.at = at; self.threadId = threadId }
    }

    public struct Failed: Sendable, Hashable, Decodable {
        public var at: String
        public var error: String
        public init(at: String, error: String) { self.at = at; self.error = error }
    }

    public var id: String
    public var title: String
    public var createdAt: String
    public var turnId: String?
    public var start: Start?
    public var send: Send?
    public var pressed: Pressed?
    public var failed: Failed?

    public init(id: String, title: String, createdAt: String = "", turnId: String? = nil, start: Start? = nil, send: Send? = nil,
                pressed: Pressed? = nil, failed: Failed? = nil) {
        self.id = id
        self.title = title
        self.createdAt = createdAt
        self.turnId = turnId
        self.start = start
        self.send = send
        self.pressed = pressed
        self.failed = failed
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        title = (try? c.decodeIfPresent(String.self, forKey: .title)) ?? ""
        createdAt = (try? c.decodeIfPresent(String.self, forKey: .createdAt)) ?? ""
        turnId = try? c.decodeIfPresent(String.self, forKey: .turnId)
        start = try? c.decodeIfPresent(Start.self, forKey: .start)
        send = try? c.decodeIfPresent(Send.self, forKey: .send)
        pressed = try? c.decodeIfPresent(Pressed.self, forKey: .pressed)
        failed = try? c.decodeIfPresent(Failed.self, forKey: .failed)
    }

    enum CodingKeys: String, CodingKey { case id, title, createdAt, turnId, start, send, pressed, failed }

    /// Whether this snapshot is newer than `old`. A button only moves
    /// forward (made, then failed any number of times, then pressed for
    /// good), so the state says which came later even when the snapshots
    /// arrive out of order: an older page's event, or `buttons.list`
    /// racing a live `button.updated`.
    public func supersedes(_ old: ReplyButton) -> Bool {
        if old.pressed != nil { return false }
        if pressed != nil { return true }
        switch (failed, old.failed) {
        case (nil, nil): return self != old
        case (nil, _?): return false
        case (_?, nil): return true
        case let (new?, previous?): return new.at > previous.at || (new.at == previous.at && self != old)
        }
    }
}

/// What a press's `buttons.press` and `buttons.list` reply with.
public struct ReplyButtonReply: Sendable, Decodable {
    public var button: ReplyButton
}

private struct ReplyButtonsList: Sendable, Decodable {
    var buttons: [ReplyButton]

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        buttons = c.lossyArray(ReplyButton.self, forKey: .buttons)
    }

    enum CodingKeys: String, CodingKey { case buttons }
}

public extension RPCClient {
    /// Every button the thread has, oldest first: replies older than the
    /// loaded page link buttons whose events aren't loaded.
    func replyButtons(threadId: String) async throws -> [ReplyButton] {
        try await call("buttons.list", .object(["threadId": .string(threadId)]), as: ReplyButtonsList.self).buttons
    }

    /// Starts the thread or sends the message, once. A pressed button comes
    /// back as it is.
    func pressReplyButton(threadId: String, buttonId: String) async throws -> ReplyButton {
        try await call("buttons.press", .object(["threadId": .string(threadId), "buttonId": .string(buttonId)]), as: ReplyButtonReply.self).button
    }
}

/// The latest snapshot of every reply button the app has seen, by id, and
/// which presses are on their way. Read from any thread, as rows render
/// across cores: a reply that links a button keys its render on
/// `generation`, and every change posts `changed` so those rows draw again.
public final class ReplyButtons: @unchecked Sendable {
    public static let shared = ReplyButtons()
    public static let changed = Notification.Name("ReplyButtons.changed")

    public struct Known: Sendable, Hashable {
        public var threadId: String
        public var button: ReplyButton
    }

    private struct Inner {
        var known: [String: Known] = [:]
        var pressing: Set<String> = []
        var generation = 0
    }

    private let inner = Mutex(Inner())

    public init() {}

    public var generation: Int { inner.withLock { $0.generation } }

    public func known(_ id: String) -> Known? { inner.withLock { $0.known[id] } }

    public func isPressing(_ id: String) -> Bool { inner.withLock { $0.pressing.contains(id) } }

    /// Keeps `button` unless what's known of it is newer. True if anything changed.
    @discardableResult
    public func receive(_ buttons: [ReplyButton], threadId: String) -> Bool {
        let changed = inner.withLock { inner -> Bool in
            var changed = false
            for button in buttons {
                if let old = inner.known[button.id], old.threadId == threadId, !button.supersedes(old.button) { continue }
                inner.known[button.id] = Known(threadId: threadId, button: button)
                changed = true
            }
            if changed { inner.generation += 1 }
            return changed
        }
        if changed { Self.postChanged() }
        return changed
    }

    @discardableResult
    public func receive(_ button: ReplyButton, threadId: String) -> Bool { receive([button], threadId: threadId) }

    /// The `button.updated` events among `events`.
    @discardableResult
    public func fold(_ events: some Sequence<Event>, threadId: String) -> Bool {
        let buttons = events.compactMap { event -> ReplyButton? in
            if case .buttonUpdated(let button) = event.payload { return button }
            return nil
        }
        return buttons.isEmpty ? false : receive(buttons, threadId: threadId)
    }

    /// Marks a press as on its way (or back). False if it already was, so a
    /// second click while the first is out does nothing.
    @discardableResult
    public func setPressing(_ id: String, _ on: Bool) -> Bool {
        let changed = inner.withLock { inner -> Bool in
            let done = on ? inner.pressing.insert(id).inserted : inner.pressing.remove(id) != nil
            if done { inner.generation += 1 }
            return done
        }
        if changed { Self.postChanged() }
        return changed
    }

    /// On the main thread, where the transcript listens.
    private static func postChanged() {
        if Thread.isMainThread {
            NotificationCenter.default.post(name: changed, object: nil)
        } else {
            DispatchQueue.main.async { NotificationCenter.default.post(name: changed, object: nil) }
        }
    }

    public func removeAll() {
        inner.withLock { inner in
            inner = Inner(generation: inner.generation + 1)
        }
    }

    // MARK: Links

    public static let scheme = "button"

    /// Whether a reply could link a button: only those rows' renders key on
    /// `generation`.
    public static func mayHold(_ text: String) -> Bool { text.contains("](button:") }

    /// The ids of the buttons a reply links, in order.
    public static func ids(in text: String) -> [String] {
        guard mayHold(text) else { return [] }
        let ns = text as NSString
        return link.matches(in: text, range: NSRange(location: 0, length: ns.length)).map { ns.substring(with: $0.range(at: 1)) }
    }

    nonisolated(unsafe) private static let link = try! NSRegularExpression(pattern: #"\]\(button:\s*([A-Za-z0-9_-]+)\s*\)"#)

    /// The button a `button:` link names.
    public static func id(of url: URL) -> String? {
        guard url.scheme?.lowercased() == scheme else { return nil }
        let id = url.absoluteString.dropFirst(scheme.count + 1).trimmingCharacters(in: .whitespaces)
        return id.isEmpty ? nil : id
    }

    // MARK: How one looks

    public enum Look: String, Sendable {
        case start, send, pressing, pressed, failed
    }

    public static func look(_ button: ReplyButton, pressing: Bool) -> Look {
        if button.pressed != nil { return .pressed }
        if pressing { return .pressing }
        if button.failed != nil { return .failed }
        return button.send != nil ? .send : .start
    }

    /// What the pill says: a mark for what it does, then its title.
    public static func label(_ button: ReplyButton, look: Look) -> String {
        let mark: String
        switch look {
        // U+FE0E keeps ▶ a text glyph rather than the emoji.
        case .start: mark = "\u{25B6}\u{FE0E}"
        case .send: mark = "\u{21AA}\u{FE0E}"
        case .pressing: mark = "\u{2026}"
        case .pressed: mark = "\u{2713}"
        case .failed: mark = "!"
        }
        return mark + " " + button.title
    }

    /// The pill's tip: what pressing does, in the agent's own words.
    public static func tip(_ button: ReplyButton, look: Look) -> String {
        let what: String
        if let start = button.start {
            let folder = (start.cwd as NSString).lastPathComponent
            what = "Starts a thread in \(folder.isEmpty ? start.cwd : folder): " + excerpt(start.text)
        } else if let send = button.send {
            what = "Sends to \"\(send.threadTitle)\": " + excerpt(send.text)
        } else {
            what = button.title
        }
        switch look {
        case .start, .send: return what
        case .pressing: return "On its way. " + what
        case .pressed: return (button.send != nil ? "Sent. Click to open the thread it went to." : "Started. Click to open the thread it started.") + "\n\n" + what
        case .failed: return "That didn't work: \(button.failed?.error ?? "unknown error"). Click to try again.\n\n" + what
        }
    }

    /// The first ~200 characters, on one line.
    static func excerpt(_ text: String, limit: Int = 200) -> String {
        let flat = text.replacingOccurrences(of: #"\s+"#, with: " ", options: .regularExpression).trimmingCharacters(in: .whitespaces)
        guard flat.count > limit else { return flat }
        return String(flat.prefix(limit)).trimmingCharacters(in: .whitespaces) + "\u{2026}"
    }
}
