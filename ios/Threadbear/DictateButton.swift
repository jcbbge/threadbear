import SwiftUI

/// The mic, for the new thread sheet and a thread's reply box: tap, talk, tap
/// again, and the words go on the end of what's typed. The first tap asks
/// which engine. Whoever shows it owns the `Dictation`, so it can hold Send
/// while Whisper's still typing out and stop the mic when the box goes away.
struct DictateButton<Idle: View>: View {
    @Binding var text: String
    let dictation: Dictation
    /// Its colour when it isn't listening; the accent if nil.
    var idleTint: Color? = nil
    /// How the button looks when it isn't listening.
    @ViewBuilder var idle: () -> Idle
    @State private var askEngine = false
    private var whisperModel: WhisperModel { .shared }

    var body: some View {
        Group {
            if dictation.isTranscribing {
                ProgressView()
            } else {
                Button(action: toggle) {
                    if dictation.isListening {
                        ListeningLabel(dictation: dictation)
                    } else {
                        idle()
                    }
                }
                .tint(dictation.isListening ? .red : idleTint)
            }
        }
        .confirmationDialog("Dictate with", isPresented: $askEngine, titleVisibility: .visible) {
            Button("Whisper, \(WhisperModel.sizeText) download") { choose(.whisper) }
            Button("Apple's dictation") { choose(.apple) }
        } message: {
            Text("Whisper's more accurate and runs on this phone. Change it in Settings.")
        }
    }

    private func toggle() {
        if dictation.isListening { dictation.finish(); return }
        guard let engine = DictationEngine.chosen else { askEngine = true; return }
        // A download stopped by the app being swiped away picks up again.
        if engine == .whisper, !whisperModel.installed, whisperModel.progress == nil { whisperModel.download() }
        listen()
    }

    private func choose(_ engine: DictationEngine) {
        DictationEngine.chosen = engine
        if engine == .whisper { whisperModel.download() }
        listen()
    }

    /// Adds to what's typed, after a space.
    private func listen() {
        let before = text.isEmpty || text.hasSuffix(" ") || text.hasSuffix("\n") ? text : text + " "
        Task { await dictation.start { text = before + $0 } }
    }
}

/// Why the mic won't start, and Whisper's download, under the mic's box.
struct DictationNotes: View {
    let dictation: Dictation
    private var whisperModel: WhisperModel { .shared }

    var body: some View {
        if let problem = dictation.problem {
            Text(problem).font(.footnote).foregroundStyle(.secondary)
        }
        if DictationEngine.chosen == .whisper, let progress = whisperModel.progress {
            ProgressView(value: progress) {
                Text("Downloading Whisper. Apple's dictation until then.").font(.footnote).foregroundStyle(.secondary)
            }
        }
    }
}

/// The mic button while it's listening: the waveform, the time so far and a
/// small stop square, so it's plain the phone's hearing.
struct ListeningLabel: View {
    let dictation: Dictation

    var body: some View {
        TimelineView(.periodic(from: .now, by: 1.0 / 15)) { context in
            HStack(spacing: 8) {
                HStack(alignment: .center, spacing: 2) {
                    ForEach(Array(dictation.level.history.enumerated()), id: \.offset) { _, value in
                        Capsule().frame(width: 2, height: 3 + CGFloat(value) * 15)
                    }
                }
                .frame(height: 18)
                .animation(.linear(duration: 1.0 / 15), value: dictation.level.history)
                Text(elapsed(at: context.date)).monospacedDigit()
                Image(systemName: "stop.fill").imageScale(.small)
            }
        }
        .accessibilityLabel("Stop dictating")
    }

    private func elapsed(at now: Date) -> String {
        let seconds = Int(now.timeIntervalSince(dictation.startedAt ?? now))
        return String(format: "%d:%02d", seconds / 60, seconds % 60)
    }
}
