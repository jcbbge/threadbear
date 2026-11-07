import SwiftUI

/// Settings › Dictation: Apple's or Whisper for the new-thread mic, and the
/// model's download.
struct DictationSettingsSection: View {
    @State private var engine = DictationEngine.chosen ?? .apple
    private var whisper: WhisperModel { .shared }

    var body: some View {
        Section {
            Picker("Dictate with", selection: $engine) {
                ForEach(DictationEngine.allCases, id: \.self) { Text($0.label).tag($0) }
            }
            .onChange(of: engine) {
                DictationEngine.chosen = engine
                if engine == .whisper { whisper.download() }
            }
            if engine == .whisper {
                NavigationLink("Words") { DictationWordsView() }
            }
            if engine == .whisper || whisper.installed {
                if let progress = whisper.progress {
                    ProgressView(value: progress) { Text("Downloading Whisper") }
                } else if whisper.installed {
                    Button("Delete Whisper (\(WhisperModel.sizeText))", role: .destructive) {
                        whisper.delete()
                        engine = .apple
                    }
                } else {
                    Button("Download Whisper (\(WhisperModel.sizeText))") { whisper.download() }
                }
                if let problem = whisper.problem {
                    Text(problem).font(.footnote).foregroundStyle(.secondary)
                }
            }
        } header: {
            Text("Dictation")
        } footer: {
            Text("Whisper's more accurate and runs on this phone. It types once you stop.")
        }
    }
}
