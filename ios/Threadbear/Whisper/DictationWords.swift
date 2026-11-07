import Foundation
import Observation

/// Names Whisper should spell right, given to it as a prompt the way Voice
/// Type on the Mac does ("Convex, Tailscale, Sammy Cam."): on Mike's own
/// recordings that fixed most misheard names, and kept capitals and
/// punctuation on short dictations. Starts with words anyone running coding
/// agents says; Settings › Dictation › Words changes them.
@MainActor @Observable
final class DictationWords {
    static let shared = DictationWords()
    private static let key = "dictation.words"

    static let defaults = ["Threadbear", "Claude", "Codex", "Convex", "GitHub", "PR", "worktrees",
                           "Tailscale", "Slack", "Notion", "Cloudflare", "Vercel", "Whisper"]

    private(set) var words: [String]

    private init() {
        words = UserDefaults.standard.stringArray(forKey: Self.key) ?? Self.defaults
        // `-ThreadbearAddWords "A, B"` at launch adds to the list and keeps
        // them: how a Mac's own words get onto a phone without typing them.
        if let extra = UserDefaults.standard.string(forKey: "ThreadbearAddWords") {
            add(extra.split(separator: ",").map(String.init))
        }
    }

    func add(_ new: [String]) {
        var seen = Set(words.map { $0.lowercased() })
        for word in new.map({ $0.trimmingCharacters(in: .whitespaces) }) where !word.isEmpty {
            if seen.insert(word.lowercased()).inserted { words.append(word) }
        }
        save()
    }

    func remove(at offsets: IndexSet) {
        words.remove(atOffsets: offsets)
        save()
    }

    func restoreDefaults() {
        words = Self.defaults
        save()
    }

    /// Whisper's prompt: "A, B, C." (nil for none).
    var prompt: String? { words.isEmpty ? nil : words.joined(separator: ", ") + "." }

    private func save() { UserDefaults.standard.set(words, forKey: Self.key) }
}
