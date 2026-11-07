import AppKit

/// Light or dark for Threadbear alone, whatever the Mac is set to: the
/// Settings picker (General > Appearance), kept in UserDefaults. System,
/// the default, follows the Mac. A scripted run's `--appearance` (the
/// screenshot tooling) is applied after this, so it still wins.
enum AppAppearance: String, CaseIterable, Identifiable {
    case system, light, dark

    /// The Settings picker's key in UserDefaults.
    static let key = "appearance"

    var id: String { rawValue }

    var title: String {
        switch self {
        case .system: "Same as the Mac"
        case .light: "Light"
        case .dark: "Dark"
        }
    }

    /// What NSApp.appearance is set to: nil follows the Mac.
    var nsAppearance: NSAppearance? {
        switch self {
        case .system: nil
        case .light: NSAppearance(named: .aqua)
        case .dark: NSAppearance(named: .darkAqua)
        }
    }

    /// The saved choice; anything unknown or missing is System.
    static func saved(_ defaults: UserDefaults = .standard) -> AppAppearance {
        defaults.string(forKey: key).flatMap(AppAppearance.init(rawValue:)) ?? .system
    }

    @MainActor
    func apply() {
        NSApp.appearance = nsAppearance
    }
}
