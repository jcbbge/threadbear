import AppKit
import ThreadbearCore

/// Plays CompletionSound's ding when a thread finishes, if it's turned on.
/// Several threads finishing together make one ding, not a pile of them.
@MainActor
enum DingPlayer {
    private static var playing: NSSound?
    private static var lastPlayed = Date.distantPast
    private static var made: [CompletionSound.Ding: Data] = [:]

    static var isOn: Bool { UserDefaults.standard.bool(forKey: CompletionSound.enabledKey) }

    /// After a thread's summary changes: the ding, if it just finished.
    static func threadChanged(from previous: ThreadStatus?, to now: ThreadStatus) {
        guard isOn, CompletionSound.finished(from: previous, to: now) else { return }
        guard Date().timeIntervalSince(lastPlayed) > 1.5 else { return }
        play()
    }

    /// Plays the chosen ding now, or `ding` (Settings' Play button).
    static func play(_ ding: CompletionSound.Ding? = nil) {
        let defaults = UserDefaults.standard
        let chosen = ding ?? CompletionSound.ding(defaults.string(forKey: CompletionSound.dingKey) ?? "")
        let volume = defaults.object(forKey: CompletionSound.volumeKey) as? Double ?? CompletionSound.defaultVolume
        let data = made[chosen] ?? CompletionSound.wav(chosen)
        made[chosen] = data
        guard let sound = NSSound(data: data) else { return }
        playing?.stop()
        sound.volume = Float(max(0, min(1, volume)))
        playing = sound
        lastPlayed = Date()
        sound.play()
    }
}
