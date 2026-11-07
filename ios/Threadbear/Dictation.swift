import AVFoundation
import Observation
import Speech
import os

/// Tap the mic, talk, and the words land in the new thread's text box.
/// On-device SFSpeechRecognizer where the phone has the model, Apple's
/// servers if it won't start, as Quick Ask does (ClassicTranscriber). It
/// never sends on its own: a new thread is worth a glance before it goes.
///
/// Or Whisper (WhisperEngine), when chosen and downloaded: it records while
/// listening and types it all out when the mic's tapped again, as Voice Type
/// does on the Mac, since it can't stream. Apple's fills in until the model's
/// downloaded.
///
/// Dropped on 31 Oct because what had been said got wiped, and back on
/// 3 Nov for new threads only (Mike wanted the button). The wipe was the
/// recognizer starting its transcript over after a pause, so `Carry` keeps
/// what came before a restart rather than trusting the latest result alone.
@MainActor @Observable
final class Dictation {
    private(set) var isListening = false
    /// Whisper working on what was said, after the mic's tapped off.
    private(set) var isTranscribing = false
    /// When the mic started, for the elapsed time on the button.
    private(set) var startedAt: Date?
    /// How loud the mic is, for the waveform on the button, so it's clear
    /// it's hearing (Mike, 6 Nov). Read by the view on a timer, not observed.
    let level = MicLevel()
    private(set) var problem: String?

    private let log = Logger(subsystem: "com.mikecann.threadbear", category: "speech")
    private let recognizer = SFSpeechRecognizer(locale: Locale.current.language.languageCode?.identifier == "en" ? .current : Locale(identifier: "en-GB"))
    private let engine = AVAudioEngine()
    private var request: SFSpeechAudioBufferRecognitionRequest?
    private var task: SFSpeechRecognitionTask?
    private var onDeviceBroken = false
    private var generation = 0
    /// Whether start has touched the audio session and mic, so stop has something to undo.
    private var holdsAudio = false
    private var carry = Carry()
    /// Set while Whisper's recording, with where its text goes.
    private var whisper: (sink: WhisperSink, onText: (String) -> Void)?

    /// Words said that aren't in the text box yet: Whisper recording or
    /// working. Sending now would leave them behind.
    var holdsWords: Bool { whisper != nil || isTranscribing }

    /// Whether this start goes to Whisper.
    private var usesWhisper: Bool { DictationEngine.chosen == .whisper && WhisperModel.shared.installed }

    /// `onText` gets the whole transcript so far, every time it changes.
    func start(onText: @escaping (String) -> Void) async {
        problem = nil
        let whisperNow = usesWhisper
        guard await Self.permission(speech: !whisperNow) else {
            problem = "Turn on the microphone and speech recognition for Threadbear in Settings."
            return
        }
        if whisperNow {
            await startWhisper(onText: onText)
            return
        }
        guard let recognizer, recognizer.isAvailable else {
            problem = "Speech recognition isn't available right now."
            return
        }
        stop()
        generation += 1
        let current = generation
        holdsAudio = true
        do {
            let session = AVAudioSession.sharedInstance()
            try session.setCategory(.record, mode: .measurement, options: .duckOthers)
            try session.setActive(true, options: .notifyOthersOnDeactivation)
            let request = SFSpeechAudioBufferRecognitionRequest()
            request.shouldReportPartialResults = true
            request.addsPunctuation = true
            request.taskHint = .dictation
            request.requiresOnDeviceRecognition = recognizer.supportsOnDeviceRecognition && !onDeviceBroken
            self.request = request
            let input = engine.inputNode
            input.removeTap(onBus: 0)
            // The tap runs on the audio queue. Written plainly inside this
            // @MainActor class the block would be main-actor isolated (the
            // project's default isolation), and iOS 18 trapped on the first
            // buffer: dispatch_assert_queue in Dictation.start. So it's
            // @Sendable and reaches the request through MicSink.
            let sink = MicSink(request)
            let level = level
            // MicTap refuses while the mic's format is still settling after
            // the category change, for a few tens of milliseconds: try again.
            var refusal: MicTap.Refusal?
            for attempt in 0..<20 {
                do {
                    try MicTap.install(on: input) { buffer, _ in
                        sink.append(buffer)
                        level.push(buffer)
                    }
                    refusal = nil
                    break
                } catch {
                    refusal = error
                    guard error == .formatChanging, attempt < 19 else { break }
                    try await Task.sleep(for: .milliseconds(50))
                    guard generation == current else { return }
                }
            }
            if let refusal {
                problem = refusal == .noMicrophone ? "There's no microphone available." : "Couldn't start the microphone. Tap the mic to try again."
                stop()
                return
            }
            engine.prepare()
            try engine.start()
            isListening = true
            level.reset()
            startedAt = .now
            carry = Carry()
            task = recognizer.recognitionTask(with: request) { [weak self] result, error in
                let text = result?.bestTranscription.formattedString
                let nsError = error as NSError?
                Task { @MainActor in
                    guard let self, self.generation == current else { return }
                    if let text { onText(self.carry.add(text)) }
                    guard let nsError, !Self.isBenign(nsError) else { return }
                    if request.requiresOnDeviceRecognition, nsError.domain == "kLSRErrorDomain", [100, 101, 102, 300].contains(nsError.code) {
                        self.log.error("On-device recognition wouldn't start (\(nsError.code)); using the server")
                        self.onDeviceBroken = true
                        self.stop()
                        await self.start(onText: onText)
                        return
                    }
                    self.log.error("Recognition error \(nsError.domain, privacy: .public) \(nsError.code)")
                    self.problem = "Speech recognition stopped. Tap the mic to try again."
                    self.stop()
                }
            }
        } catch {
            problem = "Couldn't start the microphone: \(error.localizedDescription)"
            stop()
        }
    }

