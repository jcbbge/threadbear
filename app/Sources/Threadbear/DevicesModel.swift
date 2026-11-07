import AppKit
import ThreadbearCore

/// The Phone & browser tab's side of AppModel (docs/protocol.md,
/// "Devices"). The list is the backend's, read through the runner each
/// time the tab opens or something changes; the app keeps no token. A
/// pairing link is handed to the QR code or the browser and then dropped,
/// and nothing about it is ever logged.
extension AppModel {
    /// Asks the runner for the list. Called when the tab shows and after
    /// a pair or revoke.
    func loadDevices() {
        guard let client else { return }
        devicesLoading = true
        Task {
            defer { devicesLoading = false }
            do {
                receive(try await client.devicesList())
                devicesError = nil
            } catch RPCError.server(let code, _) where code == RPCError.methodNotFound {
                devicesUnsupported = true
            } catch {
                devicesError = error.localizedDescription
                AppLog.write("rpc", "devices.list failed: \(error.localizedDescription)")
            }
        }
    }

    func receive(_ list: DeviceList) {
        devices = list.devices
        devicesSite = list.site
        devicesReason = list.reason
        devicesUnsupported = false
        devicesLoaded = true
    }

    /// Issues a token for a phone and returns the link to draw as a QR
    /// code, or nil with `devicesError` set.
    func pairPhone() async -> URL? {
        guard let client else {
            devicesError = "Not connected to the runner."
            return nil
        }
        do {
            let pairing = try await client.devicesPair(kind: .phone, name: "iPhone")
            devicesError = nil
            loadDevices()
            guard let link = pairing.pairingLink else {
                devicesError = "The runner gave no pairing link back."
                return nil
            }
            return link
        } catch {
            devicesError = error.localizedDescription
            // Only that it failed: the reply would have held the token.
            AppLog.write("rpc", "devices.pair (phone) failed: \(error.localizedDescription)")
            return nil
        }
    }

    /// Issues a token for the default browser and opens the website in it,
    /// signed in. True once the browser has the link.
    @discardableResult
    func openWebsiteSignedIn() async -> Bool {
        guard let client else {
            devicesError = "Not connected to the runner."
            return false
        }
        let browser = DefaultBrowser.current()
        do {
            let pairing = try await client.devicesPair(kind: .browser, name: browser?.name ?? "Browser")
            devicesError = nil
            loadDevices()
            guard let link = pairing.signInLink else {
                devicesError = "The runner gave no sign-in link back."
                return false
            }
            // The default browser, found before the token was issued so the
            // name on the token matches where the link goes.
            if let browser {
                OpenGate.openWeb(link, withApplicationAt: browser.url)
            } else {
                OpenGate.openWeb(link)
            }
            return true
        } catch {
            devicesError = error.localizedDescription
            AppLog.write("rpc", "devices.pair (browser) failed: \(error.localizedDescription)")
            return false
        }
    }

    /// Signs the phone or browser out: its next request fails and it shows
    /// its pairing screen.
    func revoke(_ device: Device) {
        guard let client else { return devicesError = "Not connected to the runner." }
        devices.removeAll { $0.id == device.id }
        Task {
            do {
                receive(try await client.devicesRevoke(device.id))
                devicesError = nil
            } catch {
                devicesError = error.localizedDescription
                AppLog.write("rpc", "devices.revoke failed: \(error.localizedDescription)")
                loadDevices()
            }
        }
    }
}

/// The browser that opens https links on this Mac, for naming its token
/// ("Chrome", "Safari") and for opening the sign-in link in it.
enum DefaultBrowser {
    struct App: Equatable {
        var url: URL
        var name: String
    }

    static func current() -> App? {
        guard let url = NSWorkspace.shared.urlForApplication(toOpen: URL(string: "https://example.com")!) else { return nil }
        let bundle = Bundle(url: url)
        let raw = (bundle?.object(forInfoDictionaryKey: "CFBundleDisplayName") as? String)
            ?? (bundle?.object(forInfoDictionaryKey: "CFBundleName") as? String)
            ?? url.deletingPathExtension().lastPathComponent
        return App(url: url, name: shortName(raw))
    }

    /// "Google Chrome" is Chrome to everyone; the rest keep their names.
    static func shortName(_ name: String) -> String {
        let trimmed = name.trimmingCharacters(in: .whitespaces)
        if trimmed.hasPrefix("Google ") { return String(trimmed.dropFirst("Google ".count)) }
        return trimmed.isEmpty ? "Browser" : trimmed
    }
}
