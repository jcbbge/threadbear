import Foundation

/// A yes or a no said to an approval card in Voice mode. Only a whole answer
/// counts, one of the phrases below once the filler's gone, so anything more
/// ("no, use the other folder") is a message, which declines the card with
/// his words, as typing does. Whole phrases, not a bag of allowed words: as a
/// bag, "do you always do that?" came out as always allow (Codex's review).
public enum SpokenAnswer {
    public static func decision(_ said: String, options: [ApprovalOption]) -> ApprovalDecision? {
        // "Okay?" is him asking.
        guard !said.contains("?") else { return nil }
        let phrase = said.lowercased()
            .replacingOccurrences(of: "’", with: "'")
            .replacingOccurrences(of: "thank you", with: " ")
            .replacingOccurrences(of: #"[^a-z' ]"#, with: " ", options: .regularExpression)
            .split(separator: " ").map(String.init)
            .filter { !filler.contains($0) }
            .joined(separator: " ")
        if no.contains(phrase) { return options.contains(.deny) ? .deny : nil }
        if always.contains(phrase) { return options.contains(.allowAlways) ? .allowAlways : nil }
        if yes.contains(phrase) { return options.contains(.allow) ? .allow : nil }
        return nil
    }

    /// Said round an answer and meaning nothing on their own.
    static let filler: Set<String> = ["um", "uh", "er", "erm", "hmm", "please", "thanks", "bear", "threadbear"]

    static let yes: Set<String> = {
        let starts = ["yes", "yeah", "yep", "yup", "sure", "ok", "okay", "alright"]
        let acts = ["go ahead", "go ahead and do it", "do it", "run it", "allow it", "that's fine", "sounds good"]
        return Set(starts + acts + ["allow", "approve", "approve it", "approved"] + starts.flatMap { start in acts.map { "\(start) \($0)" } })
    }()

    static let always: Set<String> = ["always allow", "always allow it", "allow always", "yes always", "yes always allow", "yes always allow it"]

    static let no: Set<String> = {
        let plain = ["no", "nope", "nah", "deny", "deny it", "decline", "cancel", "cancel it", "cancel that", "stop", "stop it", "skip", "skip it", "not now", "not yet", "no way"]
        let dont = ["don't", "don't do it", "don't do that", "dont", "dont do it", "dont do that", "do not do it", "do not do that"]
        return Set(plain + dont + dont.map { "no \($0)" } + ["no stop", "no cancel", "no not now", "no not yet"])
    }()
}