    #if DEBUG
    /// Whisper working after the mic's off, for screenshots (-ThreadbearTypingOut).
    func fakeTypingOut() { isTranscribing = true }

    /// Looks 8 seconds into listening, for screenshots (-ThreadbearDictating).
    func fakeListening() {
        isListening = true
        startedAt = .now.addingTimeInterval(-8)
        level.fake()
    }
    #endif

    /// The mic tapped off: Whisper now types out what it heard. Apple's has
    /// typed as it went, so it just stops.
    func finish() {
        guard let whisper, isListening else { stop(); return }
        let samples = whisper.sink.samples()
        let onText = whisper.onText
        let prompt = DictationWords.shared.prompt
        stop()
        let current = generation
        isTranscribing = true
        Task {
            defer { if generation == current { isTranscribing = false } }
            do {
                let text = try await WhisperEngine.shared.transcribe(samples, prompt: prompt)
                // Closed or started again meanwhile: those words aren't wanted.
                guard generation == current else { return }
                if !text.isEmpty { onText(text) }
            } catch {
                guard generation == current else { return }
                log.error("Whisper: \(error.localizedDescription, privacy: .public)")
                problem = error.localizedDescription
            }
        }
    }

    /// The screen's gone: drops the model, about 1.2 GB.
    func close() {
        stop()
        isTranscribing = false
        WhisperEngine.shared.unload()
    }

    private func startWhisper(onText: @escaping (String) -> Void) async {
        stop()
        generation += 1
        let current = generation
        holdsAudio = true
        // Loads while the talking happens, so it's ready when it stops.
        WhisperEngine.shared.warm()
        do {
            let session = AVAudioSession.sharedInstance()
            try session.setCategory(.record, mode: .measurement, options: .duckOthers)
            try session.setActive(true, options: .notifyOthersOnDeactivation)
            let input = engine.inputNode
            input.removeTap(onBus: 0)
            let sink = WhisperSink(from: input.outputFormat(forBus: 0))
            let level = level
            var refusal: MicTap.Refusal?
            for attempt in 0..<20 {
                do {
                    try MicTap.install(on: input) { buffer, _ in
                        sink.append(buffer)
                        level.push(buffer)
                    }
                    refusal = nil
                    break
                } catch {
                    refusal = error
                    guard error == .formatChanging, attempt < 19 else { break }
                    try await Task.sleep(for: .milliseconds(50))
                    guard generation == current else { return }
                }
            }
            if let refusal {
                problem = refusal == .noMicrophone ? "There's no microphone available." : "Couldn't start the microphone. Tap the mic to try again."
                stop()
                return
            }
            engine.prepare()
            try engine.start()
            whisper = (sink, onText)
            isListening = true
            level.reset()
            startedAt = .now
        } catch {
            problem = "Couldn't start the microphone: \(error.localizedDescription)"
            stop()
        }
    }

    func stop() {
        generation += 1
        whisper = nil
        // Every send and every closed thread lands here, mic used or not. Going
        // on would make the engine's input node, which sets up the mic hardware,
        // and deactivate a session we never took, all while another app may be
        // playing: Mike's podcast paused for a moment on each send (31 Oct).
        guard holdsAudio else { return }
        holdsAudio = false
        if engine.isRunning { engine.stop() }
        engine.inputNode.removeTap(onBus: 0)
        request?.endAudio()
        task?.finish()
        request = nil
        task = nil
        isListening = false
        startedAt = nil
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    }

    /// "No speech detected" and cancellation aren't worth showing.
    private static func isBenign(_ error: NSError) -> Bool {
        error.domain == "kAFAssistantErrorDomain" && [203, 209, 216, 301, 1110].contains(error.code)
    }

