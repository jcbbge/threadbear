import Foundation

/// A question and its answer, sent back as `history` so follow-ups make sense.
nonisolated struct Exchange: Codable, Equatable, Hashable, Sendable {
    var question: String
    var answer: String
}

/// The JSON body of `POST /api/quick/ask`.
nonisolated struct AskBody: Codable, Equatable, Sendable {
    var question: String
    /// Oldest first, at most three. Left out when empty.
    var history: [Exchange]?
    /// IANA, e.g. Australia/Perth
    var timezone: String
    /// ISO 8601 with the phone's UTC offset, e.g. 2026-10-23T14:06:00+08:00
    var clientTime: String
}

/// Everything about talking to the server that doesn't need a network: building requests and
/// turning failures into plain words. The contract is docs/ask-server.md.
nonisolated enum AskAPI {
    static let pingPath = "/api/quick/ping"
    static let askPath = "/api/quick/ask"
    static let historyLimit = 3

    static func body(question: String, history: [Exchange], timeZone: TimeZone, now: Date) -> AskBody {
        let recent = recentHistory(history)
        return AskBody(
            question: question.trimmingCharacters(in: .whitespacesAndNewlines),
            history: recent.isEmpty ? nil : recent,
            timezone: timeZone.identifier,
            clientTime: isoTime(now, in: timeZone)
        )
    }

    /// The last three exchanges that have both a question and an answer, oldest first. Both answer
    /// sources send the same history.
    static func recentHistory(_ history: [Exchange]) -> [Exchange] {
        let usable = history.filter {
            !$0.question.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                && !$0.answer.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        }
        return Array(usable.suffix(historyLimit))
    }

    static func encode(_ body: AskBody) throws -> Data {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
        return try encoder.encode(body)
    }

    static func askRequest(baseURL: URL, token: String, body: AskBody) throws -> URLRequest {
        var request = URLRequest(url: baseURL.appending(path: askPath))
        request.httpMethod = "POST"
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("application/x-ndjson", forHTTPHeaderField: "Accept")
        request.httpBody = try encode(body)
        // The stream watchdog retains the 30 s initial wait, then 15 s between stage lines.
        // URLSession must allow the silent deep wait; its request limit can't change mid-body.
        request.timeoutInterval = 75
        request.cachePolicy = .reloadIgnoringLocalCacheData
        return request
    }

    static func pingRequest(baseURL: URL) -> URLRequest {
        var request = URLRequest(url: baseURL.appending(path: pingPath))
        request.httpMethod = "GET"
        request.timeoutInterval = 10
        request.cachePolicy = .reloadIgnoringLocalCacheData
        return request
    }

    static func isoTime(_ date: Date, in timeZone: TimeZone) -> String {
        let formatter = ISO8601DateFormatter()
        formatter.timeZone = timeZone
        formatter.formatOptions = [.withInternetDateTime]
        return formatter.string(from: date)
    }

    /// Accepts what someone might type: no scheme, a trailing slash, stray spaces.
    static func normalizeBaseURL(_ string: String) -> URL? {
        var trimmed = string.trimmingCharacters(in: .whitespacesAndNewlines)
        while trimmed.hasSuffix("/") { trimmed.removeLast() }
        guard !trimmed.isEmpty else { return nil }
        if !trimmed.contains("://") { trimmed = "https://" + trimmed }
        guard let url = URL(string: trimmed), let scheme = url.scheme?.lowercased(),
              scheme == "https" || scheme == "http", url.host() != nil else { return nil }
        return url
    }

    /// The token format Settings expects (`aa_<16 hex>_<secret>`). Only used to warn, not to refuse.
    static func looksLikeToken(_ token: String) -> Bool {
        token.wholeMatch(of: /aa_[0-9a-f]{16}_\S+/) != nil
    }

    /// `{ "error": "..." }` from a failed request, if that's what came back.
    static func errorMessage(from data: Data) -> String? {
        struct Body: Decodable { var error: String? }
        guard let message = (try? JSONDecoder().decode(Body.self, from: data))?.error?
            .trimmingCharacters(in: .whitespacesAndNewlines), !message.isEmpty else { return nil }
        return message
    }
}

