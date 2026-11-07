import AVFoundation
import CoreAudio
import Speech
import ThreadbearCore

/// The microphone and the speaker for Voice mode, on one audio engine with
/// the Mac's voice processing on, so its echo cancellation keeps the agent
/// from hearing itself and Mike can talk over it. What he says goes to
/// Apple's on-device speech recognition (SpeechAnalyzer); what the agent
/// says comes from pocket-tts as 24 kHz 16-bit WAV, a sentence at a time.
@MainActor
final class VoiceAudio {
    private var engine = AVAudioEngine()
    private var player = AVAudioPlayerNode()
    private var pitch = AVAudioUnitTimePitch()
    /// The Mac's echo cancellation is on. Some microphone and speaker
    /// pairs refuse it (Core Audio's -10875); then Voice runs without it
    /// and doesn't listen while it speaks, so it can't hear itself.
    private(set) var echoCancels = false
    private let speechFormat = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: 24_000, channels: 1, interleaved: false)!

    private var analyzer: SpeechAnalyzer?
    private var inputContinuation: AsyncStream<AnalyzerInput>.Continuation?
    private var resultsTask: Task<Void, Never>?
    private var speakTask: Task<Void, Never>?
    private var queued = 0
    private var speakId: UUID?
    /// Goes up each time he talks over it or Voice stops: what was fetched or
    /// queued for an earlier round is dropped, however it was chained.
    private var speakRound = 0

    /// A result from the recogniser (text, audio seconds, final or not).
    var onResult: ((UtteranceTracker.Result) -> Void)?
    /// How loud he is (0...1), for the button and the avatar.
    var onInputLevel: ((Float) -> Void)?
    /// How loud the agent is (0...1) while it speaks.
    var onOutputLevel: ((Float) -> Void)?
    /// Speaking started (true) or everything queued has been said (false).
    var onSpeaking: ((Bool) -> Void)?

    private(set) var isSpeaking = false
    private let audioClock = AudioClock()

    /// The clock time (CACurrentMediaTime's) that a time in the audio stream
    /// was captured: the recogniser counts from the first buffer it was fed.
    /// Nil before there's been one.
    func hostTime(ofAudio seconds: Double) -> Double? {
        audioClock.start.map { $0 + seconds }
    }

    // MARK: Listening

    func start(locale: Locale, microphone: AudioDeviceID?) async throws {
        try await Self.askForAccess()
        guard let supported = await SpeechTranscriber.supportedLocale(equivalentTo: locale) else {
            throw VoiceError("Speech recognition doesn't support \(locale.identifier) on this Mac.")
        }
        let transcriber = SpeechTranscriber(locale: supported, transcriptionOptions: [], reportingOptions: [.volatileResults], attributeOptions: [.audioTimeRange])
        if let request = try await AssetInventory.assetInstallationRequest(supporting: [transcriber]) {
            try await request.downloadAndInstall()
        }
        let analyzer = SpeechAnalyzer(modules: [transcriber])
        self.analyzer = analyzer
        guard let analyzerFormat = await SpeechAnalyzer.bestAvailableAudioFormat(compatibleWith: [transcriber]) else {
            throw VoiceError("Speech recognition has no audio format to use.")
        }
        let (stream, continuation) = AsyncStream<AnalyzerInput>.makeStream()
        inputContinuation = continuation

        resultsTask = Task { [weak self] in
            do {
                for try await result in transcriber.results {
                    let text = String(result.text.characters)
                    let range = result.range
                    // Its first word's time if it says: a result's range can
                    // begin with the silence before him.
                    let firstWord = result.text.runs.compactMap { $0.audioTimeRange }.first?.start.seconds
                    let r = UtteranceTracker.Result(text: text, start: (firstWord ?? range.start.seconds).finite, end: range.end.seconds.finite, isFinal: result.isFinal)
                    self?.onResult?(r)
                }
            } catch {
                VoiceLog.write("recogniser stopped: \(Self.describe(error))")
            }
        }
        try await analyzer.start(inputSequence: stream)

        do {
            try startEngine(voiceProcessing: true, microphone: microphone, analyzerFormat: analyzerFormat, feed: continuation)
            echoCancels = true
        } catch {
            VoiceLog.write("echo cancellation wouldn't start (\(Self.describe(error))); trying without it")
            resetEngine()
            do {
                try startEngine(voiceProcessing: false, microphone: microphone, analyzerFormat: analyzerFormat, feed: continuation)
            } catch {
                VoiceLog.write("the microphone wouldn't start: \(Self.describe(error))")
                resetEngine()
                throw VoiceError("The microphone wouldn't start (Core Audio error \((error as NSError).code)). Try another microphone in Settings > Voice.")
            }
            echoCancels = false
        }
        VoiceLog.write("listening on \(Self.describeInput(engine)), echo cancellation \(echoCancels ? "on" : "off")\(Self.outputIsHeadphones() ? ", headphones" : "")")
    }

    /// A fresh engine: one that failed to start keeps its broken state.
    private func resetEngine() {
        engine.inputNode.removeTap(onBus: 0)
        engine.stop()
        engine = AVAudioEngine()
        player = AVAudioPlayerNode()
        pitch = AVAudioUnitTimePitch()
    }

    private func startEngine(voiceProcessing: Bool, microphone: AudioDeviceID?, analyzerFormat: AVAudioFormat, feed: AsyncStream<AnalyzerInput>.Continuation) throws {
        // Voice processing first, before anything asks the engine for a format.
        if voiceProcessing {
            try engine.inputNode.setVoiceProcessingEnabled(true)
            // Its ducking of other audio is for calls; a reply shouldn't hush music any more than it must.
            engine.inputNode.voiceProcessingOtherAudioDuckingConfiguration = .init(enableAdvancedDucking: false, duckingLevel: .min)
        }
        if let microphone { Self.use(microphone, on: engine.inputNode) }

        engine.attach(player)
        engine.attach(pitch)
        engine.connect(player, to: pitch, format: speechFormat)
        engine.connect(pitch, to: engine.mainMixerNode, format: speechFormat)

        // No format for the tap: whatever the microphone gives (voice
        // processing's can differ from what the node reports beforehand).
        // The converter is made from the first buffer, on the audio thread.
        let converter = ConverterBox(to: analyzerFormat)
        let gate = LevelGate()
        let clock = audioClock
        engine.inputNode.installTap(onBus: 0, bufferSize: 2048, format: nil) { [weak self] buffer, when in
            clock.begin(at: when)
            if let converted = converter.convert(buffer) {
                feed.yield(AnalyzerInput(buffer: converted))
            }
            // Not each buffer (about 23 a second): the bars only need a few,
            // and each one is a hop to the main thread.
            guard let level = gate.take(Self.level(buffer)) else { return }
            Task { @MainActor in self?.onInputLevel?(level) }
        }
        engine.prepare()
        try engine.start()
        player.play()
    }

    /// Sound goes to headphones (Bluetooth, or the headphone jack), so
    /// the microphone doesn't hear the agent even without echo cancellation.
    static func outputIsHeadphones() -> Bool {
        var address = AudioObjectPropertyAddress(mSelector: kAudioHardwarePropertyDefaultOutputDevice, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
        var device = AudioDeviceID(0)
        var size = UInt32(MemoryLayout<AudioDeviceID>.size)
        guard AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &address, 0, nil, &size, &device) == noErr else { return false }
        var transport: UInt32 = 0
        size = UInt32(MemoryLayout<UInt32>.size)
        address.mSelector = kAudioDevicePropertyTransportType
        if AudioObjectGetPropertyData(device, &address, 0, nil, &size, &transport) == noErr,
           transport == kAudioDeviceTransportTypeBluetooth || transport == kAudioDeviceTransportTypeBluetoothLE {
            // With a microphone of its own: a Bluetooth speaker's sound is in
            // the room for this Mac's microphone to hear.
            var input = AudioObjectPropertyAddress(mSelector: kAudioDevicePropertyStreams, mScope: kAudioDevicePropertyScopeInput, mElement: kAudioObjectPropertyElementMain)
            var inputSize: UInt32 = 0
            return AudioObjectGetPropertyDataSize(device, &input, 0, nil, &inputSize) == noErr && inputSize > 0
        }
        var source: UInt32 = 0
        address = AudioObjectPropertyAddress(mSelector: kAudioDevicePropertyDataSource, mScope: kAudioDevicePropertyScopeOutput, mElement: kAudioObjectPropertyElementMain)
        size = UInt32(MemoryLayout<UInt32>.size)
        if AudioObjectGetPropertyData(device, &address, 0, nil, &size, &source) == noErr, source == 0x6864_706E /* 'hdpn' */ {
            return true
        }
        return false
    }

    static func describe(_ error: Error) -> String {
        let e = error as NSError
        return "\(e.domain) \(e.code)"
    }

    static func describeInput(_ engine: AVAudioEngine) -> String {
        let f = engine.inputNode.outputFormat(forBus: 0)
        return "\(Int(f.sampleRate)) Hz, \(f.channelCount) ch"
    }

    func stop() {
        stopSpeaking()
        engine.inputNode.removeTap(onBus: 0)
        engine.stop()
        inputContinuation?.finish()
        inputContinuation = nil
        resultsTask?.cancel()
        resultsTask = nil
        let analyzer = analyzer
        self.analyzer = nil
        Task { await analyzer?.cancelAndFinishNow() }
    }

    // MARK: Speaking

    /// Says the sentences in order, in `voice` at `speed`, from the server at
    /// `base`. `played` runs once the last of them has come out of the
    /// speakers, and never if any was cut off (he talked over it, it failed).
    func speak(_ sentences: [String], voice: String, speed: Double, base: URL, played: (() -> Void)? = nil) {
        guard !sentences.isEmpty else { return }
        pitch.rate = Float(speed)
        let previous = speakTask
        let id = UUID()
        let round = speakRound
        speakId = id
        speakTask = Task { [weak self] in
            await previous?.value
            var whole = true
            for sentence in sentences {
                guard let self, !Task.isCancelled, self.speakRound == round else { return }
                do {
                    let samples = try await self.stream(sentence, voice: voice, base: base, round: round)
                    // A 200 with little or no sound in it isn't that sentence
                    // said, and "played" mustn't say it was.
                    if samples < Self.fewestSamples(for: sentence) { whole = false }
                } catch {
                    if !Task.isCancelled { VoiceLog.write("couldn't speak: \(error.localizedDescription)") }
                    whole = false
                    break
                }
            }
            guard let self else { return }
            if whole, let played, !Task.isCancelled, self.speakRound == round { self.markPlayed(round: round, played) }
            // Everything's been fetched; once it's played, it's said.
            guard self.speakId == id else { return }
            self.speakTask = nil
            if self.queued == 0 { self.setSpeaking(false) }
        }
    }

    /// Stops talking now: he's started speaking, or Voice was turned off.
    func stopSpeaking() {
        speakRound += 1
        speakTask?.cancel()
        speakTask = nil
        player.stop()
        if engine.isRunning { player.play() }
        queued = 0
        setSpeaking(false)
    }

    /// Far fewer than any voice takes over it (40 ms a letter, when speech
    /// is around 70), to catch a reply that came back with little in it. It
    /// can't prove every word was said; that's trusting pocket-tts.
    static func fewestSamples(for sentence: String) -> Int {
        sentence.count * 960
    }

    /// Plays it as it arrives. The samples scheduled.
    @discardableResult
    private func stream(_ text: String, voice: String, base: URL, round: Int) async throws -> Int {
        var request = URLRequest(url: base.appendingPathComponent("tts"))
        request.httpMethod = "POST"
        let boundary = "tb-\(UUID().uuidString)"
        request.setValue("multipart/form-data; boundary=\(boundary)", forHTTPHeaderField: "Content-Type")
        request.httpBody = Self.form(["text": text, "voice_url": voice], boundary: boundary)
        var samples = 0
        for try await piece in Self.speech(request) {
            try Task.checkCancellation()
            guard speakRound == round else { return samples }
            schedule(piece, round: round)
            samples += piece.samples.count
        }
        return samples
    }

    /// A stretch of speech, ready to play.
    struct SpeechPiece: Sendable {
        let samples: [Float]
        let peak: Float
    }

    /// The reply as it arrives, read and decoded off the main thread, which
    /// only gets a finished piece about ten times a second. It used to step
    /// through the stream byte by byte on the main actor (review, 7 Nov).
    /// Ending the stream, by cancelling whoever reads it, cancels the read.
    private nonisolated static func speech(_ request: URLRequest) -> AsyncThrowingStream<SpeechPiece, Error> {
        AsyncThrowingStream { continuation in
            let task = Task.detached(priority: .userInitiated) {
                do {
                    let (bytes, response) = try await URLSession.shared.bytes(for: request)
                    let status = (response as? HTTPURLResponse)?.statusCode ?? 0
                    guard status == 200 else { throw VoiceError("the voice engine said \(status)") }
                    var wav = WAVStream()
                    var chunk = Data()
                    chunk.reserveCapacity(4800)
                    for try await byte in bytes {
                        try Task.checkCancellation()
                        chunk.append(byte)
                        // About a tenth of a second at a time.
                        if chunk.count >= 4800 {
                            continuation.yield(Self.piece(wav.samples(from: chunk)))
                            chunk.removeAll(keepingCapacity: true)
                        }
                    }
                    if !chunk.isEmpty { continuation.yield(Self.piece(wav.samples(from: chunk))) }
                    continuation.finish()
                } catch {
                    continuation.finish(throwing: error)
                }
            }
            continuation.onTermination = { _ in task.cancel() }
        }
    }

    private nonisolated static func piece(_ samples: [Int16]) -> SpeechPiece {
        var peak: Float = 0
        let floats = samples.map { sample -> Float in
            let value = Float(sample) / 32768
            peak = max(peak, abs(value))
            return value
        }
        return SpeechPiece(samples: floats, peak: peak)
    }

    private func schedule(_ piece: SpeechPiece, round: Int) {
        let count = piece.samples.count
        guard count > 0, let buffer = AVAudioPCMBuffer(pcmFormat: speechFormat, frameCapacity: AVAudioFrameCount(count)) else { return }
        buffer.frameLength = AVAudioFrameCount(count)
        piece.samples.withUnsafeBufferPointer { buffer.floatChannelData![0].update(from: $0.baseAddress!, count: count) }
        let level = min(1, piece.peak * 1.4)
        queued += 1
        setSpeaking(true)
        onOutputLevel?(level)
        // Played back, not just taken: the app isn't done talking, and his
        // words can't be an answer, while it's still coming out of a speaker.
        player.scheduleBuffer(buffer, completionCallbackType: .dataPlayedBack) { [weak self] _ in
            Task { @MainActor in
                // A buffer from before he talked over it: the count started again.
                guard let self, self.speakRound == round else { return }
                self.queued = max(0, self.queued - 1)
                self.onOutputLevel?(self.queued == 0 ? 0 : level)
                if self.queued == 0, self.speakTask == nil { self.setSpeaking(false) }
            }
        }
        if !player.isPlaying { player.play() }
    }

    /// `played` once all that's queued now has really been heard: a moment of
    /// silence after it, with AVAudioPlayerNode's played-back callback (the
    /// plain one fires when a buffer is taken, ahead of the speakers). Stopping
    /// the player fires it too, which the round check turns away.
    private func markPlayed(round: Int, _ played: @escaping () -> Void) {
        guard let silence = AVAudioPCMBuffer(pcmFormat: speechFormat, frameCapacity: 240) else { return }
        silence.frameLength = 240
        silence.floatChannelData![0].update(repeating: 0, count: 240)
        player.scheduleBuffer(silence, completionCallbackType: .dataPlayedBack) { [weak self] _ in
            Task { @MainActor in
                guard let self, self.speakRound == round else { return }
                played()
            }
        }
    }

    private func setSpeaking(_ on: Bool) {
        guard isSpeaking != on else { return }
        isSpeaking = on
        onSpeaking?(on)
    }

    /// Plays a short sample in the given voice (Settings' Try button).
    func preview(_ text: String, voice: String, speed: Double, base: URL) throws {
        if !engine.isRunning {
            engine.attach(player)
            engine.attach(pitch)
            engine.connect(player, to: pitch, format: speechFormat)
            engine.connect(pitch, to: engine.mainMixerNode, format: speechFormat)
            try engine.start()
            player.play()
        }
        stopSpeaking()
        speak([text], voice: voice, speed: speed, base: base)
    }

    // MARK: Helpers

    static func form(_ fields: [String: String], boundary: String) -> Data {
        var body = Data()
        for (name, value) in fields.sorted(by: { $0.key < $1.key }) {
            body.append(Data("--\(boundary)\r\nContent-Disposition: form-data; name=\"\(name)\"\r\n\r\n\(value)\r\n".utf8))
        }
        body.append(Data("--\(boundary)--\r\n".utf8))
        return body
    }

    nonisolated static func level(_ buffer: AVAudioPCMBuffer) -> Float {
        guard let data = buffer.floatChannelData?[0], buffer.frameLength > 0 else { return 0 }
        var sum: Float = 0
        for i in 0..<Int(buffer.frameLength) { sum += data[i] * data[i] }
        let rms = (sum / Float(buffer.frameLength)).squareRoot()
        return min(1, rms * 12)
    }

    static func askForAccess() async throws {
        switch AVCaptureDevice.authorizationStatus(for: .audio) {
        case .authorized: break
        case .notDetermined:
            guard await AVCaptureDevice.requestAccess(for: .audio) else { throw VoiceError("Threadbear isn't allowed to use the microphone.") }
        default:
            throw VoiceError("Threadbear isn't allowed to use the microphone. Turn it on in System Settings > Privacy & Security > Microphone.")
        }
    }

    // MARK: Microphones

    struct Microphone: Identifiable, Hashable {
        let id: AudioDeviceID
        let uid: String
        let name: String
    }

    /// Every input device, by name.
    static func microphones() -> [Microphone] {
        var address = AudioObjectPropertyAddress(mSelector: kAudioHardwarePropertyDevices, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
        var size: UInt32 = 0
        guard AudioObjectGetPropertyDataSize(AudioObjectID(kAudioObjectSystemObject), &address, 0, nil, &size) == noErr else { return [] }
        var ids = [AudioDeviceID](repeating: 0, count: Int(size) / MemoryLayout<AudioDeviceID>.size)
        guard AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &address, 0, nil, &size, &ids) == noErr else { return [] }
        return ids.compactMap { id in
            var streams = AudioObjectPropertyAddress(mSelector: kAudioDevicePropertyStreams, mScope: kAudioDevicePropertyScopeInput, mElement: kAudioObjectPropertyElementMain)
            var streamSize: UInt32 = 0
            guard AudioObjectGetPropertyDataSize(id, &streams, 0, nil, &streamSize) == noErr, streamSize > 0 else { return nil }
            guard let name = string(id, kAudioObjectPropertyName), let uid = string(id, kAudioDevicePropertyDeviceUID) else { return nil }
            return Microphone(id: id, uid: uid, name: name)
        }
    }

    static func microphone(uid: String?) -> AudioDeviceID? {
        guard let uid, !uid.isEmpty else { return nil }
        return microphones().first { $0.uid == uid }?.id
    }

    private static func string(_ id: AudioObjectID, _ selector: AudioObjectPropertySelector) -> String? {
        var address = AudioObjectPropertyAddress(mSelector: selector, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
        var value: Unmanaged<CFString>?
        var size = UInt32(MemoryLayout<Unmanaged<CFString>?>.size)
        guard AudioObjectGetPropertyData(id, &address, 0, nil, &size, &value) == noErr, let value else { return nil }
        return value.takeRetainedValue() as String
    }

    private static func use(_ device: AudioDeviceID, on input: AVAudioInputNode) {
        guard let unit = input.audioUnit else { return }
        var device = device
        let status = AudioUnitSetProperty(unit, kAudioOutputUnitProperty_CurrentDevice, kAudioUnitScope_Global, 0, &device, UInt32(MemoryLayout<AudioDeviceID>.size))
        if status != noErr { VoiceLog.write("couldn't pick that microphone (\(status)); using the default") }
    }
}