    /// Whisper only needs the mic; Apple's needs speech recognition too.
    private static func permission(speech: Bool) async -> Bool {
        if AVAudioApplication.shared.recordPermission == .undetermined {
            _ = await AVAudioApplication.requestRecordPermission()
        }
        guard speech else { return AVAudioApplication.shared.recordPermission == .granted }
        if SFSpeechRecognizer.authorizationStatus() == .notDetermined {
            _ = await requestSpeech()
        }
        return AVAudioApplication.shared.recordPermission == .granted && SFSpeechRecognizer.authorizationStatus() == .authorized
    }

    nonisolated private static func requestSpeech() async -> SFSpeechRecognizerAuthorizationStatus {
        await withCheckedContinuation { continuation in
            SFSpeechRecognizer.requestAuthorization { continuation.resume(returning: $0) }
        }
    }
}

/// The transcript across the recognizer's restarts. Each result is meant to be
/// the whole transcript so far, but after a pause iOS can begin again from the
/// new words alone. When a result is shorter than the last and doesn't begin
/// the same way, the last is kept and the new words go after it.
nonisolated struct Carry {
    private var kept = ""
    private var last = ""

    mutating func add(_ text: String) -> String {
        if !last.isEmpty, text.count < last.count, Self.firstWord(text) != Self.firstWord(last) {
            kept = Self.join(kept, last)
        }
        last = text
        return Self.join(kept, text)
    }

    private static func firstWord(_ text: String) -> String {
        String(text.lowercased().split(whereSeparator: { !$0.isLetter && !$0.isNumber }).first ?? "")
    }

    private static func join(_ a: String, _ b: String) -> String {
        a.isEmpty ? b : b.isEmpty ? a : a + " " + b
    }
}

/// Carries the mic's buffers from the audio thread to the recognition request.
/// `append` on a request is thread-safe; the box exists so the tap block can
/// be @Sendable without capturing the (non-Sendable) request itself.
nonisolated private final class MicSink: @unchecked Sendable {
    private let request: SFSpeechAudioBufferRecognitionRequest
    init(_ request: SFSpeechAudioBufferRecognitionRequest) { self.request = request }
    func append(_ buffer: AVAudioPCMBuffer) { request.append(buffer) }
}

/// Whisper's recording: the mic's buffers, turned into the 16 kHz mono
/// floats it takes, on the audio thread, kept until the mic's tapped off.
/// Ten minutes at most (38 MB), past which it stops keeping more.
nonisolated private final class WhisperSink: @unchecked Sendable {
    private let lock = NSLock()
    private var kept: [Float] = []
    private let converter: AVAudioConverter?
    private let target = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: 16_000, channels: 1, interleaved: false)!
    private static let most = 16_000 * 600

    init(from format: AVAudioFormat) {
        converter = AVAudioConverter(from: format, to: target)
    }

    func append(_ buffer: AVAudioPCMBuffer) {
        guard let converter else { return }
        let capacity = AVAudioFrameCount(Double(buffer.frameLength) * 16_000 / buffer.format.sampleRate) + 32
        guard let out = AVAudioPCMBuffer(pcmFormat: target, frameCapacity: capacity) else { return }
        var given = false
        var error: NSError?
        converter.convert(to: out, error: &error) { _, status in
            if given { status.pointee = .noDataNow; return nil }
            given = true
            status.pointee = .haveData
            return buffer
        }
        guard error == nil, let channel = out.floatChannelData?[0] else { return }
        let frames = UnsafeBufferPointer(start: channel, count: Int(out.frameLength))
        lock.lock()
        if kept.count < Self.most { kept.append(contentsOf: frames) }
        lock.unlock()
    }

    func samples() -> [Float] {
        lock.lock()
        defer { lock.unlock() }
        return kept
    }
}

/// The mic's loudness over the last couple of seconds, written on the audio
/// thread and read by the waveform a few times a second.
nonisolated final class MicLevel: @unchecked Sendable {
    static let count = 24
    private let lock = NSLock()
    private var levels = [Float](repeating: 0, count: MicLevel.count)

    /// Each buffer's RMS, as 0 to 1 over -50 to -10 dB, so speech fills the
    /// bars and room noise barely moves them.
    func push(_ buffer: AVAudioPCMBuffer) {
        guard let channel = buffer.floatChannelData?[0], buffer.frameLength > 0 else { return }
        var sum: Float = 0
        for i in 0..<Int(buffer.frameLength) { sum += channel[i] * channel[i] }
        let db = 10 * log10(max(sum / Float(buffer.frameLength), 1e-10))
        let value = min(max((db + 50) / 40, 0), 1)
        lock.lock()
        levels.removeFirst()
        levels.append(value)
        lock.unlock()
    }

    #if DEBUG
    func fake() {
        lock.lock()
        levels = (0..<Self.count).map { Float(0.25 + 0.6 * abs(sin(Double($0) * 0.7))) }
        lock.unlock()
    }
    #endif

    func reset() {
        lock.lock()
        levels = [Float](repeating: 0, count: Self.count)
        lock.unlock()
    }

    var history: [Float] {
        lock.lock()
        defer { lock.unlock() }
        return levels
    }
}
