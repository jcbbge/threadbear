import SwiftUI
import ThreadbearCore

/// Settings > Keyboard: every command that can have a key. Click a key, press
/// the new one, and it's changed. Mike picked this from three mockups on 6 Nov
/// (the others left the changing to macOS or to an agent), and it isn't one of
/// Settings' usual ask-your-agent sections because starting a thread to change
/// one key is slow. The keys are still in a file an agent can change.
struct KeyboardSettings: View {
    @State private var search = ""

    var body: some View {
        let shortcuts = AppShortcuts.shared
        VStack(spacing: 0) {
            SearchField(text: $search, prompt: "Search shortcuts")
                .padding(.horizontal, 20)
                .padding(.top, 14)
            Form {
                ForEach(ShortcutGroup.allCases, id: \.self) { group in
                    let commands = group.commands.filter(matches)
                    if !commands.isEmpty {
                        SettingsSection(group.title,
                                        about: "The keys for what's in the \(group.title) menu. Click one, then press the new keys. Esc cancels, and Delete removes it.",
                                        ask: "change them for you, or tell you what's free. They're in shortcuts.json in Threadbear's data folder, which holds only what you've changed.") {
                            ForEach(commands, id: \.self) { ShortcutRow(command: $0) }
                        }
                    }
                }
            }
            .formStyle(.grouped)
            VStack(alignment: .leading, spacing: 6) {
                if let problem = shortcuts.problem {
                    Label(problem, systemImage: "exclamationmark.triangle")
                        .foregroundStyle(.orange)
                        .fixedSize(horizontal: false, vertical: true)
                }
                HStack {
                    Text("Saved in a file your agents can read and change too.")
                        .foregroundStyle(.secondary)
                        .tip(shortcuts.file.path)
                    Spacer()
                    Button("Reset All") {
                        ShortcutRecorder.shared.cancel()
                        shortcuts.change { $0.resetAll() }
                    }
                    .disabled(!shortcuts.bindings.anyChanged)
                    .tip("Every key back to how Threadbear comes")
                }
            }
            .font(.system(size: 12))
            .padding(.horizontal, 22)
            .padding(.top, 8)
            .padding(.bottom, 14)
        }
        .frame(height: 620)
        .onDisappear { ShortcutRecorder.shared.cancel() }
    }

    private func matches(_ command: ShortcutCommand) -> Bool {
        let words = search.trimmingCharacters(in: .whitespaces)
        guard !words.isEmpty else { return true }
        return command.title.localizedCaseInsensitiveContains(words)
            || command.group.title.localizedCaseInsensitiveContains(words)
            || (AppShortcuts.shared.display(command)?.localizedCaseInsensitiveContains(words) ?? false)
    }
}

private struct ShortcutRow: View {
    let command: ShortcutCommand

    var body: some View {
        let shortcuts = AppShortcuts.shared
        let recorder = ShortcutRecorder.shared
        let listening = recorder.command == command
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 10) {
                VStack(alignment: .leading, spacing: 1) {
                    Text(command.title)
                    if listening, recorder.outcome == .waiting {
                        Text("Esc cancels, and Delete removes it")
                            .font(.system(size: 11))
                            .foregroundStyle(.secondary)
                    }
                }
                Spacer(minLength: 8)
                if shortcuts.bindings.isChanged(command), !listening {
                    Button("Reset") {
                        recorder.cancel()
                        shortcuts.change { $0.reset(command) }
                    }
                    .buttonStyle(.plain)
                    .font(.system(size: 11))
                    .foregroundStyle(.secondary)
                    .tip(command.defaultKey.map { "Back to \($0.display)" } ?? "Back to no key")
                }
                cap(listening: listening)
            }
            if listening, let question = Question(recorder.outcome) {
                HStack(spacing: 8) {
                    Text(question.text)
                        .foregroundStyle(.orange)
                        .fixedSize(horizontal: false, vertical: true)
                    Spacer(minLength: 4)
                    Button("Cancel") { recorder.cancel() }
                    if question.canTake {
                        Button("Use It for This Instead") { recorder.useTakenKey() }
                            .buttonStyle(.borderedProminent)
                    }
                }
                .font(.system(size: 12))
                .padding(.horizontal, 10)
                .padding(.vertical, 7)
                .background(Color.orange.opacity(0.12), in: RoundedRectangle(cornerRadius: 7, style: .continuous))
            }
        }
    }

    private func cap(listening: Bool) -> some View {
        let shortcuts = AppShortcuts.shared
        let recorder = ShortcutRecorder.shared
        let key = shortcuts.key(command)
        // Two commands on one key only comes from editing the file by hand.
        let twin = key.flatMap { shortcuts.bindings.command(using: $0, except: command) }
        return Button { recorder.start(command) } label: {
            KeyCap(look: look(listening: listening, key: key, twin: twin))
        }
        .buttonStyle(.plain)
        .tip(twin.map { "\(key?.display ?? "") is also \($0.title)" } ?? "Click, then press the new keys")
        .accessibilityLabel("\(command.title), \(key?.display ?? "no key")")
        .accessibilityHint("Click, then press the new keys")
    }

    private func look(listening: Bool, key: ShortcutKey?, twin: ShortcutCommand?) -> KeyCap.Look {
        if listening {
            switch ShortcutRecorder.shared.outcome {
            case .waiting, .typesInstead: return .listening
            case .takenByCommand(let pressed, _), .takenOutside(let pressed, _): return .taken(pressed.display)
            }
        }
        guard let key else { return .none }
        return twin == nil ? .key(key.display) : .taken(key.display)
    }
}

/// The line under a row when the key pressed can't simply be used.
private struct Question {
    let text: String
    let canTake: Bool

    init?(_ outcome: ShortcutRecorder.Outcome) {
        switch outcome {
        case .waiting:
            return nil
        case .typesInstead:
            text = "Include ⌘ or ⌃, otherwise that key would type instead."
            canTake = false
        case .takenByCommand(let key, let other):
            text = "\(key.display) is already \(other.title)."
            canTake = true
        case .takenOutside(let key, let what):
            text = "\(key.display) is taken by \(what), which can't be changed."
            canTake = false
        }
    }
}

private struct KeyCap: View {
    enum Look: Equatable {
        case key(String), none, listening, taken(String)
    }

    let look: Look

    var body: some View {
        Text(title)
            .font(.system(size: 12, weight: look == .listening ? .medium : .regular))
            .foregroundStyle(foreground)
            .lineLimit(1)
            .frame(minWidth: 62)
            .padding(.horizontal, 8)
            .padding(.vertical, 4)
            .background(background, in: shape)
            .overlay(shape.strokeBorder(border, lineWidth: 0.5))
            .contentShape(shape)
    }

    private var shape: RoundedRectangle { RoundedRectangle(cornerRadius: 6, style: .continuous) }

    private var title: String {
        switch look {
        case .key(let text), .taken(let text): text
        case .none: "Add"
        case .listening: "Press keys…"
        }
    }

    private var foreground: Color {
        switch look {
        case .key: .primary
        case .none: .secondary
        case .listening: .white
        case .taken: .orange
        }
    }

    private var background: Color {
        switch look {
        case .key: Color.primary.opacity(0.09)
        case .none: .clear
        case .listening: .accentColor
        case .taken: Color.orange.opacity(0.18)
        }
    }

    private var border: Color {
        switch look {
        case .key: Color.primary.opacity(0.1)
        case .none: Color.primary.opacity(0.2)
        case .listening: .clear
        case .taken: Color.orange.opacity(0.6)
        }
    }
}
