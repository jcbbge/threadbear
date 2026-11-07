import SwiftUI
import ThreadbearKit

/// The text box at the bottom of a thread: type or dictate, add or paste
/// photos, then send. The mic is the new thread sheet's (Mike wanted it on
/// replies too, 7 Nov), beside Send so a thumb finds both.
struct Composer: View {
    @Environment(AppModel.self) private var model
    @Binding var text: String
    var placeholder: String
    /// The thread's patch link buttons, in a row over the box as the Mac
    /// has its chips over its composer.
    var links: [PhoneLink] = []
    /// Returns whether it went, so a failed send keeps the text.
    var onSend: (String, [PickedPhoto]) async -> Bool
    @State private var photos: [PickedPhoto] = []
    @State private var adding = 0
    @State private var cursor = TextCursor()
    @State private var sending = false
    @State private var dictation = Dictation()

    /// Each photo a chip in the words where it was put in, as on the Mac.
    private var words: PhotoWords { PhotoWords(text: $text, photos: $photos, adding: $adding, cursor: cursor) }

    var body: some View {
        VStack(spacing: 6) {
            if !links.isEmpty {
                LinkChips(links: links)
            }
            if !photos.isEmpty || adding > 0 {
                PhotoStrip(words: words).disabled(sending)
            }
            DictationNotes(dictation: dictation)
                .frame(maxWidth: .infinity, alignment: .leading)
            // What's typed (or Apple's dictation typing as it goes) stays in
            // sight above the bar.
            if hearing, !text.isEmpty { field.disabled(sending) }
            HStack(alignment: .bottom, spacing: 8) {
                // While it's hearing, the whole box is the waveform and its
                // stop, as squeezed beside the text it was too cramped to read
                // (Mike, 7 Nov).
                Group {
                    if hearing {
                        ComposerListeningBar(dictation: dictation)
                    } else {
                        if model.canSendPhotos {
                            PhotoMenu(words: words) {
                                Image(systemName: "plus.circle")
                                    .font(.system(size: 30))
                                    .symbolRenderingMode(.hierarchical)
                                    .foregroundStyle(.secondary)
                            }
                            // A menu's label takes the accent otherwise, and only Send should have it.
                            .tint(.secondary)
                            .accessibilityLabel("Add a photo")
                        }
                        field
                        // Grey like Add a photo, as only Send has the accent; red while listening.
                        DictateButton(text: $text, dictation: dictation, idleTint: .secondary) {
                            Image(systemName: "mic")
                                .font(.system(size: 22))
                                .frame(width: 30, height: 30)
                        }
                        .frame(minHeight: 30)
                        .accessibilityLabel(dictation.isListening ? "Stop dictating" : "Dictate")
                    }
                }
                // Nothing more in while it goes: the box empties when it lands,
                // taking anything added meanwhile with it (Mike, 7 Nov).
                .disabled(sending)
                Button(action: send) {
                    // A photo can take a while to go up on mobile data.
                    if sending && !photos.isEmpty {
                        ProgressView().frame(width: 30, height: 30)
                    } else {
                        Image(systemName: "arrow.up.circle.fill")
                            .font(.system(size: 30))
                    }
                }
                // Not with a photo still on its way, which would be left behind.
                // Nor with Whisper still to type out what was said.
                .disabled((words.message.isEmpty && photos.isEmpty) || sending || adding > 0 || dictation.holdsWords)
                .accessibilityLabel("Send")
            }
        }
        .padding(.horizontal)
        .padding(.vertical, 8)
        .background(.bar)
        .onDisappear { dictation.close() }
        #if DEBUG
        // For sim-shots.sh: stills of the dictating bar, as the simulator has no one talking.
        .task {
            let args = ProcessInfo.processInfo.arguments
            if args.contains("-ThreadbearDictating") { dictation.fakeListening() }
            if args.contains("-ThreadbearTypingOut") { dictation.fakeTypingOut() }
        }
        #endif
        .task {
            if photos.isEmpty, let load = model.loadSamplePhoto { words.add([load], model: model) }
        }
    }

