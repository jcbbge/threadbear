import XCTest
@testable import ThreadbearCore

/// The rail's updates icon and popover (UpdatesText), and the protocol bits
/// they read: hello's `updates`, `runner.updates` and `onOldRunner`.
final class UpdatesTextTests: XCTestCase {
    typealias Side = UpdatesText.AppSide

    func testShownOnlyWhileSomethingIsOnItsWayOrWentWrong() {
        let idle = RunnerUpdates(state: "idle")
        XCTAssertFalse(UpdatesText.shown(app: Side(running: "abc1234"), runner: idle))
        XCTAssertFalse(UpdatesText.shown(app: Side(), runner: nil), "an older runner says nothing")
        XCTAssertFalse(UpdatesText.shown(app: Side(), runner: RunnerUpdates(state: "checking")))
        XCTAssertTrue(UpdatesText.shown(app: Side(staged: "def5678"), runner: idle))
        XCTAssertTrue(UpdatesText.shown(app: Side(building: true), runner: idle))
        XCTAssertTrue(UpdatesText.shown(app: Side(), runner: RunnerUpdates(state: "building")))
        XCTAssertTrue(UpdatesText.shown(app: Side(), runner: RunnerUpdates(oldRunners: [.init(version: "old", threads: ["t1"])])))
        XCTAssertTrue(UpdatesText.shown(app: Side(), runner: RunnerUpdates(launcherChanged: true)))
        XCTAssertTrue(UpdatesText.shown(app: Side(), runner: RunnerUpdates(state: "failed", reason: "tests failed")))
    }

    func testOnlyALaunchMjsNeedsMike() {
        XCTAssertFalse(UpdatesText.needsYou(app: Side(staged: "def5678"), runner: RunnerUpdates(state: "building")))
        XCTAssertFalse(UpdatesText.needsYou(app: Side(), runner: RunnerUpdates(oldRunners: [.init(version: "old", threads: ["t1"])])))
        // A failed build tries again once main is fixed, so it's not his to do.
        XCTAssertFalse(UpdatesText.needsYou(app: Side(failed: true), runner: nil))
        XCTAssertFalse(UpdatesText.needsYou(app: Side(staged: "def5678"), runner: RunnerUpdates(state: "failed")))
        XCTAssertTrue(UpdatesText.needsYou(app: Side(), runner: RunnerUpdates(launcherChanged: true)))
    }

    func testTooltipNamesWhichSide() {
        XCTAssertEqual(UpdatesText.tooltip(app: Side(staged: "a"), runner: RunnerUpdates(state: "building")), "Updates for the app and the runner")
        XCTAssertEqual(UpdatesText.tooltip(app: Side(staged: "a"), runner: RunnerUpdates()), "An app update")
        XCTAssertEqual(UpdatesText.tooltip(app: Side(), runner: RunnerUpdates(state: "waiting")), "A runner update")
        XCTAssertEqual(UpdatesText.tooltip(app: Side(), runner: RunnerUpdates(state: "failed")), "The runner's update failed")
        XCTAssertEqual(UpdatesText.tooltip(app: Side(failed: true), runner: nil), "The app's update failed")
        XCTAssertEqual(UpdatesText.tooltip(app: Side(failed: true), runner: RunnerUpdates(state: "failed")), "The app's and the runner's updates failed")
        XCTAssertEqual(UpdatesText.tooltip(app: Side(staged: "a"), runner: RunnerUpdates(state: "failed")), "Updates for the app and the runner")
    }

    func testLines() {
        XCTAssertEqual(UpdatesText.appLine(Side(running: "abc1234", staged: "def5678")),
                       "The app's next version (def5678) is ready. It switches in when you're not using the app, or now.")
        XCTAssertEqual(UpdatesText.appLine(Side(running: "abc1234")), "The app is up to date (abc1234).")
        XCTAssertEqual(UpdatesText.runnerLines(RunnerUpdates(state: "building", commit: "c131089", subject: "Handovers")),
                       ["Building the runner from main at c131089: Handovers."])
        XCTAssertEqual(UpdatesText.runnerLines(RunnerUpdates(state: "idle", oldRunners: [.init(version: "old", threads: ["t1", "t2"])], launcherChanged: true)), [
            "2 threads are finishing their turns on the previous version. Each moves to the new one when its turn ends.",
            "launch.mjs has changed on main. It only updates when you run this, once nothing is busy:",
        ])
        XCTAssertEqual(UpdatesText.runnerLines(RunnerUpdates(state: "idle", launcherChanged: true, launcherReason: "Threadbear Runner.app was built from older launcher sources than main's.")), [
            "Threadbear Runner.app was built from older launcher sources than main's. It only updates when you run this, once nothing is busy:",
        ])
        XCTAssertEqual(UpdatesText.runnerLines(RunnerUpdates(state: "idle")), ["The runner is up to date."])
        XCTAssertEqual(UpdatesText.installCommand(checkout: NSHomeDirectory() + "/dev/me/threadbear"), "~/dev/me/threadbear/runner/scripts/install-runner.sh")
        // Plain words: no em dashes.
        for line in UpdatesText.runnerLines(RunnerUpdates(state: "failed", commit: "a", reason: "x", oldRunners: [.init(version: "o", threads: ["t"])], launcherChanged: true)) {
            XCTAssertFalse(line.contains("\u{2014}"), line)
        }
    }

