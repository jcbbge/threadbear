import Foundation
import Testing
@testable import ThreadbearKit

/// Every pairing link waits for a yes, paired or not (Daybreak finding 5:
/// an expired token left the phone unpaired, and a link then replaced the
/// saved server, token and runner keys without asking).
@MainActor @Suite struct PairingRequestTests {
    static let macKey = "pOCSkrZRwni5dyxWn1+puxPZBrRqtoyd+dwrRAn4ogk="
    static let otherKey = Data(repeating: 9, count: 32).base64EncodedString()
    static let old = Pairing(deploymentURL: URL(string: "https://happy-bear-123.convex.cloud")!, token: "tb_expired")

    static func link(host: String, token: String = "tb_new", key: String? = nil) -> URL {
        Pairing(deploymentURL: URL(string: "https://\(host)")!, token: token, runnerKeys: key.map { ["mac": $0] } ?? [:]).link
    }

    /// What the app keeps, as plain values, to see that asking and
    /// cancelling never touch them.
    final class Saved {
        var pairing: Pairing?
        var stores: [String: MemoryRunnerKeyStore] = [:]
        func keys(_ p: Pairing) -> any RunnerKeyStore {
            let host = p.deploymentURL.host()!
            if let s = stores[host] { return s }
            let s = MemoryRunnerKeyStore()
            stores[host] = s
            return s
        }
    }

    /// The finding's first test: the old token is expired (the phone shows
    /// the pair screen, `isPaired` is false), and a link from outside still
    /// asks before anything changes, naming the new server and the key change.
    @Test func aLinkAfterTheTokenExpiredIsAskedAbout() {
        let saved = Saved()
        saved.pairing = Self.old
        let oldStore = MemoryRunnerKeyStore(["mac": Self.macKey])
        saved.stores["happy-bear-123.convex.cloud"] = oldStore
        let gate = PairingGate()
        let url = Self.link(host: "evil-fox-9.convex.cloud", key: Self.otherKey)
        #expect(.asking == gate.ask(url, allowLocal: false, current: saved.pairing, keys: saved.keys))
        let request = try! #require(gate.pending)
        #expect(request.title == "Pair with evil-fox-9.convex.cloud?")
        #expect(request.message.contains("from happy-bear-123.convex.cloud to evil-fox-9.convex.cloud"))
        #expect(request.addedKeys == 1)
        #expect(request.message.contains("adds 1 Mac"))
        // Asking saved nothing: the old pairing and its keys are as they were,
        // and the new server's store is still empty.
        #expect(saved.pairing == Self.old)
        #expect(oldStore.key(for: "mac") == Self.macKey)
        #expect(saved.stores["evil-fox-9.convex.cloud"]?.key(for: "mac") == nil)
    }

    /// The first pairing is asked about too.
    /// Two self-hosted backends on one Mac differ only by port: a link to
    /// the other one says it moves the phone, naming both with their ports.
    @Test func anotherPortIsAnotherServer() throws {
        let current = Pairing(deploymentURL: URL(string: "https://mac.tail1.ts.net:3210")!, token: "tb_old")
        let link = Self.link(host: "mac.tail1.ts.net:8443")
        let request = try #require(PairingRequest(link: link, allowLocal: false, current: current, keys: { _ in MemoryRunnerKeyStore() }))
        #expect(request.replacesHost == "mac.tail1.ts.net:3210")
        #expect(!request.samePairedServer)
        #expect(request.title == "Pair with mac.tail1.ts.net:8443?")
        // A cloud address has no port, so it's named as it always was.
        #expect(Pairing.serverName(URL(string: "https://happy-bear-123.convex.cloud")!) == "happy-bear-123.convex.cloud")
        // Nor does one saved with a port, or the simulator's local backend: their Keychain names stay as they were.
        #expect(Pairing.serverName(URL(string: "https://happy-bear-123.convex.cloud:443")!) == "happy-bear-123.convex.cloud")
        #expect(Pairing.serverName(URL(string: "http://127.0.0.1:3210")!) == "127.0.0.1")
    }

    @Test func theFirstPairingIsAskedAbout() throws {
        let gate = PairingGate()
        let saved = Saved()
        #expect(.asking == gate.ask(Self.link(host: "happy-bear-123.convex.cloud", key: Self.macKey), allowLocal: false, current: nil, keys: saved.keys))
        let request = try #require(gate.pending)
        #expect(request.message.hasPrefix("This link pairs the phone with the server at happy-bear-123.convex.cloud."))
        #expect(request.replacesHost == nil)
    }

