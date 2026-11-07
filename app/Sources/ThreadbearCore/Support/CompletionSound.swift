import Foundation

/// The soft ding that says a thread is done (Settings > General >
/// Notifications), off until it's turned on. It plays when a thread stops
/// working: its turn finished, it's waiting for an answer, or it failed.
/// Not when it was stopped, as whoever stopped it knows. The three dings
/// are made here as WAV data, so there's no sound file to ship.
public enum CompletionSound {
    public static let enabledKey = "completionSound"
    public static let dingKey = "completionSoundDing"
    public static let volumeKey = "completionSoundVolume"
    public static let defaultVolume = 0.6

    public enum Ding: String, CaseIterable, Identifiable, Sendable {
        case chime, bell, droplet

        public var id: String { rawValue }

        public var title: String {
            switch self {
            case .chime: "Chime"
            case .bell: "Bell"
            case .droplet: "Droplet"
            }
        }
    }

    public static func ding(_ raw: String) -> Ding { Ding(rawValue: raw) ?? .chime }

    /// Whether a thread going from `previous` to `now` has just finished working.
    public static func finished(from previous: ThreadStatus?, to now: ThreadStatus) -> Bool {
        guard let previous, previous == .running || previous == .starting else { return false }
        return now == .idle || now == .waiting || now == .error
    }

    static let sampleRate = 44_100

    /// A partial: a sine at `ratio` times the note, `level` loud, dying away over `decay` seconds.
    private struct Partial { let ratio: Double; let level: Double; let decay: Double }
    /// A note starting `at` seconds in, gliding from `from` Hz to `to` over `glide` seconds.
    private struct Note { let at: Double; let from: Double; let to: Double; let glide: Double; let partials: [Partial] }

    private static func notes(_ ding: Ding) -> (length: Double, notes: [Note]) {
        switch ding {
        case .chime:
            // Two notes going up, G5 then C6, like a gentle doorbell.
            let p = [Partial(ratio: 1, level: 1, decay: 0.32), Partial(ratio: 2, level: 0.18, decay: 0.18)]
            return (0.95, [Note(at: 0, from: 783.99, to: 783.99, glide: 0, partials: p),
                           Note(at: 0.13, from: 1046.5, to: 1046.5, glide: 0, partials: p)])
        case .bell:
            // One small bell, A5, with a bell's uneven overtones.
            return (1.5, [Note(at: 0, from: 880, to: 880, glide: 0, partials: [
                Partial(ratio: 1, level: 1, decay: 0.55),
                Partial(ratio: 2.0, level: 0.28, decay: 0.35),
                Partial(ratio: 2.76, level: 0.14, decay: 0.22),
                Partial(ratio: 5.4, level: 0.05, decay: 0.1),
            ])])
        case .droplet:
            // A short round blip that falls in pitch, like a drop of water.
            return (0.45, [Note(at: 0, from: 1250, to: 720, glide: 0.07, partials: [
                Partial(ratio: 1, level: 1, decay: 0.11),
            ])])
        }
    }

    /// The ding as a 16-bit mono WAV file, peaking at half of full scale so it stays soft.
    public static func wav(_ ding: Ding) -> Data {
        let (length, notes) = notes(ding)
        let count = Int(length * Double(sampleRate))
        var samples = [Double](repeating: 0, count: count)
        let attack = 0.006
        for note in notes {
            let start = Int(note.at * Double(sampleRate))
            for partial in note.partials {
                var phase = 0.0
                for i in start..<count {
                    let t = Double(i - start) / Double(sampleRate)
                    let glide = note.glide > 0 ? min(t / note.glide, 1) : 1
                    let freq = (note.from + (note.to - note.from) * glide) * partial.ratio
                    phase += 2 * .pi * freq / Double(sampleRate)
                    let envelope = min(t / attack, 1) * exp(-t / partial.decay)
                    samples[i] += sin(phase) * partial.level * envelope
                }
            }
        }
        // A short fade at the very end, so it never stops with a click.
        let fade = Int(0.03 * Double(sampleRate))
        for i in max(0, count - fade)..<count { samples[i] *= Double(count - i) / Double(fade) }
        let peak = samples.map(abs).max() ?? 1
        let scale = peak > 0 ? 0.5 / peak : 0
        var pcm = Data(capacity: count * 2)
        for s in samples {
            var v = Int16(max(-1, min(1, s * scale)) * Double(Int16.max)).littleEndian
            withUnsafeBytes(of: &v) { pcm.append(contentsOf: $0) }
        }
        return header(dataBytes: pcm.count) + pcm
    }

    private static func header(dataBytes: Int) -> Data {
        var d = Data()
        func text(_ s: String) { d.append(contentsOf: Array(s.utf8)) }
        func u32(_ v: Int) { var x = UInt32(v).littleEndian; withUnsafeBytes(of: &x) { d.append(contentsOf: $0) } }
        func u16(_ v: Int) { var x = UInt16(v).littleEndian; withUnsafeBytes(of: &x) { d.append(contentsOf: $0) } }
        text("RIFF"); u32(36 + dataBytes); text("WAVE")
        text("fmt "); u32(16); u16(1); u16(1); u32(sampleRate); u32(sampleRate * 2); u16(2); u16(16)
        text("data"); u32(dataBytes)
        return d
    }
}
