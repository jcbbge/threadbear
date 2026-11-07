import SwiftUI
import ThreadbearKit

/// A secret the agent asked for (`ask_secret`, docs/protocol.md "Secrets"):
/// typed here, sealed to the runner's key before it leaves the phone, so the
/// Convex mirror only carries ciphertext. The value lives in this view's
/// state until Save, which clears it at once; it's never logged, put in a
/// draft or shown in an error.
struct SecretCard: View {
    @Environment(AppModel.self) private var model
    let threadId: String
    let runnerId: String
    let approvalId: String
    let label: String
    let reason: String
    let placeholder: String?
    let key: String
    var onSent: (String) -> Void
    @State private var value = ""
    /// Save or Decline has been tapped: spinning until the card goes
    /// (AppModel.answerCard), there still if he leaves and comes back.
    private var busy: Bool { model.cardAnswers[approvalId] != nil }
    private var declining: Bool { model.cardAnswers[approvalId]?.choice == "decline" }
    @State private var problem: String?
    /// Checked against the key kept for this runner (from pairing), and the
    /// runner kept for this thread, once the card shows and again on Save.
    @State private var trust: RunnerKeyPins.Trust?

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Label(label, systemImage: "key")
                .font(.headline)
            if !reason.isEmpty {
                Text(reason).font(.subheadline).foregroundStyle(.secondary)
            }
            if !model.canAnswerSecrets || !SecretSeal.isUsableKey(key) {
                // An older backend can't take phone:secret (API 35).
                Label("Answer this on the Mac.", systemImage: "laptopcomputer")
                    .font(.footnote).foregroundStyle(.secondary)
            } else if trust == .changed {
                Label("This Mac's key changed. Answer it on the Mac.", systemImage: "exclamationmark.shield")
                    .font(.footnote).foregroundStyle(.orange)
            } else if trust == .unknown {
                // Not in the pairing link, so only the mirror says it's one
                // of yours: nothing is sealed to it.
                Label("The phone doesn't know this Mac yet, so it won't send it secrets. Answer it on the Mac, or pair the phone again.",
                      systemImage: "exclamationmark.shield")
                    .font(.footnote).foregroundStyle(.orange)
            } else if trust == .moved {
                // Threads never change Macs, so this is the backend saying
                // otherwise: nothing is sealed to the new one.
                Label("This thread's Mac changed, so the phone won't send it secrets. Answer it on the Mac.",
                      systemImage: "exclamationmark.shield")
                    .font(.footnote).foregroundStyle(.orange)
            } else {
                SecureField(placeholder ?? "Paste the secret", text: $value)
                    .textFieldStyle(.roundedBorder)
                    // Not .password, so iOS doesn't offer to save it as one.
                    .textContentType(.oneTimeCode)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .privacySensitive()
                    .submitLabel(.done)
                    .onSubmit(save)
                    .disabled(busy)
                Label("Kept out of chat, in a private file this agent's commands can read for 24 hours", systemImage: "lock.shield")
                    .font(.footnote).foregroundStyle(.secondary)
                if let problem = problem ?? refusal {
                    Text(problem).font(.footnote).foregroundStyle(.red)
                }
                HStack {
                    Button(action: save) {
                        Text("Save securely")
                            .frame(maxWidth: .infinity)
                            .spinning(busy && !declining, tint: .white)
                    }
                    .buttonStyle(.borderedProminent)
                    .disabled(busy ? declining : value.isEmpty)
                    Button(action: decline) {
                        Text("Decline")
                            .frame(maxWidth: .infinity)
                            .spinning(busy && declining)
                    }
                    .buttonStyle(.bordered)
                    .tint(.red)
                    .disabled(busy && !declining)
                }
                .allowsHitTesting(!busy)
            }
        }
        .padding()
        .background(Color(.secondarySystemBackground), in: RoundedRectangle(cornerRadius: 16, style: .continuous))
        .sensoryFeedback(trigger: busy) { _, new in
            new ? (declining ? .selection : .impact(weight: .light)) : nil
        }
        .task(id: "\(runnerId) \(key)") {
            guard model.canAnswerSecrets, SecretSeal.isUsableKey(key) else { return }
            trust = RunnerKeyPins.check(key, runnerId: runnerId, threadId: threadId, in: model.runnerKeys)
        }
    }

    /// Our own words, not the server's: nothing that came back with the request
    /// ends up on screen. The value's gone, so it's typed afresh.
    private var refusal: String? {
        guard !busy, let choice = model.refusedSecrets[approvalId] else { return nil }
        return choice == "decline" ? "Couldn't decline it. Try again." : "Couldn't send it. Type it again to retry."
    }

    private func save() {
        guard model.backend != nil, !busy, !value.isEmpty else { return }
        // Out of the field (and this view's state) before anything else.
        let typed = value
        value = ""
        problem = nil
        // Checked again here, so a key or runner swapped in since the card
        // showed is never sealed to.
        let now = RunnerKeyPins.check(key, runnerId: runnerId, threadId: threadId, in: model.runnerKeys)
        guard now == .trusted else {
            trust = now
            return
        }
        let sealed: SealedSecret
        do { sealed = try SecretSeal.seal(typed, toKey: key, approvalId: approvalId) } catch {
            problem = "Couldn't seal it. Answer it on the Mac."
            return
        }
        send(.sealed(sealed))
    }

    private func decline() {
        guard !busy else { return }
        value = ""
        problem = nil
        send(.decline)
    }

    private func send(_ answer: SecretAnswer) {
        let (threadId, approvalId) = (threadId, approvalId)
        model.answerCard(approvalId, choice: answer == .decline ? "decline" : "save", secret: true, send: { backend in
            try await backend.secret(threadId: threadId, approvalId: approvalId, answer: answer)
        }, sent: onSent)
    }
}
