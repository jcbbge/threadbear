import Foundation
import os
import whisper

/// whisper.cpp on the GPU, with the decoding settings Voice Type on the Mac
/// uses (its WhisperEngine, which matched what its benchmark measured), less
/// the word list, which lives on the Mac and isn't in this public repo.
///
/// One serial queue owns the context. Loading takes a few seconds, so it
/// starts when the mic does and is done by the time the talking is.
nonisolated final class WhisperEngine: @unchecked Sendable {
    static let shared = WhisperEngine()

    private let queue = DispatchQueue(label: "threadbear.whisper", qos: .userInitiated)
    private var context: OpaquePointer?
    private let log = Logger(subsystem: "com.mikecann.threadbear", category: "whisper")

    /// Loads the model if it isn't already. Safe to call often.
    func warm() {
        queue.async { _ = self.loaded() }
    }

    /// The model is about 1.2 GB in memory, so it goes when the new-thread
    /// screen does.
    func unload() {
        queue.async {
            if let context = self.context { whisper_free(context) }
            self.context = nil
        }
    }

    /// 16 kHz mono samples in, text out ("" for nothing heard). `prompt` is
    /// the word list (DictationWords).
    func transcribe(_ samples: [Float], prompt: String? = nil) async throws -> String {
        try await withCheckedThrowingContinuation { continuation in
            queue.async {
                continuation.resume(with: Result { try self.run(samples, prompt: prompt) })
            }
        }
    }

    private func loaded() -> OpaquePointer? {
        if let context { return context }
        let path = WhisperModel.fileURL.path
        guard FileManager.default.fileExists(atPath: path) else { return nil }
        whisper_log_set({ _, _, _ in }, nil)
        let started = Date()
        var params = whisper_context_default_params()
        // The simulator's Metal can't map a buffer this big (an XPC trap in
        // MTLSimDriver), so it runs on the CPU there. Phones use the GPU.
        #if targetEnvironment(simulator)
        params.use_gpu = false
        #else
        params.use_gpu = true
        #endif
        params.flash_attn = true
        context = whisper_init_from_file_with_params(path, params)
        log.info("Whisper loaded: \(self.context != nil) in \(Int(Date().timeIntervalSince(started) * 1000)) ms")
        return context
    }

    private func run(_ samples: [Float], prompt: String?) throws -> String {
        // Under a third of a second, or near silence: nothing to hear, and
        // Whisper makes words up ("Thank you.") when given nothing.
        guard samples.count > 5_000, let peak = samples.lazy.map(abs).max(), peak > 0.01 else { return "" }
        guard let context = loaded() else { throw WhisperError.notLoaded }
        let started = Date()
        var p = whisper_full_default_params(WHISPER_SAMPLING_GREEDY)
        // The A17 Pro's two fast cores; the GPU does the heavy part.
        p.n_threads = 2
        p.no_context = true
        p.no_timestamps = false
        p.single_segment = false
        p.print_special = false
        p.print_progress = false
        p.print_realtime = false
        p.print_timestamps = false
        p.suppress_blank = true
        p.suppress_nst = true
        p.temperature = 0
        p.temperature_inc = 0.2
        p.max_initial_ts = 1.0
        p.entropy_thold = 2.4
        p.logprob_thold = -1.0
        p.no_speech_thold = 0.6
        p.detect_language = false
        // Every 30 s window gets the word list, not just the first.
        p.carry_initial_prompt = true
        let tokens = promptTokens(prompt, context: context)
        let rc: Int32 = "en".withCString { language in
            p.language = language
            return tokens.withUnsafeBufferPointer { prompt in
                p.prompt_tokens = prompt.isEmpty ? nil : prompt.baseAddress
                p.prompt_n_tokens = Int32(prompt.count)
                return samples.withUnsafeBufferPointer { whisper_full(context, p, $0.baseAddress, Int32($0.count)) }
            }
        }
        guard rc == 0 else { throw WhisperError.failed(rc) }
        var text = ""
        for i in 0..<whisper_full_n_segments(context) {
            text += String(cString: whisper_full_get_segment_text(context, i))
        }
        log.info("Whisper: \(samples.count / 16) ms of audio in \(Int(Date().timeIntervalSince(started) * 1000)) ms")
        return text.trimmingCharacters(in: .whitespacesAndNewlines)
    }
}

nonisolated extension WhisperEngine {
    /// With a leading space, as mlx-whisper encoded the prompts Voice Type's
    /// benchmark measured (VocabularyPrompt.tokenizerInput there).
    fileprivate func promptTokens(_ prompt: String?, context: OpaquePointer) -> [whisper_token] {
        guard let prompt else { return [] }
        let text = " " + prompt.trimmingCharacters(in: .whitespaces)
        var tokens = [whisper_token](repeating: 0, count: 512)
        let n = whisper_tokenize(context, text, &tokens, Int32(tokens.count))
        return n > 0 ? Array(tokens.prefix(Int(n))) : []
    }
}

enum WhisperError: LocalizedError {
    case notLoaded
    case failed(Int32)

    var errorDescription: String? {
        switch self {
        case .notLoaded: "Whisper couldn't load. Try Apple's dictation in Settings."
        case let .failed(rc): "Whisper stopped part way (\(rc))."
        }
    }
}

#if DEBUG
import AVFoundation

nonisolated extension WhisperEngine {
    /// `-WhisperTestWAV <path>`: transcribes a recording at launch and prints
    /// it, to check Whisper in the simulator, which has no useful mic.
    static func testFromLaunchArguments() {
        guard let path = UserDefaults.standard.string(forKey: "WhisperTestWAV") else { return }
        Task.detached {
            do {
                let file = try AVAudioFile(forReading: URL(fileURLWithPath: path))
                let target = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: 16_000, channels: 1, interleaved: false)!
                let input = AVAudioPCMBuffer(pcmFormat: file.processingFormat, frameCapacity: AVAudioFrameCount(file.length))!
                try file.read(into: input)
                let out = AVAudioPCMBuffer(pcmFormat: target, frameCapacity: AVAudioFrameCount(Double(file.length) * 16_000 / file.processingFormat.sampleRate) + 32)!
                var given = false
                _ = AVAudioConverter(from: file.processingFormat, to: target)!.convert(to: out, error: nil) { _, status in
                    if given { status.pointee = .endOfStream; return nil }
                    given = true
                    status.pointee = .haveData
                    return input
                }
                let samples = Array(UnsafeBufferPointer(start: out.floatChannelData![0], count: Int(out.frameLength)))
                let started = Date()
                let prompt = await DictationWords.shared.prompt
                let text = try await shared.transcribe(samples, prompt: prompt)
                FileHandle.standardError.write(Data("WHISPER-TEST (\(Int(Date().timeIntervalSince(started) * 1000)) ms incl. load): \(text)\n".utf8))
            } catch {
                FileHandle.standardError.write(Data("WHISPER-TEST failed: \(error)\n".utf8))
            }
        }
    }
}
#endif
