import Foundation

/// The runner's settings, as the Settings window shows them
/// (docs/protocol.md, "Settings and models"), all kept in the runner's
/// runner.json. Decoded as forgivingly as the other models, so a missing
/// field takes its default and an older runner's OpenRouter fields (key,
/// budget, spend) are ignored.
public struct RunnerSettings: Sendable, Hashable, Decodable {
    /// How often a fork's runner starts a thread to bring in Mike's
    /// releases (runner/src/bring-in.ts): every so many days, only for
    /// ones he marks important, or never. Sent as a number or a word.
    public enum BringIn: Sendable, Hashable {
        case every(Int)
        case important
        case off

        public static let standard = BringIn.every(5)

        var json: JSONValue {
            switch self {
            case .every(let days): .number(Double(days))
            case .important: .string("important")
            case .off: .string("off")
            }
        }

        static func decode(_ c: KeyedDecodingContainer<CodingKeys>) -> BringIn? {
            if let days = try? c.decodeIfPresent(Int.self, forKey: .bringIn) { return days >= 1 ? .every(days) : nil }
            switch (try? c.decodeIfPresent(String.self, forKey: .bringIn)) ?? nil {
            case "important": return .important
            case "off": return .off
            default: return nil
            }
        }
    }

    public struct Models: Sendable, Hashable, Decodable {
        /// The pool whose Claude logins answer small jobs (titles, the
        /// librarian); nil means none, so those are off.
        public var pool: String?
        /// Whether the runner sends `pool` at all. A much older one doesn't.
        public var poolSupported: Bool
        /// Folders whose thread text is never sent, as written ("~/" kept).
        public var privateFolders: [String]

        public init(pool: String? = nil, poolSupported: Bool = false, privateFolders: [String] = []) {
            self.pool = pool
            self.poolSupported = poolSupported
            self.privateFolders = privateFolders
        }

        public init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            poolSupported = c.contains(.pool)
            pool = ((try? c.decodeIfPresent(String.self, forKey: .pool)) ?? nil).flatMap { $0.isEmpty ? nil : $0 }
            privateFolders = c.lossyArray(String.self, forKey: .privateFolders)
        }

        enum CodingKeys: String, CodingKey { case pool, privateFolders }
    }

    public var defaultCwd: String
    public var idleMinutes: Int
    public var maxLiveCLIs: Int
    /// Takes effect when the runner next restarts.
    public var followMain: Bool
    /// A turn's reply: end_turn's bullets, or (false) the agent's own message.
    public var bulletReplies: Bool
    /// One reply (docs/protocol.md): end_turn carries the card, and the
    /// agent's message after it is the reply. Takes over from bullet replies.
    public var oneReply: Bool
    public var bringIn: BringIn
    /// Whether the runner sends `bringIn` at all. An older one doesn't.
    public var bringInSupported: Bool
    public var models: Models

    public init(defaultCwd: String = "", idleMinutes: Int = 30, maxLiveCLIs: Int = 6, followMain: Bool = true, bulletReplies: Bool = true, oneReply: Bool = false,
                bringIn: BringIn = .standard, bringInSupported: Bool = false, models: Models = Models()) {
        self.defaultCwd = defaultCwd
        self.idleMinutes = idleMinutes
        self.maxLiveCLIs = maxLiveCLIs
        self.followMain = followMain
        self.bulletReplies = bulletReplies
        self.oneReply = oneReply
        self.bringIn = bringIn
        self.bringInSupported = bringInSupported
        self.models = models
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        defaultCwd = (try? c.decodeIfPresent(String.self, forKey: .defaultCwd)) ?? ""
        idleMinutes = c.number(.idleMinutes).flatMap { Int(checked: $0.rounded()) } ?? 30
        maxLiveCLIs = c.number(.maxLiveCLIs).flatMap { Int(checked: $0.rounded()) } ?? 6
        followMain = (try? c.decodeIfPresent(Bool.self, forKey: .followMain)) ?? true
        bulletReplies = (try? c.decodeIfPresent(Bool.self, forKey: .bulletReplies)) ?? true
        oneReply = (try? c.decodeIfPresent(Bool.self, forKey: .oneReply)) ?? false
        bringInSupported = c.contains(.bringIn)
        bringIn = BringIn.decode(c) ?? .standard
        models = (try? c.decodeIfPresent(Models.self, forKey: .models)) ?? Models()
    }

    enum CodingKeys: String, CodingKey { case defaultCwd, idleMinutes, maxLiveCLIs, followMain, bulletReplies, oneReply, bringIn, models }
}

