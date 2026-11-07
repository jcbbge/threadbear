import Foundation
import Testing
@testable import ThreadbearKit

@Suite struct NewThreadChoicesTests {
    @Test func accountsDecodeWithAndWithoutModels() throws {
        let json = #"""
        [{"id":"claude-3","provider":"claude","title":"three@example.com","usage":{"windows":[],"readAt":"x","source":"live"},
          "models":[{"id":"opus","title":"Opus 5.5","effortLevels":["low","high","max"]}],"defaultEffort":"high"},
         {"id":"codex-main","provider":"codex","title":"Codex · me"}]
        """#
        let accounts = try JSONDecoder().decode([PhoneAccount].self, from: Data(json.utf8))
        #expect(accounts.map(\.id) == ["claude-3", "codex-main"])
        #expect(accounts[0].models == [PhoneModelChoice(id: "opus", title: "Opus 5.5", effortLevels: ["low", "high", "max"])])
        #expect(accounts[1].models.isEmpty)
    }

    @Test func modelsComeClaudeFirstAndOnceEach() {
        let accounts = [
            PhoneAccount(id: "codex-main", provider: "codex", title: "C", models: [PhoneModelChoice(id: "astra", title: "Astra")]),
            PhoneAccount(id: "claude-1", provider: "claude", title: "1", models: [PhoneModelChoice(id: "opus", title: "Opus"), PhoneModelChoice(id: "haiku", title: "Haiku")]),
            PhoneAccount(id: "claude-2", provider: "claude", title: "2", models: [PhoneModelChoice(id: "opus", title: "Opus")]),
        ]
        #expect(NewThreadChoices.models(accounts).map(\.id) == ["opus", "haiku", "astra"])
    }

    @Test func effortsFollowTheModel() {
        let codex = PhoneModelChoice(id: "astra", title: "Astra", effortLevels: ["low", "medium", "ultra", "weird"])
        #expect(NewThreadChoices.efforts(for: codex) == ["low", "medium", "ultra"])
        #expect(NewThreadChoices.efforts(for: nil) == ["low", "medium", "high", "xhigh", "max"])
        #expect(NewThreadChoices.keeps(effort: "ultra", model: codex))
        #expect(!NewThreadChoices.keeps(effort: "ultra", model: nil))
        #expect(NewThreadChoices.keeps(effort: nil, model: nil))
        #expect(NewThreadChoices.effortTitle("xhigh") == "Extra high")
    }

    /// The Mac asleep on 6 Nov left the phone with nowhere to start a thread:
    /// the picker starts on the first runner online in Mike's order.
    @Test func runnerIsTheFirstOnlineInOrder() {
        let now = Date(timeIntervalSince1970: 1_000_000)
        let asleep = PhoneRunner(runnerId: "m5", name: "M5", lastSeenAt: now.addingTimeInterval(-600), placed: true, main: true)
        let draining = PhoneRunner(runnerId: "tinker", name: "Tinker", lastSeenAt: now, draining: true, placed: true)
        let bruce = PhoneRunner(runnerId: "bruce", name: "Bruce", lastSeenAt: now, placed: true)
        #expect(NewThreadChoices.runner([asleep, draining, bruce], now: now)?.runnerId == "bruce")
        #expect(NewThreadChoices.runner([bruce, asleep], now: now)?.runnerId == "bruce")
        // None online: the first, to wait for.
        #expect(NewThreadChoices.runner([asleep, draining], now: now)?.runnerId == "m5")
        #expect(NewThreadChoices.runner([], now: now) == nil)
    }

    /// A Mac with a runner key only gets Mike's words when he's put it in his
    /// order (Codex's review): with no order, the main Mac, asleep or not.
    @Test func anUnplacedRunnerIsNeverPickedForHim() {
        let now = Date(timeIntervalSince1970: 1_000_000)
        let asleep = PhoneRunner(runnerId: "m5", name: "M5", lastSeenAt: now.addingTimeInterval(-600), main: true)
        let bruce = PhoneRunner(runnerId: "bruce", name: "Bruce", lastSeenAt: now)
        #expect(NewThreadChoices.runner([bruce, asleep], now: now)?.runnerId == "m5")
        // No main Mac known: nothing picked, so the backend decides.
        #expect(NewThreadChoices.runner([bruce, PhoneRunner(runnerId: "m5", name: "M5", lastSeenAt: now)], now: now) == nil)
    }

    @Test func modelsFollowTheRunner() {
        let accounts = [
            PhoneAccount(id: "claude-m5", runnerId: "m5", provider: "claude", title: "1", models: [PhoneModelChoice(id: "opus", title: "Opus")]),
            PhoneAccount(id: "codex-bruce", runnerId: "bruce", provider: "codex", title: "C", models: [PhoneModelChoice(id: "astra", title: "Astra")]),
        ]
        #expect(NewThreadChoices.models(accounts, runnerId: "bruce").map(\.id) == ["astra"])
        #expect(NewThreadChoices.models(accounts, runnerId: nil).map(\.id) == ["opus", "astra"])
        // A runner with no logins mirrored yet offers none, rather than another Mac's.
        #expect(NewThreadChoices.models(accounts, runnerId: "cloud").isEmpty)
    }

    @Test func fakeKeepsTheOrderItsGiven() async throws {
        let backend = FakeBackend(turnDelay: .zero, runners: true)
        try await backend.setRunnerOrder(["cloud", "mac"])
        var stream = backend.runners().makeAsyncIterator()
        let runners = try await stream.next()
        #expect(runners?.map(\.runnerId) == ["cloud", "mac", "mini"])
    }
}