    /// The finding's second test: Cancel keeps the old server, token and keys,
    /// and leaves nothing to pair with afterwards.
    @Test func cancelKeepsTheOldPairingAndKeys() throws {
        let saved = Saved()
        saved.pairing = Self.old
        let store = MemoryRunnerKeyStore(["mac": Self.macKey])
        saved.stores["happy-bear-123.convex.cloud"] = store
        let gate = PairingGate()
        // Same server, a new token and a different key for the same Mac.
        let url = Self.link(host: "happy-bear-123.convex.cloud", token: "tb_attacker", key: Self.otherKey)
        #expect(.asking == gate.ask(url, allowLocal: false, current: saved.pairing, keys: saved.keys))
        #expect(gate.pending?.changedKeys == 1)
        #expect(gate.pending?.message.contains("new token for happy-bear-123.convex.cloud") == true)
        #expect(gate.pending?.message.contains("changes the key of 1 Mac") == true)
        let shown = try #require(gate.pending)
        gate.cancel()
        #expect(gate.pending == nil)
        var paired = false
        #expect(gate.accept(shown) { _ in paired = true } == nil)
        #expect(!paired)
        #expect(saved.pairing == Self.old)
        #expect(saved.pairing?.token == "tb_expired")
        #expect(store.key(for: "mac") == Self.macKey)
    }

    /// Codex's P1: tapping Pair dismisses the alert, whose binding cancels
    /// the gate straight after the button's action. The yes is taken in the
    /// action itself, so it still pairs, with the link that was shown, once.
    @Test func yesPairsEvenThoughTheAlertCancelsAfterIt() async throws {
        let gate = PairingGate()
        let url = Self.link(host: "happy-bear-123.convex.cloud")
        gate.ask(url, allowLocal: false, current: nil, keys: Saved().keys)
        let shown = try #require(gate.pending)
        var paired: [URL] = []
        let task = gate.accept(shown) { paired.append($0.link) }
        gate.cancel() // the alert going away
        await task?.value
        #expect(paired == [url])
        #expect(gate.accept(shown) { paired.append($0.link) } == nil)
        #expect(paired == [url])
    }

    /// Codex's P2: a second link while the first is on screen is turned
    /// away, never swapped in under the yes Mike gives the first.
    @Test func aSecondLinkWhileAskingIsTurnedAway() async throws {
        let gate = PairingGate()
        let first = Self.link(host: "happy-bear-123.convex.cloud")
        gate.ask(first, allowLocal: false, current: nil, keys: Saved().keys)
        let shown = try #require(gate.pending)
        #expect(.busy == gate.ask(Self.link(host: "evil-fox-9.convex.cloud", key: Self.otherKey), allowLocal: false, current: nil, keys: Saved().keys))
        #expect(gate.pending?.id == shown.id)
        var paired: [URL] = []
        await gate.accept(shown) { paired.append($0.link) }?.value
        #expect(paired == [first])
    }

    /// A yes for a request that isn't the one waiting (the same link opened
    /// again makes a new request) pairs nothing.
    @Test func aYesForAnotherRequestPairsNothing() throws {
        let gate = PairingGate()
        let url = Self.link(host: "happy-bear-123.convex.cloud")
        let stale = try #require(PairingRequest(link: url, allowLocal: false, current: nil, keys: Saved().keys))
        gate.ask(url, allowLocal: false, current: nil, keys: Saved().keys)
        var paired = false
        #expect(gate.accept(stale) { _ in paired = true } == nil)
        #expect(!paired)
        #expect(gate.pending != nil)
    }

    @Test func sameKeysSaySo() throws {
        let saved = Saved()
        saved.stores["happy-bear-123.convex.cloud"] = MemoryRunnerKeyStore(["mac": Self.macKey])
        let request = try #require(PairingRequest(link: Self.link(host: "happy-bear-123.convex.cloud", key: Self.macKey),
                                                  allowLocal: false, current: Self.old, keys: saved.keys))
        #expect(!request.changesKeys)
        #expect(request.message.contains("stay the same"))
    }

    @Test func notAPairingLinkIsntHeld() {
        let gate = PairingGate()
        #expect(.notPairing == gate.ask(URL(string: "threadbear://pair?url=https://evil.example.com&token=t")!, allowLocal: false, current: nil, keys: Saved().keys))
        #expect(gate.pending == nil)
    }
}