    private var hearing: Bool { dictation.isListening || dictation.isTranscribing }

    private var field: some View {
        PastableTextField(text: $text, placeholder: placeholder, lines: 1...6,
                          onPasteImages: model.canSendPhotos ? { words.addPasted($0, model: model) } : nil,
                          photos: $photos, cursor: cursor, threadReference: { model.threadReference(pasted: $0) })
            .padding(.horizontal, 14)
            .padding(.vertical, 9)
            .background(Color(.secondarySystemBackground), in: RoundedRectangle(cornerRadius: 20, style: .continuous))
    }

    private func send() {
        let message = words.message
        guard !message.isEmpty || !photos.isEmpty else { return }
        // Apple's dictation still listening would type into the emptied box.
        dictation.stop()
        sending = true
        Task {
            if await onSend(message, photos) {
                text = ""
                photos = []
            }
            sending = false
        }
    }
}

/// A thread's patch link buttons: each opens its page in the browser here,
/// with nothing sent to the Mac. A row that scrolls sideways when there are
/// more than fit.
struct LinkChips: View {
    var links: [PhoneLink]

    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 6) {
                ForEach(Array(links.enumerated()), id: \.offset) { _, link in
                    if let page = link.page {
                        Link(destination: page) {
                            Label(link.title, systemImage: UIImage(systemName: link.icon ?? "") == nil ? "arrow.up.right.square" : link.icon!)
                                .font(.footnote)
                                .lineLimit(1)
                                .padding(.horizontal, 10)
                                .padding(.vertical, 6)
                                .background(Color(.secondarySystemBackground), in: Capsule())
                        }
                        .tint(.primary)
                        .accessibilityHint("Opens \(page.host() ?? "the page") in the browser")
                    }
                }
            }
        }
        .scrollClipDisabled()
    }
}

/// The reply box while dictating: the waveform across the box, the time so
/// far and a stop, or Whisper typing it out once stopped.
private struct ComposerListeningBar: View {
    let dictation: Dictation

    var body: some View {
        // Not a disabled button while typing out: that dims it past reading.
        if dictation.isTranscribing {
            HStack(spacing: 12) {
                ProgressView()
                Text("Typing it out").foregroundStyle(.secondary)
                Spacer()
            }
            .modifier(BarShape())
            .accessibilityElement(children: .combine)
        } else {
            Button { dictation.finish() } label: {
                HStack(spacing: 12) {
                    TimelineView(.periodic(from: .now, by: 1.0 / 15)) { context in
                        HStack(spacing: 12) {
                            Waveform(levels: dictation.level.history)
                            Text(elapsed(at: context.date)).monospacedDigit()
                        }
                    }
                    Image(systemName: "stop.circle.fill").font(.system(size: 26))
                }
                .foregroundStyle(.red)
                .modifier(BarShape())
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Stop dictating")
        }
    }

    private func elapsed(at now: Date) -> String {
        let seconds = Int(now.timeIntervalSince(dictation.startedAt ?? now))
        return String(format: "%d:%02d", seconds / 60, seconds % 60)
    }
}

/// The bar's box, the same size and shape as the text box it stands in for.
private struct BarShape: ViewModifier {
    func body(content: Content) -> some View {
        content
            .padding(.leading, 14)
            .padding(.trailing, 6)
            .frame(minHeight: 40)
            .background(Color(.secondarySystemBackground), in: RoundedRectangle(cornerRadius: 20, style: .continuous))
    }
}

/// The mic's last moments as bars spread across the width they're given.
private struct Waveform: View {
    let levels: [Float]

    var body: some View {
        HStack(alignment: .center, spacing: 0) {
            ForEach(Array(levels.enumerated()), id: \.offset) { index, value in
                if index > 0 { Spacer(minLength: 2) }
                Capsule().frame(width: 3, height: 3 + CGFloat(value) * 20)
            }
        }
        .frame(maxWidth: .infinity, minHeight: 24)
        .animation(.linear(duration: 1.0 / 15), value: levels)
    }
}
