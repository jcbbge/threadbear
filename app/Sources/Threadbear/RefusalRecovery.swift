import Foundation
import ThreadbearCore

/// The provider's refusal error can still be in an old runner's transcript,
/// so recognise its wording without requiring a new protocol field.
enum RefusalRecovery {
    static let model = "gpt-6.1-sol"
    static let continuation = "Please continue with the task from where it stopped."

    static func isRefusal(_ error: String) -> Bool {
        let text = error.lowercased()
        return text.contains("api error:") && (
            text.contains("reasoning_extraction") ||
            text.contains("safeguards flagged this message") && text.contains("claude")
        )
    }

    static func target(thread: ThreadSummary, completion: TurnCompletion?, accounts: [Account]) -> Account? {
        guard thread.status == .error, thread.provider == "claude",
              let completion, completion.outcome == .failed,
              let error = completion.error, isRefusal(error) else { return nil }
        let available = accounts.filter {
            $0.provider == "codex" && $0.models.contains { $0.id == model }
                && Pools.hasRoom($0) && ($0.note ?? "").isEmpty
        }
        guard let id = AccountUsageText.pickAccount(available, lastUsedId: nil) ?? available.first?.id else { return nil }
        return available.first { $0.id == id }
    }
}

extension AppModel {
    func refusalTarget(for thread: ThreadSummary) -> Account? {
        guard let logins = logins(for: thread), let session = loadedSession(thread.id), session.state == .loaded else { return nil }
        return RefusalRecovery.target(thread: thread, completion: session.latestCompletion, accounts: logins.accounts)
    }

    func continueRefusal(_ threadId: String) {
        guard !continuingRefusals.contains(threadId), let thread = threads[threadId],
              let target = refusalTarget(for: thread), let client = client(for: threadId) else { return }
        continuingRefusals.insert(threadId)
        Task {
            defer { continuingRefusals.remove(threadId) }
            do {
                // Await the switch before sending, just as the model picker
                // does for a provider handoff. Keep the composer's draft intact.
                var change = ThreadUpdate(accountId: target.id, model: .some(RefusalRecovery.model))
                if let effort = lastEfforts["codex"] { change.effort = .some(effort) }
                let moved = try await client.updateThread(threadId, change)
                threads[threadId] = moved
                guard moved.provider == "codex", moved.model == RefusalRecovery.model else {
                    errorMessage = "Codex Sol is no longer available. Choose a model to carry on."
                    return
                }
                _ = try await client.send(threadId: threadId, text: RefusalRecovery.continuation)
            } catch {
                show(error)
            }
        }
    }
}
