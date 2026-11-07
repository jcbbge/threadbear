import XCTest
@testable import ThreadbearCore

final class SettingsTests: XCTestCase {
    func testSettingsDecodeFullAndTolerateUnknownFields() throws {
        // An older runner's OpenRouter fields (key, budget, spend) are ignored.
        let json = """
        {"defaultCwd":"/Users/m/dev/me/misc","idleMinutes":45,"maxLiveCLIs":4,"followMain":false,"somethingNew":1,
         "models":{"openRouterKey":{"set":true,"hint":"a1b2","extra":true},"dailyBudgetUsd":2.5,"spentTodayUsd":0.0123,
                   "spentMonthUsd":0.4,"privateFolders":["~/dev/client",3,"/tmp/x"],"later":{}}}
        """
        let settings = try JSONDecoder().decode(RunnerSettings.self, from: Data(json.utf8))
        XCTAssertEqual(settings.defaultCwd, "/Users/m/dev/me/misc")
        XCTAssertEqual(settings.idleMinutes, 45)
        XCTAssertEqual(settings.maxLiveCLIs, 4)
        XCTAssertFalse(settings.followMain)
        XCTAssertEqual(settings.models.privateFolders, ["~/dev/client", "/tmp/x"], "a folder that isn't a string is skipped")
        XCTAssertFalse(settings.models.poolSupported, "an older runner sends no pool")
        XCTAssertNil(settings.models.pool)
    }

    func testPoolDecodesAsAnIdOrNull() throws {
        let on = try JSONDecoder().decode(RunnerSettings.self, from: Data(#"{"models":{"pool":"claude"}}"#.utf8))
        XCTAssertTrue(on.models.poolSupported)
        XCTAssertEqual(on.models.pool, "claude")
        let off = try JSONDecoder().decode(RunnerSettings.self, from: Data(#"{"models":{"pool":null}}"#.utf8))
        XCTAssertTrue(off.models.poolSupported, "null is no pool, from a runner that knows pools")
        XCTAssertNil(off.models.pool)
    }

    func testEmptySettingsTakeTheDefaults() throws {
        let settings = try JSONDecoder().decode(RunnerSettings.self, from: Data(#"{"models":{"openRouterKey":{"hint":""}}}"#.utf8))
        XCTAssertEqual(settings, RunnerSettings(), "an older runner's key field is ignored")
    }

    func testUpdateSendsOnlyWhatChanged() {
        XCTAssertEqual(SettingsUpdate(idleMinutes: 20).params, ["idleMinutes": .number(20)])
        XCTAssertEqual(SettingsUpdate(followMain: false, pool: "claude").params,
                       ["followMain": .bool(false), "models": .object(["pool": .string("claude")])])
        XCTAssertEqual(SettingsUpdate(privateFolders: []).params, ["models": .object(["privateFolders": .array([])])],
                       "an empty list clears the folders, so it's still sent")
        XCTAssertEqual(SettingsUpdate(pool: "convex").params, ["models": .object(["pool": .string("convex")])])
        XCTAssertEqual(SettingsUpdate(pool: .some(nil)).params, ["models": .object(["pool": .null])],
                       "no pool is sent as null")
        XCTAssertEqual(SettingsUpdate().params, [:])
    }

    func testBringInDecodesAsDaysOrAWord() throws {
        func decode(_ json: String) throws -> RunnerSettings { try JSONDecoder().decode(RunnerSettings.self, from: Data(json.utf8)) }
        XCTAssertEqual(try decode(#"{"bringIn":3}"#).bringIn, .every(3))
        XCTAssertEqual(try decode(#"{"bringIn":"important"}"#).bringIn, .important)
        XCTAssertEqual(try decode(#"{"bringIn":"off"}"#).bringIn, .off)
        XCTAssertTrue(try decode(#"{"bringIn":"off"}"#).bringInSupported)
        XCTAssertEqual(try decode(#"{"bringIn":"weekly"}"#).bringIn, .standard, "a word it doesn't know is the default")
        XCTAssertFalse(try decode("{}").bringInSupported, "an older runner sends none")
        XCTAssertEqual(SettingsUpdate(bringIn: .every(7)).params, ["bringIn": .number(7)])
        XCTAssertEqual(SettingsUpdate(bringIn: .off).params, ["bringIn": .string("off")])
    }

    func testBringInChoicesKeepACustomNumber() {
        XCTAssertEqual(SettingsText.bringInChoices(current: .standard).map(\.title),
                       ["Every day", "Every 3 days", "Every 5 days", "Every week", "Every 2 weeks", "Only important ones", "Never"])
        XCTAssertEqual(SettingsText.bringInChoices(current: .every(10)).map(\.title)[4], "Every 10 days")
    }

    func testSettingsUpdatedNotification() async throws {
        let transport = FakeTransport()
        let client = RPCClient(transport: transport)
        try await client.start()
        transport.push(E.json(["jsonrpc": "2.0", "method": "settings.updated",
                               "params": ["settings": ["idleMinutes": 10, "models": ["pool": "convex"]]]]))
        var iterator = client.notifications.makeAsyncIterator()
        guard case .settingsUpdated(let settings)? = await iterator.next() else { return XCTFail("no settings.updated") }
        XCTAssertEqual(settings.idleMinutes, 10)
        XCTAssertEqual(settings.models.pool, "convex")
    }
}

final class SettingsTextTests: XCTestCase {
    func testFolder() {
        XCTAssertEqual(SettingsText.folder("/Users/m/dev/x", home: "/Users/m"), "~/dev/x")
        XCTAssertEqual(SettingsText.folder("/Users/m", home: "/Users/m"), "~")
        XCTAssertEqual(SettingsText.folder("/Users/mo/dev", home: "/Users/m"), "/Users/mo/dev", "a sibling home isn't inside it")
        XCTAssertEqual(SettingsText.folder("~/already", home: "/Users/m"), "~/already")
    }
}
