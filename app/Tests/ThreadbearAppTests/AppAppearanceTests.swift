import AppKit
import XCTest
@testable import Threadbear

final class AppAppearanceTests: XCTestCase {
    private func defaults() -> UserDefaults {
        let name = "AppAppearanceTests.\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: name)!
        addTeardownBlock { defaults.removePersistentDomain(forName: name) }
        return defaults
    }

    func testNothingSavedFollowsTheMac() {
        XCTAssertEqual(AppAppearance.saved(defaults()), .system)
        XCTAssertNil(AppAppearance.system.nsAppearance)
    }

    func testSavedChoiceIsRead() {
        let defaults = defaults()
        defaults.set("dark", forKey: AppAppearance.key)
        XCTAssertEqual(AppAppearance.saved(defaults), .dark)
        defaults.set("light", forKey: AppAppearance.key)
        XCTAssertEqual(AppAppearance.saved(defaults), .light)
    }

    func testUnknownValueFollowsTheMac() {
        let defaults = defaults()
        defaults.set("purple", forKey: AppAppearance.key)
        XCTAssertEqual(AppAppearance.saved(defaults), .system)
    }

    func testLightAndDarkPickTheirAppearances() {
        XCTAssertEqual(AppAppearance.light.nsAppearance?.name, .aqua)
        XCTAssertEqual(AppAppearance.dark.nsAppearance?.name, .darkAqua)
    }
}