/// Fields for `settings.update`; nil ones are left out, so an edit to one
/// field never overwrites another a second client just changed.
public struct SettingsUpdate: Sendable, Hashable {
    public var defaultCwd: String?
    public var idleMinutes: Int?
    public var maxLiveCLIs: Int?
    public var followMain: Bool?
    public var bulletReplies: Bool?
    public var oneReply: Bool?
    public var bringIn: RunnerSettings.BringIn?
    /// `.some(nil)` sends null: no pool, so no small jobs.
    public var pool: String??
    public var privateFolders: [String]?

    public init(defaultCwd: String? = nil, idleMinutes: Int? = nil, maxLiveCLIs: Int? = nil, followMain: Bool? = nil, bulletReplies: Bool? = nil, oneReply: Bool? = nil,
                bringIn: RunnerSettings.BringIn? = nil, pool: String?? = nil, privateFolders: [String]? = nil) {
        self.pool = pool
        self.bringIn = bringIn
        self.defaultCwd = defaultCwd
        self.idleMinutes = idleMinutes
        self.maxLiveCLIs = maxLiveCLIs
        self.followMain = followMain
        self.bulletReplies = bulletReplies
        self.oneReply = oneReply
        self.privateFolders = privateFolders
    }

    public var params: [String: JSONValue] {
        var params: [String: JSONValue] = [:]
        if let defaultCwd { params["defaultCwd"] = .string(defaultCwd) }
        if let idleMinutes { params["idleMinutes"] = .number(Double(idleMinutes)) }
        if let maxLiveCLIs { params["maxLiveCLIs"] = .number(Double(maxLiveCLIs)) }
        if let followMain { params["followMain"] = .bool(followMain) }
        if let bulletReplies { params["bulletReplies"] = .bool(bulletReplies) }
        if let oneReply { params["oneReply"] = .bool(oneReply) }
        if let bringIn { params["bringIn"] = bringIn.json }
        var models: [String: JSONValue] = [:]
        if let pool { models["pool"] = pool.map { .string($0) } ?? .null }
        if let privateFolders { models["privateFolders"] = .array(privateFolders.map { .string($0) }) }
        if !models.isEmpty { params["models"] = .object(models) }
        return params
    }
}

public struct SettingsResult: Sendable, Decodable {
    public var settings: RunnerSettings
}

public extension RPCClient {
    func settingsGet() async throws -> RunnerSettings {
        try await call("settings.get", .object([:]), as: SettingsResult.self).settings
    }

    func settingsUpdate(_ update: SettingsUpdate) async throws -> RunnerSettings {
        try await call("settings.update", .object(update.params), as: SettingsResult.self).settings
    }
}

private extension KeyedDecodingContainer {
    /// A number sent as a number or a numeric string.
    func number(_ key: Key) -> Double? {
        if let value = try? decodeIfPresent(Double.self, forKey: key) { return value }
        if let text = try? decodeIfPresent(String.self, forKey: key) { return Double(text) }
        return nil
    }
}

public enum SettingsText {
    /// The choices for how often Mike's releases come in by themselves,
    /// with a custom number of days from runner.json kept as its own one.
    public static func bringInChoices(current: RunnerSettings.BringIn) -> [(title: String, value: RunnerSettings.BringIn)] {
        var days = [1, 3, 5, 7, 14]
        if case .every(let n) = current, !days.contains(n) { days.append(n); days.sort() }
        return days.map { (bringInTitle(.every($0)), RunnerSettings.BringIn.every($0)) }
            + [(bringInTitle(.important), .important), (bringInTitle(.off), .off)]
    }

    public static func bringInTitle(_ b: RunnerSettings.BringIn) -> String {
        switch b {
        case .every(1): "Every day"
        case .every(7): "Every week"
        case .every(14): "Every 2 weeks"
        case .every(let n): "Every \(n) days"
        case .important: "Only important ones"
        case .off: "Never"
        }
    }

    /// A folder as Mike would write it: "~/dev/x" for one in his home.
    public static func folder(_ path: String, home: String = NSHomeDirectory()) -> String {
        guard !home.isEmpty, path == home || path.hasPrefix(home + "/") else { return path }
        return "~" + path.dropFirst(home.count)
    }
}
