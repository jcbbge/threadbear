import AppKit
import ThreadbearCore

enum SettingsTab: String, Hashable, CaseIterable {
    case general, voice, models, pools, runners, devices, keyboard
}

/// The Settings window's side of AppModel. Everything in it is the
/// runner's (runner.json); the app keeps none of it.
extension AppModel {
    /// After hello; `settings.updated` replaces them from then on.
    func loadSettings() {
        guard let client else { return }
        Task {
            do {
                receive(try await client.settingsGet())
            } catch RPCError.server(let code, _) where code == RPCError.methodNotFound {
                // A runner from before settings.
                settingsUnsupported = true
                runnerSettings = nil
            } catch {
                AppLog.write("rpc", "settings.get failed: \(error.localizedDescription)")
            }
        }
    }

    func receive(_ settings: RunnerSettings) {
        runnerSettings = settings
        settingsUnsupported = false
        // The new-thread composer starts in the default folder.
        if !settings.defaultCwd.isEmpty { defaults.cwd = (settings.defaultCwd as NSString).expandingTildeInPath }
    }

    /// Pools with a Claude login: only those can take small jobs (titles,
    /// the librarian). Settings › Models and the Librarian's page pick
    /// from these.
    var claudePools: [Pool] {
        pools.filter { pool in
            pool.accountIds.contains { id in accounts.contains { $0.id == id && $0.provider == "claude" } }
        }
    }

    /// Settings › Models, from somewhere else in the app.
    func openModelSettings() {
        settingsTab = .models
        settingsRequest += 1
    }

    /// Changes what's given. The window shows the change straight away;
    /// the runner's answer (or its error) then has the last word.
    func updateSettings(_ update: SettingsUpdate) {
        guard let client else { return settingsError = "Not connected to the runner." }
        if var shown = runnerSettings {
            if let v = update.defaultCwd { shown.defaultCwd = v }
            if let v = update.idleMinutes { shown.idleMinutes = v }
            if let v = update.maxLiveCLIs { shown.maxLiveCLIs = v }
            if let v = update.followMain { shown.followMain = v }
            if let v = update.bulletReplies { shown.bulletReplies = v }
            if let v = update.oneReply { shown.oneReply = v }
            if let v = update.bringIn { shown.bringIn = v }
            if let v = update.pool { shown.models.pool = v }
            if let v = update.privateFolders { shown.models.privateFolders = v }
            runnerSettings = shown
        }
        Task {
            do {
                receive(try await client.settingsUpdate(update))
                settingsError = nil
            } catch {
                settingsError = error.localizedDescription
                AppLog.write("rpc", "settings.update failed: \(error.localizedDescription)")
                loadSettings()
            }
        }
    }

}
