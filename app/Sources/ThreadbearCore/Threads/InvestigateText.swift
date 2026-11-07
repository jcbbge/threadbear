import Foundation

/// The error bar's Investigate button: the brief for a new thread in the
/// app's own checkout that finds why an error came up and fixes it (Mike,
/// 7 Nov 2026, after "Couldn't trust poddle: Thread not found: ..."). The
/// bar's text alone rarely says enough, so it carries what the app knew
/// when the error came up.
public enum InvestigateText {
    /// What the app knew when the error was shown.
    public struct Report: Sendable, Equatable {
        public var message: String
        public var at: Date
        /// The thread it came up in: the one acted on, or else the one open.
        public var threadId: String?
        public var threadTitle: String?
        public var threadFolder: String?
        /// What he was doing, where the code that showed it says
        /// ("pressing Trust on a patch in the Patches panel").
        public var doing: String?
        public var appVersion: String?
        public var appCommit: String?
        public var runnerVersion: String?

        public init(message: String, at: Date, threadId: String? = nil, threadTitle: String? = nil, threadFolder: String? = nil,
                    doing: String? = nil, appVersion: String? = nil, appCommit: String? = nil, runnerVersion: String? = nil) {
            self.message = message
            self.at = at
            self.threadId = threadId
            self.threadTitle = threadTitle
            self.threadFolder = threadFolder
            self.doing = doing
            self.appVersion = appVersion
            self.appCommit = appCommit
            self.runnerVersion = runnerVersion
        }
    }

    /// The new thread's title: the error's first words.
    public static func title(_ r: Report) -> String {
        let flat = r.message.split(whereSeparator: \.isNewline).joined(separator: " ")
        let short = flat.count > 50 ? flat.prefix(49).trimmingCharacters(in: .whitespaces) + "…" : flat
        return "Error: \(short)"
    }

    public static func prompt(_ r: Report) -> String {
        var lines = ["The Threadbear Mac app showed this in its error bar:", "", "> " + r.message.replacingOccurrences(of: "\n", with: "\n> "), ""]
        let stamp = ISO8601DateFormatter()
        stamp.timeZone = .current
        lines.append("- When: \(stamp.string(from: r.at))")
        if let id = r.threadId {
            var thread = "- In thread \(id)"
            if let title = r.threadTitle, !title.isEmpty { thread += " (\"\(title)\")" }
            if let folder = r.threadFolder, !folder.isEmpty { thread += ", folder \(folder)" }
            lines.append(thread)
        } else {
            lines.append("- No thread was open")
        }
        if let doing = r.doing { lines.append("- Mike was \(doing)") }
        let app = [r.appVersion.map { "app \($0)" }, r.appCommit.map { "built from \($0)" }].compactMap { $0 }.joined(separator: ", ")
        if !app.isEmpty { lines.append("- The \(app)") }
        if let runner = r.runnerVersion, !runner.isEmpty { lines.append("- Runner \(runner)") }
        lines += ["", "Find the cause in this checkout and fix it. Start from where the app sets that text (`errorMessage`), follow it to whatever failed, and check `tb logs` and `~/Library/Logs/Threadbear` around that time. Test first, then land it as AGENTS.md says. If it turns out not to be a bug (something Mike has to do, or another service), say what and why instead of changing code."]
        return lines.joined(separator: "\n")
    }
}