/// When the microphone's first buffer was captured, from the audio thread,
/// read on the main one. Only ever the first: a later one's time would make
/// everything heard look more recent than it was. A first with no time leaves
/// it unknown, and an unknown time can't answer a card.
final class AudioClock: @unchecked Sendable {
    private let lock = NSLock()
    private var began = false
    private var first: Double?

    func begin(at when: AVAudioTime) {
        lock.lock()
        defer { lock.unlock() }
        guard !began else { return }
        began = true
        if when.isHostTimeValid { first = AVAudioTime.seconds(forHostTime: when.hostTime) }
    }

    var start: Double? {
        lock.lock()
        defer { lock.unlock() }
        return first
    }
}

/// Lets a level through about twelve times a second, the loudest since the
/// last. Only the audio thread uses it.
final class LevelGate: @unchecked Sendable {
    private var last: CFTimeInterval = 0
    private var loudest: Float = 0

    func take(_ level: Float) -> Float? {
        loudest = max(loudest, level)
        let now = CACurrentMediaTime()
        guard now - last >= 0.08 else { return nil }
        defer { last = now; loudest = 0 }
        return loudest
    }
}

/// Makes the converter from the microphone's first buffer and converts
/// each one to what speech recognition wants. Only the audio thread uses it.
final class ConverterBox: @unchecked Sendable {
    private let format: AVAudioFormat
    private var converter: AVAudioConverter?
    private var failed = false