/// Why a question didn't get an answer, in words for the screen. The words depend on where the
/// question went, so `message(from:)` takes the answer source.
nonisolated enum AskFailure: Error, Equatable, Sendable {
    /// No server token.
    case noToken
    case badBaseURL
    case unauthorized
    /// A 402: whatever the server pays for its models has run out.
    case outOfCredit
    case rateLimited(String?)
    case badRequest(String?)
    case server(status: Int, message: String?)
    case offline
    case timedOut
    case unreachable
    case network(String)
    case cutOff
    /// The model (or server) accepted the question and then sent no answer.
    case emptyAnswer

    static func from(status: Int, body: Data) -> AskFailure {
        let message = AskAPI.errorMessage(from: body)
        switch status {
        case 401, 403: return .unauthorized
        case 429: return .rateLimited(message)
        case 400..<500: return .badRequest(message)
        default: return .server(status: status, message: message)
        }
    }

    static func from(_ error: URLError) -> AskFailure {
        switch error.code {
        case .notConnectedToInternet, .networkConnectionLost, .dataNotAllowed, .internationalRoamingOff:
            return .offline
        case .timedOut:
            return .timedOut
        case .cannotFindHost, .cannotConnectToHost, .dnsLookupFailed, .secureConnectionFailed,
             .serverCertificateUntrusted, .serverCertificateHasBadDate, .appTransportSecurityRequiresSecureConnection:
            return .unreachable
        default:
            return .network(error.localizedDescription)
        }
    }

    /// In words for the screen. Questions only ever go to the user's Ask server here.
    var message: String {
        switch self {
        case .noToken:
            return "There's no token for your Ask server yet. Add one in Settings."
        case .badBaseURL:
            return "The server address in Settings doesn't look right."
        case .unauthorized:
            return "Your Ask server didn't accept the token. Check it in Settings."
        case .outOfCredit:
            return "The server is out of credit."
        case .rateLimited(let detail):
            return "That's a lot of questions in a short time. Give it a minute and try again." + Self.suffix(detail)
        case .badRequest(let detail):
            return "The server didn't accept that question." + Self.suffix(detail)
        case .server(let status, let detail):
            return "The server had a problem (\(status)). Try again in a moment." + Self.suffix(detail)
        case .offline:
            return "You're offline. Check your connection and try again."
        case .timedOut:
            return "The server took too long to answer. Try again."
        case .unreachable:
            // Servers are often on a private network or VPN (Mike's is on his tailnet).
            return "Couldn't reach your Ask server. Is this phone on its network or VPN?"
        case .network(let detail):
            return "Couldn't reach the server: \(detail)"
        case .cutOff:
            return "The answer was cut off part way through."
        case .emptyAnswer:
            return "The answer came back empty. Try asking again."
        }
    }

    /// Whether Settings is the place to fix it.
    var needsSettings: Bool {
        switch self {
        case .noToken, .badBaseURL, .unauthorized, .unreachable: true
        default: false
        }
    }

    private static func suffix(_ detail: String?) -> String {
        guard let detail, !detail.isEmpty else { return "" }
        return " (\(detail))"
    }
}

/// A `threadbear://quickask?url=<server>&token=<aa_…>` link, from Agent Archive's QR code.
/// Opening one hands every later question, and the token, to whatever server it names, so a
/// link has to be https (Mike's is `tailscale serve`, which always is), and every one is
/// confirmed first, naming its host (ThreadbearApp), the first one included.
nonisolated struct QuickAskLink: Equatable, Sendable {
    /// The server as the link gave it, kept as typed (Settings shows it).
    var server: String
    var token: String

    enum Refusal: Error, Equatable {
        /// Not a quickask link at all: something else (pairing) may want it.
        case notQuickAsk
        /// A quickask link, but missing its server or token, or not https.
        case unusable
    }

    static func parse(_ url: URL) -> Result<QuickAskLink, Refusal> {
        guard url.scheme == "threadbear", url.host() == "quickask" else { return .failure(.notQuickAsk) }
        guard let items = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems,
              let server = items.first(where: { $0.name == "url" })?.value,
              // No scheme is taken as https, as Settings does; plain http never is, as the
              // token and every question would go over it in the clear.
              AskAPI.normalizeBaseURL(server)?.scheme?.lowercased() == "https",
              let token = items.first(where: { $0.name == "token" })?.value, !token.isEmpty
        else { return .failure(.unusable) }
        return .success(QuickAskLink(server: server, token: token))
    }

    /// Host and port, as an alert names it ("bruce.tail9ef766.ts.net:9443").
    var hostName: String { AskAPI.normalizeBaseURL(server).map(Self.hostName) ?? server }

    static func hostName(_ url: URL) -> String {
        let host = url.host()?.lowercased() ?? ""
        return url.port.map { "\(host):\($0)" } ?? host
    }

    /// Whether this link would point Quick Ask somewhere other than `current`, for the
    /// alert's wording. Only the host and port count: a new token for the same server is
    /// the usual re-pair. No server yet is a change too: that first link is the one an
    /// attacker's would most likely be.
    func changesServer(from current: URL?) -> Bool {
        guard let current else { return true }
        return Self.hostName(current) != hostName
    }
}
