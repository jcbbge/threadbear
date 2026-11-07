import SwiftUI
import ThreadbearCore

/// Settings > General's Instructions: what every thread's agent should always
/// keep in mind (who he is, how to write, what he works with), given to every
/// session on every login, Claude and Codex (docs/protocol.md, "Standing
/// instructions"). Saved a moment after he stops typing, and when the window
/// closes. After Wayne Sutton's Instructions box.
///
/// If the file was changed anywhere but here, no agent is given it, and this
/// shows what it holds with no way to edit it until he's decided, so a typed
/// word can't sign someone else's text by accident.
struct InstructionsSection: View {
    @Environment(AppModel.self) private var app

    var body: some View {
        if let current = app.standingInstructions {
            SettingsSection("Instructions",
                            about: "Threadbear gives these to every thread's agent in every session, on every login, Claude and Codex alike. A chat that's already going hears a change before your next message. A login's own CLAUDE.md or AGENTS.md still applies, for what's particular to it. Leave this empty for none.",
                            ask: "draft some for you to paste here. Agents can't change them themselves: only what's saved here is given to them.") {
                if current.outside == true {
                    InstructionsChangedOutside(file: current.text)
                } else {
                    InstructionsEditor(saved: current.text)
                }
            }
        }
    }
}

private struct InstructionsEditor: View {
    @Environment(AppModel.self) private var app
    let saved: String
    @State private var text = ""
    @State private var loaded = false
    @State private var status: String?
    @State private var save: Task<Void, Never>?

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            TextEditor(text: $text)
                .font(.body)
                .scrollContentBackground(.hidden)
                .frame(minHeight: 96, maxHeight: 200)
                .overlay(alignment: .topLeading) {
                    if text.isEmpty {
                        Text("For example: I build with React, TypeScript and Convex. Write plainly and briefly.")
                            .foregroundStyle(.tertiary)
                            .padding(.leading, 5)
                            .allowsHitTesting(false)
                    }
                }
                .onChange(of: text) { _, _ in scheduleSave() }
                .tip("What every thread's agent should always keep in mind")
            if let status {
                Text(status).font(.caption).foregroundStyle(.secondary)
            }
        }
        .onAppear {
            if !loaded { text = saved; loaded = true }
        }
        .onChange(of: saved) { _, new in
            // Set elsewhere (or loaded late) while he isn't typing here.
            if save == nil, trimmed(new) != trimmed(text) { text = new }
        }
        .onDisappear { commit() }
    }

    private func trimmed(_ s: String) -> String { s.trimmingCharacters(in: .whitespacesAndNewlines) }

    private func scheduleSave() {
        guard loaded else { return }
        save?.cancel()
        status = nil
        save = Task {
            try? await Task.sleep(for: .seconds(1))
            guard !Task.isCancelled else { return }
            await write()
        }
    }

    private func commit() {
        guard loaded, save != nil else { return }
        save?.cancel()
        Task { await write() }
    }

    private func write() async {
        save = nil
        let wanted = text
        guard trimmed(wanted) != trimmed(saved) else { return }
        if let error = await app.saveStandingInstructions(wanted) {
            status = error
        } else {
            status = trimmed(wanted).isEmpty ? "Cleared" : "Saved"
        }
    }
}

/// The file isn't what was saved here. Keeping it sends the words shown, not
/// "trust the file". Those stay as they were when he started reading, whatever
/// the file does next: a new version swapped in under him could otherwise have
/// its first lines changed above where he'd scrolled to (Codex review). A newer
/// one waits behind a button, and starts from the top.
private struct InstructionsChangedOutside: View {
    @Environment(AppModel.self) private var app
    let file: String
    @State private var reviewed: String
    @State private var busy = false
    @State private var error: String?

    init(file: String) {
        self.file = file
        _reviewed = State(initialValue: file)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Label("Something other than Settings changed these, so agents aren't being given them.", systemImage: "exclamationmark.triangle")
                .foregroundStyle(.orange)
                .fixedSize(horizontal: false, vertical: true)
            ScrollView {
                Text(reviewed.isEmpty ? "The file is gone, or can't be read." : reviewed)
                    .foregroundStyle(reviewed.isEmpty ? .secondary : .primary)
                    .textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            .frame(maxHeight: 160)
            .id(reviewed)
            if let error {
                Text(error).font(.caption).foregroundStyle(.red)
            }
            HStack {
                if busy { ProgressView().controlSize(.small) }
                if file != reviewed {
                    Button("Show Newer Version") { reviewed = file }
                        .tip("The file has changed again. Show what it holds now")
                }
                Spacer()
                Button("Clear") { resolve("") }
                    .tip("Delete these, so agents are given no standing instructions")
                Button("Use These") { resolve(reviewed) }
                    .disabled(reviewed.isEmpty)
                    .tip("Give every agent exactly the text shown here")
            }
            .disabled(busy)
        }
    }

    private func resolve(_ text: String) {
        busy = true
        error = nil
        Task {
            error = await app.saveStandingInstructions(text)
            busy = false
        }
    }
}