    init(to format: AVAudioFormat) { self.format = format }

    func convert(_ buffer: AVAudioPCMBuffer) -> AVAudioPCMBuffer? {
        if converter == nil, !failed {
            converter = AVAudioConverter(from: buffer.format, to: format)
            // More channels than one (voice processing can give several): the first.
            if buffer.format.channelCount > format.channelCount { converter?.channelMap = [0] }
            if converter == nil {
                failed = true
                VoiceLog.write("can't convert \(buffer.format) for speech recognition")
            }
        }
        guard let converter else { return nil }
        let ratio = format.sampleRate / buffer.format.sampleRate
        let capacity = AVAudioFrameCount(Double(buffer.frameLength) * ratio + 16)
        guard let out = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: capacity) else { return nil }
        var fed = false
        var error: NSError?
        converter.convert(to: out, error: &error) { _, status in
            if fed { status.pointee = .noDataNow; return nil }
            fed = true
            status.pointee = .haveData
            return buffer
        }
        return error == nil && out.frameLength > 0 ? out : nil
    }
}

/// Voice's own log, ~/Library/Logs/Threadbear/voice.log, so what went
/// wrong can be read afterwards. Kept under 256 KB. Never what was said.
enum VoiceLog {
    static let url = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/Logs/Threadbear/voice.log")
    private static let queue = DispatchQueue(label: "voice-log")

