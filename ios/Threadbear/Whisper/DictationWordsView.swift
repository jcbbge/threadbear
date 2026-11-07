import SwiftUI

/// Settings › Dictation › Words.
struct DictationWordsView: View {
    @State private var new = ""
    private var list: DictationWords { .shared }

    var body: some View {
        Form {
            Section {
                TextField("Add a word or name", text: $new)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .submitLabel(.done)
                    .onSubmit {
                        list.add([new])
                        new = ""
                    }
            }
            Section {
                ForEach(list.words, id: \.self) { Text($0) }
                    .onDelete { list.remove(at: $0) }
            } footer: {
                Text("Whisper spells these the way they're written here.")
            }
            Section {
                Button("Restore the defaults") { list.restoreDefaults() }
            }
        }
        .navigationTitle("Words")
    }
}
