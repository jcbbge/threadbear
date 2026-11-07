import Foundation
import ThreadbearCore

/// Settings > General's Instructions. `standingInstructions` is nil while the
/// runner has none to offer (the experiment off, or a runner from before), and
/// then there's no box.
extension AppModel {
    func loadStandingInstructions() {
        guard let client else { return }
        Task {
            do {
                standingInstructions = try await client.standingInstructionsGet()
            } catch RPCError.server(let code, _) where code == RPCError.methodNotFound {
                standingInstructions = nil
            } catch {
                AppLog.write("rpc", "instructions.get failed: \(error.localizedDescription)")
            }
        }
    }

    /// Saves his standing instructions. Nil when it worked, else why not.
    func saveStandingInstructions(_ text: String) async -> String? {
        guard let client, connection == .connected else { return "Not connected to the runner." }
        do {
            standingInstructions = try await client.standingInstructionsSet(text)
            return nil
        } catch RPCError.server(_, let message) {
            return message
        } catch {
            return error.localizedDescription
        }
    }
}