    static func write(_ line: String) {
        AppLog.write("voice", line)
        let stamp = ISO8601DateFormatter().string(from: Date())
        queue.async {
            let fm = FileManager.default
            try? fm.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
            if let size = (try? fm.attributesOfItem(atPath: url.path))?[.size] as? Int, size > 256_000 { try? fm.removeItem(at: url) }
            if !fm.fileExists(atPath: url.path) { fm.createFile(atPath: url.path, contents: nil) }
            guard let handle = try? FileHandle(forWritingTo: url) else { return }
            handle.seekToEndOfFile()
            handle.write(Data("\(stamp) \(line)\n".utf8))
            try? handle.close()
        }
    }
}

struct VoiceError: LocalizedError {
    let message: String
    init(_ message: String) { self.message = message }
    var errorDescription: String? { message }
}

private extension Double {
    var finite: Double { isFinite ? self : 0 }
}

/// 16-bit PCM out of a WAV that arrives in pieces: skips the header (its
/// chunks, up to "data"), then hands back whole samples, keeping an odd
/// byte for the next piece.
struct WAVStream {
    private var header = Data()
    private var inData = false
    private var carry: UInt8?

    mutating func samples(from piece: Data) -> [Int16] {
        var bytes = piece
        if !inData {
            header.append(bytes)
            guard let start = Self.dataStart(header) else { return [] }
            inData = true
            bytes = header.subdata(in: start..<header.count)
            header = Data()
        }
        var all = [UInt8]()
        all.reserveCapacity(bytes.count + 1)
        if let carry { all.append(carry) }
        all.append(contentsOf: bytes)
        carry = all.count % 2 == 1 ? all.removeLast() : nil
        var out = [Int16](repeating: 0, count: all.count / 2)
        for i in 0..<out.count { out[i] = Int16(bitPattern: UInt16(all[2 * i]) | UInt16(all[2 * i + 1]) << 8) }
        return out
    }

    /// Where the samples start: after "data" and its size.
    static func dataStart(_ header: Data) -> Int? {
        let b = [UInt8](header)
        guard b.count >= 12 else { return nil }
        var i = 12
        while i + 8 <= b.count {
            let id = String(bytes: b[i..<i + 4], encoding: .ascii)
            let size = Int(b[i + 4]) | Int(b[i + 5]) << 8 | Int(b[i + 6]) << 16 | Int(b[i + 7]) << 24
            if id == "data" { return i + 8 }
            i += 8 + size
        }
        return nil
    }
}
