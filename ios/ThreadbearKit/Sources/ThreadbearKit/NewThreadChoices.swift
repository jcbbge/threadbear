import Foundation

/// One model an account offers (backend API 20), as the Mac's model picker
/// lists it: `id` is what a new thread sends.
public struct PhoneModelChoice: Codable, Sendable, Hashable, Identifiable {
    public var id: String
    public var title: String
    public var effortLevels: [String]?
    public var defaultEffort: String?

    public init(id: String, title: String, effortLevels: [String]? = nil, defaultEffort: String? = nil) {
        self.id = id
        self.title = title
        self.effortLevels = effortLevels
        self.defaultEffort = defaultEffort
    }
}

/// A row of phone:accounts: a login on one of the runners. Only what the
/// new thread pickers need; the rest of the row is left alone.
public struct PhoneAccount: Codable, Sendable, Hashable, Identifiable {
    public var id: String
    public var runnerId: String?
    public var provider: String
    public var title: String
    public var models: [PhoneModelChoice]

    public init(id: String, runnerId: String? = nil, provider: String, title: String, models: [PhoneModelChoice] = []) {
        self.id = id
        self.runnerId = runnerId
        self.provider = provider
        self.title = title
        self.models = models
    }

    private enum Keys: String, CodingKey { case id, runnerId, provider, title, models }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        id = try c.decode(String.self, forKey: .id)
        runnerId = (try? c.decodeIfPresent(String.self, forKey: .runnerId)).flatMap { $0 }
        provider = (try? c.decodeIfPresent(String.self, forKey: .provider)).flatMap { $0 } ?? "claude"
        title = (try? c.decodeIfPresent(String.self, forKey: .title)).flatMap { $0 } ?? id
        // A backend before API 20 has no models: no pickers, not a broken row.
        models = (try? c.decodeIfPresent([PhoneModelChoice].self, forKey: .models)).flatMap { $0 } ?? []
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: Keys.self)
        try c.encode(id, forKey: .id)
        try c.encodeIfPresent(runnerId, forKey: .runnerId)
        try c.encode(provider, forKey: .provider)
        try c.encode(title, forKey: .title)
        try c.encode(models, forKey: .models)
    }
}

/// What a new thread from the phone can name. Nil is the runner's usual.
/// No login: naming a model is enough for the runner to pick a login of its
/// provider with room (runner.ts, pickForNew), as on the Mac.
public struct NewThreadSettings: Sendable, Hashable {
    public var model: String?
    public var effort: String?

    public init(model: String? = nil, effort: String? = nil) {
        self.model = model
        self.effort = effort
    }
}

/// The new thread sheet's runner, model and effort pickers, from the
/// mirrored runners and accounts.
public enum NewThreadChoices {
    /// Where a new thread starts unless Mike picks another: the first runner
    /// online of those he's placed in his order (phone:runners lists them in
    /// it), or else the main Mac, to wait for. A runner he hasn't placed is
    /// never picked for him, so a Mac with a runner key only gets his words
    /// when he's said so. Nil with neither, which leaves it to the backend
    /// (phone:create's own choice). Draining ones are passed over.
    public static func runner(_ runners: [PhoneRunner], now: Date) -> PhoneRunner? {
        runners.first { $0.placed == true && $0.isOnline(at: now) && $0.draining != true }
            ?? runners.first { $0.main == true }
    }

    /// The models on offer on one runner: its own logins' (a row with no
    /// runner is anyone's). None while its logins haven't come up yet, so it
    /// starts on its own default rather than another Mac's model.
    public static func models(_ accounts: [PhoneAccount], runnerId: String?) -> [PhoneModelChoice] {
        guard let runnerId else { return models(accounts) }
        return models(accounts.filter { $0.runnerId == nil || $0.runnerId == runnerId })
    }

    /// Every model on offer, Claude's first, each once.
    public static func models(_ accounts: [PhoneAccount]) -> [PhoneModelChoice] {
        let order = ["claude", "codex"]
        let sorted = accounts.enumerated().sorted { a, b in
            let x = order.firstIndex(of: a.element.provider) ?? order.count
            let y = order.firstIndex(of: b.element.provider) ?? order.count
            return x != y ? x < y : a.offset < b.offset
        }.map(\.element)
        var seen = Set<String>()
        var out: [PhoneModelChoice] = []
        for account in sorted {
            for model in account.models where seen.insert(model.id).inserted { out.append(model) }
        }
        return out
    }

    /// The efforts a model offers, or with no model picked Claude's levels
    /// (the runner drops one the model it lands on doesn't offer).
    public static func efforts(for model: PhoneModelChoice?) -> [String] {
        let levels = model?.effortLevels ?? []
        return levels.isEmpty ? claudeLevels : levels.filter { all.contains($0) }
    }

    public static func effortTitle(_ level: String) -> String {
        titles[level] ?? level.capitalized
    }

    /// Whether a picked effort still fits once the model changes.
    public static func keeps(effort: String?, model: PhoneModelChoice?) -> Bool {
        guard let effort else { return true }
        return efforts(for: model).contains(effort)
    }

    static let all = ["low", "medium", "high", "xhigh", "max", "ultra"]
    static let claudeLevels = ["low", "medium", "high", "xhigh", "max"]
    static let titles = ["low": "Low", "medium": "Medium", "high": "High", "xhigh": "Extra high", "max": "Max", "ultra": "Ultra"]
}
