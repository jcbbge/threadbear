import SwiftUI
import ThreadbearKit

/// A new thread from the phone. It starts in the runner's default folder
/// (Mike didn't want a folder picker on the phone, 31 Oct); the runner, model
/// and effort can be picked, and the runner picks a login with room for them.
/// The runner starts on the first one online in Mike's order (Settings), so
/// the Mac asleep doesn't leave the phone nowhere to start one (6 Nov).
/// It closes as soon as the backend has the request (7 Nov, Mike: waiting on
/// the runner's answer left the spinner up for ages); a row in the inbox
/// stands in for the thread until the runner's made it (AppModel.starting).
struct NewThreadView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    /// With the create command's id, as the sheet closes.
    var onStarted: (String) -> Void
    @State private var text: String

    init(text: String = "", onStarted: @escaping (String) -> Void) {
        self.init(draft: NewThreadDraft(text: text, photos: []), onStarted: onStarted)
    }

    /// A failed start's sheet again, as it was.
    init(draft: NewThreadDraft, onStarted: @escaping (String) -> Void) {
        _text = State(initialValue: draft.text)
        _photos = State(initialValue: draft.photos)
        _runnerId = State(initialValue: draft.runnerId)
        _modelId = State(initialValue: draft.modelId)
        _effort = State(initialValue: draft.effort)
        self.onStarted = onStarted
    }
    /// Nil until the runners are in, then the first online in Mike's order.
    @State private var runnerId: String?
    @State private var modelId: String?
    @State private var effort: String?
    /// From the tap on Start until the command's queued. Without it Start
    /// looks dead (and can be tapped again, for a second thread) while the
    /// photos finish going up.
    @State private var starting: Task<Void, Never>?
    @State private var photos: [PickedPhoto]
    @State private var adding = 0
    @State private var cursor = TextCursor()
    @State private var dictation = Dictation()

    /// Each photo a chip in the words where it was put in, as on the Mac.
    private var words: PhotoWords { PhotoWords(text: $text, photos: $photos, adding: $adding, cursor: cursor) }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    PastableTextField(text: $text, placeholder: "What should it do?", lines: 4...12,
                                      onPasteImages: model.canSendPhotos ? { words.addPasted($0, model: model) } : nil,
                                      photos: $photos, cursor: cursor, threadReference: { model.threadReference(pasted: $0) })
                    HStack {
                        if model.canSendPhotos {
                            PhotoMenu(words: words) {
                                Label("Add a photo", systemImage: "photo")
                            }
                        }
                        Spacer()
                        DictateButton(text: $text, dictation: dictation) {
                            Label("Dictate", systemImage: "mic")
                        }
                    }
                    // Two buttons in one Form row: without this a tap anywhere
                    // in the row fires both.
                    .buttonStyle(.borderless)
                    DictationNotes(dictation: dictation)
                    if model.canSendPhotos, !photos.isEmpty || adding > 0 { PhotoStrip(words: words) }
                }
                // The words are taken as Start is tapped: anything typed or
                // added while it goes would be lost (Mike, 7 Nov). The pickers
                // below stay live, as start() reads them once the photos are up.
                .disabled(starting != nil)
                if model.canChooseRunner || !models.isEmpty {
                    Section {
                        if model.canChooseRunner {
                            Picker("Runner", selection: $runnerId) {
                                // Only with no runner placed and no main Mac known: the backend picks.
                                if runnerId == nil { Text("Automatic").tag(String?.none) }
                                ForEach(model.runners) { runner in
                                    Text(runner.isOnline(at: model.now) ? runner.name : "\(runner.name), offline").tag(Optional(runner.runnerId))
                                }
                            }
                        }
                        if !models.isEmpty { modelPickers }
                    }
                    .onChange(of: modelId) {
                        // Codex's Ultra on a Claude model, say: back to the model's own.
                        if !NewThreadChoices.keeps(effort: effort, model: chosenModel) { effort = nil }
                    }
                    .onChange(of: runnerId) {
                        // A model this runner has no login for: back to its default.
                        if let modelId, !models.contains(where: { $0.id == modelId }) { self.modelId = nil }
                        // No pickers on it (its logins aren't in yet): its own effort too.
                        if models.isEmpty { effort = nil }
                    }
                }
                if let offline = offlineText {
                    Section { Label("\(offline). It'll start when it's back.", systemImage: "moon.zzz").font(.footnote) }
                }
            }
            .navigationTitle("New thread")
            .navigationBarTitleDisplayMode(.inline)
            .onAppear(perform: pickRunner)
            .onChange(of: model.runners) { pickRunner() }
            // The backend's API version can come after the sheet's up.
            .onChange(of: model.canChooseRunner) { pickRunner() }
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") {
                        starting?.cancel()
                        dismiss()
                    }
                }
                ToolbarItem(placement: .confirmationAction) {
                    if starting != nil { ProgressView() } else {
                        // Not with a photo still on its way, which would be left behind.
                        // Nor with Whisper still to type out what was said.
                        Button("Start", action: start).disabled((words.message.isEmpty && photos.isEmpty) || adding > 0
                                                                || dictation.holdsWords)
                    }
                }
            }
            .onDisappear { dictation.close() }
            .task {
                if photos.isEmpty, let load = model.loadSamplePhoto { words.add([load], model: model) }
            }
        }
    }

    @ViewBuilder private var modelPickers: some View {
        Picker("Model", selection: $modelId) {
            Text("Default").tag(String?.none)
            ForEach(models) { Text($0.title).tag(Optional($0.id)) }
        }
        Picker("Effort", selection: $effort) {
            Text("Default").tag(String?.none)
            ForEach(NewThreadChoices.efforts(for: chosenModel), id: \.self) { Text(NewThreadChoices.effortTitle($0)).tag(Optional($0)) }
        }
    }

    private var models: [PhoneModelChoice] { model.newThreadModels(on: model.canChooseRunner ? runnerId : nil) }
    private var chosenRunner: PhoneRunner? { model.runners.first { $0.runnerId == runnerId } }

    /// With a runner picked, whether that one's asleep; otherwise whether they all are.
    private var offlineText: String? {
        guard model.canChooseRunner, let runner = chosenRunner else { return model.offlineText }
        guard !runner.isOnline(at: model.now) else { return nil }
        return "\(runner.name) offline since \(RelativeTime.clock(runner.lastSeenAt, now: model.now))"
    }

    /// The first runner online in Mike's order, once the runners are in.
    /// Kept once picked, unless it's gone from the list.
    private func pickRunner() {
        // Down to one runner (one revoked meanwhile, say): back to the
        // backend's choice, and to a model that one has.
        guard model.canChooseRunner else {
            runnerId = nil
            return
        }
        if let runnerId, model.runners.contains(where: { $0.runnerId == runnerId }) { return }
        // Gone from the list: picked afresh, or the backend's choice.
        runnerId = NewThreadChoices.runner(model.runners, now: model.now)?.runnerId
    }
    private var chosenModel: PhoneModelChoice? { models.first { $0.id == modelId } }

    private func start() {
        guard let backend = model.backend else { return }
        dictation.stop()
        let message = words.message
        let typed = text
        let photos = photos
        starting = Task {
            defer { starting = nil }
            do {
                let images = try await model.upload(photos)
                // Cancelled while the photos were going up: no thread after all.
                try Task.checkCancellation()
                // Picked now if the sheet never got to (the runners or the
                // API version came in as Start was tapped).
                if model.canChooseRunner, runnerId == nil { pickRunner() }
                // Taken once: the pickers can still change while the request goes.
                let draft = NewThreadDraft(text: typed, photos: photos, runnerId: model.canChooseRunner ? runnerId : nil, modelId: modelId, effort: effort)
                let commandId = try await backend.create(text: message, runnerId: draft.runnerId, cwd: nil, images: images,
                                                         settings: NewThreadSettings(model: draft.modelId, effort: draft.effort))
                model.sent(photos)
                model.started(commandId: commandId, message: message, draft: draft)
                onStarted(commandId)
                dismiss()
            } catch is CancellationError {
            } catch {
                model.report(error)
            }
        }
    }
}