    func testPopoverLineIsAboutTheAppAlone() {
        XCTAssertEqual(UpdatesText.popoverLine(Side(running: "abc1234", staged: "def5678")), "A new version of the app is ready.")
        // A build of a newer main can start with one staged; the staged one
        // is still what Restart to Update takes.
        XCTAssertEqual(UpdatesText.popoverLine(Side(running: "abc1234", staged: "def5678", building: true)), "A new version of the app is ready.")
        XCTAssertEqual(UpdatesText.popoverLine(Side(running: "abc1234", building: true)), "Building the app's next version.")
        XCTAssertEqual(UpdatesText.popoverLine(Side(running: "abc1234", failed: true)), "The app's last build failed.")
        XCTAssertEqual(UpdatesText.popoverLine(Side(running: "abc1234")), "The app is up to date (abc1234).")
        XCTAssertEqual(UpdatesText.popoverLine(Side()), "The app is up to date.", "a debug app follows nothing")
    }

    func testHelloUpdatesAndOnOldRunnerDecode() throws {
        let hello = try JSONDecoder().decode(HelloResult.self, from: Data("""
        {"runnerVersion":"0.1.0+r","protocol":1,"accounts":[],"defaults":{"cwd":"/tmp","accountId":"claude-3"},
         "updates":{"state":"waiting","commit":"c131089","oldRunners":[{"version":"0.1.0+old","threads":["t1"]},{"broken":1}],"launcherChanged":true,"future":2}}
        """.utf8))
        XCTAssertEqual(hello.updates?.state, "waiting")
        XCTAssertEqual(hello.updates?.oldRunners.map(\.threads), [["t1"], []])
        XCTAssertEqual(hello.updates?.launcherChanged, true)
        XCTAssertNil(hello.updates?.launcherReason)
        XCTAssertEqual(hello.updates?.isPending, true)
        let older = try JSONDecoder().decode(HelloResult.self, from: Data(#"{"runnerVersion":"x","accounts":[],"defaults":{"cwd":"/","accountId":"a"}}"#.utf8))
        XCTAssertNil(older.updates)
        let thread = try JSONDecoder().decode(ThreadSummary.self, from: Data(#"{"id":"t1","title":"x","onOldRunner":true}"#.utf8))
        XCTAssertTrue(thread.onOldRunner)
        let again = try JSONDecoder().decode(ThreadSummary.self, from: JSONEncoder().encode(thread))
        XCTAssertTrue(again.onOldRunner)
    }

    func testRunnerUpdatesNotification() async throws {
        let transport = FakeTransport()
        let client = RPCClient(transport: transport)
        try await client.start()
        transport.push(E.json(["jsonrpc": "2.0", "method": "runner.updates", "params": ["updates": ["state": "building", "commit": "abc1234"]]]))
        var iterator = client.notifications.makeAsyncIterator()
        guard case .runnerUpdates(let updates)? = await iterator.next() else { return XCTFail("no runner.updates") }
        XCTAssertEqual(updates.state, "building")
        XCTAssertEqual(updates.commit, "abc1234")
        XCTAssertEqual(updates.oldRunners, [])
    }

    // Mike's releases (protocol "Mike's releases"): a blue dot, as they only
    // come in when he says.
    func testANewReleaseFromMikeNeedsYou() throws {
        let json = #"{"state":"idle","oldRunners":[],"upstream":{"state":"available","checkout":"/Users/x/threadbear","release":{"tag":"release/2026-10-30","commit":"abc","changes":12,"subjects":["Third","Second"]}}}"#
        let updates = try JSONDecoder().decode(RunnerUpdates.self, from: Data(json.utf8))
        XCTAssertEqual(updates.upstream?.checkout, "/Users/x/threadbear")
        XCTAssertEqual(updates.upstream?.release?.subjects, ["Third", "Second"])
        XCTAssertTrue(UpdatesText.shown(app: Side(), runner: updates))
        XCTAssertTrue(UpdatesText.needsYou(app: Side(), runner: updates))
        XCTAssertEqual(UpdatesText.iconTooltip(app: Side(), runner: updates, clis: []), "Updates\n12 new changes from Mike")
        XCTAssertEqual(UpdatesText.upstreamLine(updates.upstream), "Mike's release of 30 Oct has 12 new changes.")
        XCTAssertTrue(UpdatesText.bringInPrompt(updates.upstream!.release!).contains("docs/bringing-in-updates.md"))
        // The verified commit goes in the prompt, so the thread merges that
        // and not a ref a later fetch could move (Gautam's scan, F31).
        let sha = String(repeating: "a", count: 40)
        let verified = RunnerUpdates.Upstream.Release(tag: "release/2026-10-30", commit: sha, changes: 2)
        XCTAssertTrue(UpdatesText.bringInPrompt(verified).contains("Merge its commit \(sha)"))
        XCTAssertTrue(UpdatesText.discussPrompt(verified).contains(sha))
        XCTAssertFalse(UpdatesText.bringInPrompt(updates.upstream!.release!).contains("Merge its commit"), "not an id")
        let discuss = UpdatesText.discussPrompt(updates.upstream!.release!)
        XCTAssertTrue(discuss.contains("release/2026-10-30 has 12 new changes"))
        XCTAssertTrue(discuss.contains("Don't change anything yet"))

        let upToDate = RunnerUpdates(upstream: .init(state: "idle", release: .init(tag: "release/2026-10-30", changes: 0)))
        XCTAssertFalse(UpdatesText.needsYou(app: Side(), runner: upToDate))
        XCTAssertFalse(UpdatesText.shown(app: Side(), runner: upToDate))
        XCTAssertEqual(UpdatesText.upstreamLine(upToDate.upstream), "You're up to date with Mike's release of 30 Oct.")
        // Mike's own copy says what it last tagged, and nothing else.
        let mikes = try JSONDecoder().decode(RunnerUpdates.self, from: Data(#"{"state":"idle","upstream":{"state":"off","reason":"upstream is this repo","published":{"tag":"release/2026-10-30","at":"x"}}}"#.utf8))
        XCTAssertEqual(UpdatesText.upstreamLine(mikes.upstream), "Your last release for everyone else is release/2026-10-30.")
        XCTAssertFalse(UpdatesText.needsYou(app: Side(), runner: mikes))
        // Unless GitHub's checks are holding today's back: then it says why.
        let held = try JSONDecoder().decode(RunnerUpdates.self, from: Data(#"{"state":"idle","upstream":{"state":"off","published":{"tag":"release/2026-10-30","at":"x"},"held":{"commit":"abc","why":"\"Builds on Xcode 26\" didn't pass on it","at":"x"}}}"#.utf8))
        XCTAssertEqual(UpdatesText.upstreamLine(held.upstream), #"Your next release for everyone else is waiting: "Builds on Xcode 26" didn't pass on it."#)
        XCTAssertNil(UpdatesText.upstreamLine(nil))
    }

    func testReleaseLinesPreferMikesNotes() throws {
        let json = #"{"tag":"release/2026-11-06","changes":40,"subjects":["Convex I/O: round 5"],"notes":[{"tag":"release/2026-11-06","lines":["Search finds goals again"]},{"tag":"release/2026-11-05","lines":["Private card for keys"]},{"tag":"x","lines":[]}]}"#
        let r = try JSONDecoder().decode(RunnerUpdates.Upstream.Release.self, from: Data(json.utf8))
        XCTAssertEqual(r.notes.count, 2, "a release with no lines is dropped")
        let groups = UpdatesText.releaseLines(r)
        XCTAssertEqual(groups.map(\.heading), ["6 Nov", "5 Nov"])
        XCTAssertEqual(groups.map(\.lines), [["Search finds goals again"], ["Private card for keys"]])
        let one = RunnerUpdates.Upstream.Release(tag: "release/2026-11-06", changes: 3, subjects: ["a"], notes: [.init(tag: "release/2026-11-06", lines: ["b"])])
        XCTAssertNil(UpdatesText.releaseLines(one)[0].heading)
        let older = RunnerUpdates.Upstream.Release(tag: "release/2026-11-07", changes: 3, subjects: ["new work"], notes: one.notes)
        XCTAssertEqual(UpdatesText.releaseLines(older)[0].heading, "6 Nov")
        XCTAssertEqual(UpdatesText.releaseLines(older).last?.lines, ["new work"])
        let odd = RunnerUpdates.Upstream.Release(tag: "release/2026-13-01", changes: 3, notes: [.init(tag: "release/2026-13-01", lines: ["one"]), .init(tag: "release/2026-11-06", lines: ["two"])])
        XCTAssertEqual(UpdatesText.releaseLines(odd)[0].heading, "release/2026-13-01")
        let old = RunnerUpdates.Upstream.Release(tag: "release/2026-11-01", changes: 9, subjects: (1...9).map(String.init))
        XCTAssertEqual(UpdatesText.releaseLines(old).first?.lines, ["1", "2", "3", "4", "5"], "older tags: the first subjects")
    }
}
