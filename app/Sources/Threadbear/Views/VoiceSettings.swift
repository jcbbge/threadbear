import SwiftUI
import ThreadbearCore

/// Settings > Voice: this Mac's own choices for Voice mode (VoiceMode),
/// kept in UserDefaults rather than the runner, as the microphone and the
/// speaker are this Mac's.
struct VoiceSettings: View {
    @AppStorage(VoiceCatalog.voiceKey) private var voiceId = VoiceCatalog.defaultVoice.id
    @AppStorage(VoiceCatalog.speedKey) private var speed = 1.0
    @AppStorage(VoiceCatalog.languageKey) private var language = "english"
    @AppStorage(VoiceCatalog.microphoneKey) private var microphone = ""
    @AppStorage(VoiceMode.enabledKey) private var enabled = true
    @State private var microphones: [VoiceAudio.Microphone] = []
    @State private var voice = VoiceMode.shared

    var body: some View {
        Form {
            SettingsSection("Voice",
                            about: "Press the waveform button beside Send to talk with a thread out loud. What you say goes to the thread as your message, even while it's working, and its replies are read out. Talk over it and it stops to listen. It's the same thread, with the same memory, tools and approvals. Speech is turned into text on this Mac by macOS, and replies are spoken by Kyutai's pocket-tts, which Threadbear downloads the first time you use Voice.",
                            ask: "change how Voice sounds, or check on it if it isn't working.") {
                Toggle("Use Voice", isOn: $enabled)
                    .tip("Show the waveform button beside Send to talk with threads out loud")
                    .onChange(of: enabled) { _, on in if !on { VoiceMode.shared.stop() } }
                Picker("Voice", selection: $voiceId) {
                    ForEach(VoiceCatalog.voices) { Text($0.name).tag($0.id) }
                }
                .tip("Who the agent sounds like")
                Picker("Speed", selection: $speed) {
                    ForEach(VoiceCatalog.speeds, id: \.self) { Text(VoiceCatalog.speedTitle($0)).tag($0) }
                }
                .tip("How fast replies are read")
                Picker("Language", selection: $language) {
                    ForEach(VoiceCatalog.languages) { Text($0.name).tag($0.id) }
                }
                .tip("The language you speak and replies are read in")
                .onChange(of: language) { VoiceMode.shared.languageChanged() }
                LabeledContent("Try it") {
                    HStack(spacing: 8) {
                        if let status = voice.previewStatus {
                            Text(status).foregroundStyle(.secondary).lineLimit(2)
                        }
                        Button("Play a Sample") {
                            voice.preview(voice: VoiceCatalog.voice(voiceId), speed: VoiceCatalog.speed(speed))
                        }
                        .tip("Hear this voice at this speed")
                    }
                }
            }

            SettingsSection("System",
                            about: "The microphone Voice listens on. System Default follows System Settings > Sound.",
                            ask: "find out why it can't hear you.") {
                Picker("Microphone", selection: $microphone) {
                    Text("System Default").tag("")
                    ForEach(microphones) { Text($0.name).tag($0.uid) }
                }
                .tip("The microphone Voice listens on")
            }
        }
        .formStyle(.grouped)
        .fixedSize(horizontal: false, vertical: true)
        .scrollIndicators(.never)
        .scrollDisabled(true)
        .onAppear { microphones = VoiceAudio.microphones() }
    }
}
