import Foundation

/// The voices, speeds and languages Voice mode offers (Settings > Voice).
/// Voices are pocket-tts's built-in ones; Emily and Mike are the names
/// asked for, on pocket-tts's eve and michael.
public struct VoiceOption: Sendable, Hashable, Identifiable {
    /// What's saved in UserDefaults.
    public let id: String
    public let name: String
    /// pocket-tts's name for it (its `voice_url`).
    public let engineVoice: String

    public init(id: String, name: String, engineVoice: String) {
        self.id = id
        self.name = name
        self.engineVoice = engineVoice
    }
}

public struct VoiceLanguage: Sendable, Hashable, Identifiable {
    /// pocket-tts's `--language`.
    public let id: String
    public let name: String
    /// What Apple's speech recognition listens for.
    public let locale: String
}

public enum VoiceCatalog {
    public static let voiceKey = "voiceName"
    public static let speedKey = "voiceSpeed"
    public static let languageKey = "voiceLanguage"
    public static let microphoneKey = "voiceMicrophone"

    public static let voices: [VoiceOption] = [
        VoiceOption(id: "emily", name: "Emily", engineVoice: "eve"),
        VoiceOption(id: "mike", name: "Mike", engineVoice: "michael"),
    ] + [
        "alba", "anna", "azelma", "cosette", "eponine", "estelle", "fantine", "jane", "lola", "mary", "vera",
        "charles", "george", "giovanni", "javert", "jean", "juergen", "marius", "paul", "rafael",
    ].map { VoiceOption(id: $0, name: $0.prefix(1).uppercased() + $0.dropFirst(), engineVoice: $0) }

    public static let defaultVoice = voices[0]

    /// The saved voice, or Emily for anything unknown.
    public static func voice(_ id: String?) -> VoiceOption {
        voices.first { $0.id == id } ?? defaultVoice
    }

    public static let speeds: [Double] = [0.75, 1, 1.25, 1.5, 2]

    /// "1x", "1.25x".
    public static func speedTitle(_ speed: Double) -> String {
        let text = speed == speed.rounded() ? String(Int(speed)) : String(format: "%g", speed)
        return text + "x"
    }

    /// The saved speed, clamped to one that's offered.
    public static func speed(_ value: Double?) -> Double {
        guard let value, value > 0 else { return 1 }
        return speeds.min { abs($0 - value) < abs($1 - value) } ?? 1
    }

    public static let languages: [VoiceLanguage] = [
        VoiceLanguage(id: "english", name: "English", locale: "en-US"),
        VoiceLanguage(id: "french", name: "French", locale: "fr-FR"),
        VoiceLanguage(id: "german", name: "German", locale: "de-DE"),
        VoiceLanguage(id: "spanish", name: "Spanish", locale: "es-ES"),
        VoiceLanguage(id: "italian", name: "Italian", locale: "it-IT"),
        VoiceLanguage(id: "portuguese", name: "Portuguese", locale: "pt-PT"),
        VoiceLanguage(id: "dutch", name: "Dutch", locale: "nl-NL"),
    ]

    public static func language(_ id: String?) -> VoiceLanguage {
        languages.first { $0.id == id } ?? languages[0]
    }
}
