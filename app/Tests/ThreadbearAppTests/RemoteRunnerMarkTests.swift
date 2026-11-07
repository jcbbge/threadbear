import XCTest
import ThreadbearCore
@testable import Threadbear

/// Another runner's thread stays that runner's when its own summary is
/// stored over it: markSeen's reply, a rename's or an archive's never carry
/// the app's runnerId marker. Losing it sent the next calls to this Mac's
/// runner ("Thread not found") and dropped that runner's live events, which
/// is what Mike saw opening a thread on bruce on 30 Oct.
@MainActor
final class RemoteRunnerMarkTests: XCTestCase {
    func testAReplyStoredOverARemoteThreadKeepsItsRunner() {
        let app = AppModel()
        var remote = ThreadSummary(id: "t1", title: "Hello from Bruce", status: .idle)
        remote.runnerId = "r-bruce"
        app.threads["t1"] = remote
        app.threads["local"] = ThreadSummary(id: "local", title: "This Mac's", status: .idle)

        // As the runner sends it back: no runnerId.
        app.threads["t1"] = ThreadSummary(id: "t1", title: "Hello from Bruce", status: .running)
        XCTAssertEqual(app.threads["t1"]?.runnerId, "r-bruce")
        XCTAssertEqual(app.threads["t1"]?.status, .running, "the rest of the reply is kept")

        // This Mac's own threads never gain one.
        app.threads["local"] = ThreadSummary(id: "local", title: "Renamed", status: .idle)
        XCTAssertNil(app.threads["local"]?.runnerId)

        // Gone is gone.
        app.threads["t1"] = nil
        XCTAssertNil(app.threads["t1"])
    }

    /// The sidebar's table never says if another runner's thread is shared,
    /// so the link a share made from here stays through its refreshes
    /// (and through replies that come without one, markSeen's, a rename's).
    func testALinkMadeHereOutlivesTheTablesRowsAndReplies() {
        let app = AppModel()
        var remote = ThreadSummary(id: "t1", title: "On bruce", status: .idle)
        remote.runnerId = "r-bruce"
        remote.share = ThreadShare(access: .link, slug: "abc")
        app.threads["t1"] = remote

        var row = ThreadSummary(id: "t1", title: "On bruce", status: .running)
        row.runnerId = "r-bruce"
        app.threads["t1"] = row
        XCTAssertEqual(app.threads["t1"]?.share, ThreadShare(access: .link, slug: "abc"))
        XCTAssertEqual(app.threads["t1"]?.status, .running)

        // A reply that says it's off now is taken.
        var off = row
        off.share = ThreadShare(access: .off, slug: "abc")
        app.threads["t1"] = off
        XCTAssertEqual(app.threads["t1"]?.share?.access, .off)

        // This Mac's own threads go by what their runner says.
        var local = ThreadSummary(id: "local", title: "Here", status: .idle)
        local.share = ThreadShare(access: .link, slug: "xyz")
        app.threads["local"] = local
        app.threads["local"] = ThreadSummary(id: "local", title: "Here", status: .idle)
        XCTAssertNil(app.threads["local"]?.share)
    }
}

/// The composer's pickers on another runner's thread offer that runner's
/// logins, from its connection's hello, not this Mac's.
@MainActor
final class RemoteLoginsTests: XCTestCase {
    func testAThreadsPickersUseItsRunnersLogins() {
        let app = AppModel()
        app.accounts = [Account(id: "claude-main", provider: "claude", title: "mine@example.com"), Account(id: "claude-3", provider: "claude", title: "other@example.com")]
        var remote = ThreadSummary(id: "t1", title: "On bruce", status: .idle)
        remote.runnerId = "r-bruce"
        let local = ThreadSummary(id: "t2", title: "Here", status: .idle)

        XCTAssertNil(app.logins(for: remote), "nothing to offer before bruce has said hello")
        XCTAssertEqual(app.logins(for: local)?.accounts.map(\.id), ["claude-main", "claude-3"])
        XCTAssertEqual(app.logins(for: nil)?.accounts.count, 2, "a new thread is this Mac's")

        app.remoteLogins["r-bruce"] = RunnerLogins(accounts: [Account(id: "codex-main", provider: "codex", title: "Codex")], pools: [], defaults: app.defaults)
        XCTAssertEqual(app.logins(for: remote)?.accounts.map(\.id), ["codex-main"])
        XCTAssertEqual(ThreadSettings(app: app, thread: remote).accountSections.flatMap(\.items).map(\.id), ["codex-main"])
    }
}

/// A thread read through Convex takes its asks from the card its open
/// transcript shows, whatever summary is stored over it: the table's row
/// and the relay's replies (markSeen's) carry none, and the card's buttons
/// did nothing without them (6 Nov). With no transcript open there's no
/// card, so none; this Mac's own threads keep what their runner says.
@MainActor
final class RelayCardSummaryTests: XCTestCase {
    func testARelayedSummaryTakesItsAsksFromTheCardShown() {
        let app = AppModel()
        app.directRemoteLink = false
        let ask = Ask(action: "Start the spike?", options: ["Start the spike", "Not yet"])
        var remote = ThreadSummary(id: "t1", title: "On Hetzner", status: .idle, needs: "you", asks: [ask], asksSeq: 4)
        remote.runnerId = "r-cloud"
        app.threads["t1"] = remote
        XCTAssertEqual(app.threads["t1"]?.asks, [], "no transcript open, so no card to answer")
        XCTAssertNil(app.threads["t1"]?.asksSeq)
        XCTAssertEqual(app.threads["t1"]?.runnerId, "r-cloud")

        app.threads["local"] = ThreadSummary(id: "local", title: "Here", status: .idle, needs: "you", asks: [ask], asksSeq: 4)
        XCTAssertEqual(app.threads["local"]?.asksSeq, 4)
        XCTAssertTrue(Decisions.isOpen(app.threads["local"]!))
    }
}
