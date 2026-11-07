import Foundation

/// What the rail's updates icon and its popover say about the app's own
/// update (AppUpdater: a build of main staged, building, or failed) and the
/// runner's (protocol "Runner updates"). Plain sentences, one per thing
/// going on; the view adds the buttons.
public enum UpdatesText {
    /// The app's side, as AppUpdater knows it.
    public struct AppSide: Sendable, Equatable {
        public var running: String?   // short commit of the running build
        public var staged: String?    // short commit waiting to be swapped in
        public var building: Bool
        public var failed: Bool

        public init(running: String? = nil, staged: String? = nil, building: Bool = false, failed: Bool = false) {
            self.running = running
            self.staged = staged
            self.building = building
            self.failed = failed
        }

        public var isPending: Bool { staged != nil || building }
    }

    /// Something on its way, or something that went wrong, for the app or
    /// the runner: the icon's grey dot. The icon itself is always there
    /// since the CLIs' versions moved into its panel (28 Oct).
    public static func shown(app: AppSide, runner: RunnerUpdates?) -> Bool {
        app.isPending || app.failed || runner?.isPending == true || runner?.failed == true || fromMike(runner)
    }

    /// A release of Mike's this copy's main doesn't have yet (protocol
    /// "Mike's releases").
    public static func fromMike(_ runner: RunnerUpdates?) -> Bool {
        runner?.upstream?.available == true
    }

    /// A CLI with a new version, held back, updating, or whose update
    /// failed: also a grey dot, and a line in the tooltip.
    public static func cliPending(_ cli: CliStatus) -> Bool {
        cli.status == "behind" || cli.status == "held" || cli.status == "missing" || ["waiting", "running", "failed"].contains(cli.update?.state ?? "")
    }

    /// The icon's tooltip: "Updates", then a line for each thing going on
    /// (what `tooltip(app:runner:)` says, then each CLI that isn't up to
    /// date), or that everything is. The panel has the rest.
    public static func iconTooltip(app: AppSide, runner: RunnerUpdates?, clis: [CliStatus]) -> String {
        var lines: [String] = []
        if app.isPending || app.failed || runner?.isPending == true || runner?.failed == true { lines.append(tooltip(app: app, runner: runner)) }
        if let line = upstreamTooltip(runner?.upstream) { lines.append(line) }
        for cli in clis where cliPending(cli) {
            lines.append(CliText.bannerText(cli) ?? CliText.statusLine(cli))
        }
        if lines.isEmpty { lines.append("Everything is up to date") }
        return (["Updates"] + lines).joined(separator: "\n")
    }

    /// Whether it wants Mike: a launch.mjs only he can install. Everything
    /// else happens by itself, a failed build included: it tries again once
    /// main is fixed, and fixing main is a thread's job, not his. The icon
    /// gets a grey dot for those instead of the accent one (27 Oct, Mike:
    /// "the blue dot usually indicates there's something for me to action").
    /// New changes from Mike want him too: they only come in when he says
    /// (docs/setup-and-updates.md 2.3, "Ask by default", 29 Oct).
    public static func needsYou(app: AppSide, runner: RunnerUpdates?) -> Bool {
        runner?.launcherChanged == true || fromMike(runner)
    }

    /// "12 new changes from Mike", for the icon's tooltip.
    public static func upstreamTooltip(_ u: RunnerUpdates.Upstream?) -> String? {
        guard let u, u.available, let r = u.release else { return nil }
        return r.changes == 1 ? "1 new change from Mike" : "\(r.changes) new changes from Mike"
    }

    /// The panel's From Mike section: what's new, that it's up to date, or
    /// why it can't tell. Nil when there's nothing to say (no upstream).
    public static func upstreamLine(_ u: RunnerUpdates.Upstream?) -> String? {
        guard let u else { return nil }
        // Held comes first: it's the one that wants something doing (a red
        // build on main), and the last tag is still in tb status.
        if let why = u.heldWhy, u.state == "off" { return "Your next release for everyone else is waiting: \(why)." }
        if let tag = u.publishedTag, u.state == "off" { return "Your last release for everyone else is \(tag)." }
        switch u.state {
        case "available":
            guard let r = u.release else { return nil }
            let what = r.changes == 1 ? "1 new change" : "\(r.changes) new changes"
            return "Mike's release \(releaseDate(r.tag)) has \(what)."
        case "idle":
            return u.release.map { "You're up to date with Mike's release \(releaseDate($0.tag))." } ?? "Mike hasn't made a release yet."
        case "checking":
            return "Checking for Mike's releases."
        case "failed":
            return "Couldn't check for Mike's releases\(u.reason.map { ": \($0)" } ?? ".")"
        default:
            return nil
        }
    }

    /// What the From Mike section lists under a release: the plain-words
    /// notes Mike's runner wrote, a heading per release when there's more
    /// than one, or (from older tags) the first commit subjects.
    public static func releaseLines(_ r: RunnerUpdates.Upstream.Release) -> [(heading: String?, lines: [String])] {
        guard !r.notes.isEmpty else { return [(nil, Array(r.subjects.prefix(5)))] }
        if r.notes.count == 1, r.notes[0].tag == r.tag { return [(nil, r.notes[0].lines)] }
        var groups = r.notes.map { note in
            let date = releaseDate(note.tag)
            return (heading: Optional(date.hasPrefix("of ") ? String(date.dropFirst(3)) : date), lines: note.lines)
        }
        // An older runner may supply notes only for older tags. Keep those
        // dated, and show the subjects so the newest changes remain visible.
        if !r.notes.contains(where: { $0.tag == r.tag }), !r.subjects.isEmpty {
            groups.append((heading: "Every change", lines: Array(r.subjects.prefix(5))))
        }
        return groups
    }

    /// "release/2026-10-30" as "of 30 Oct".
    public static func releaseDate(_ tag: String) -> String {
        let date = tag.hasPrefix("release/") ? String(tag.dropFirst("release/".count)) : tag
        let parts = date.split(separator: "-").compactMap { Int($0) }
        let months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]
        guard parts.count == 3, (1...12).contains(parts[1]) else { return tag }
        return "of \(parts[2]) \(months[parts[1] - 1])"
    }

    /// The first message of the thread Bring them in starts.
    public static func bringInPrompt(_ r: RunnerUpdates.Upstream.Release) -> String {
        "Bring in Mike's release \(r.tag) (\(r.changes) new change\(r.changes == 1 ? "" : "s")) to this copy of Threadbear.\(commitLine(r)) Follow docs/bringing-in-updates.md, and ask me before it lands."
    }

    /// The commit the runner checked the release's signature for, so the
    /// thread merges that and not a ref a later fetch could have moved.
    static func commitLine(_ r: RunnerUpdates.Upstream.Release, merge: Bool = true) -> String {
        guard let c = r.commit, c.range(of: "^[0-9a-f]{40}([0-9a-f]{24})?$", options: .regularExpression) != nil else { return "" }
        return merge ? " Merge its commit \(c), the one its signature was checked for." : " Its commit is \(c), the one its signature was checked for."
    }

    /// Let's Discuss: the same release, talked through before anything
    /// changes (Mike, 4 Nov 2026), for someone who wants to know what it
    /// does to their own changes first.
    public static func discussPrompt(_ r: RunnerUpdates.Upstream.Release) -> String {
        "Mike's release \(r.tag) has \(r.changes) new change\(r.changes == 1 ? "" : "s") for this copy of Threadbear. Before bringing any of it in, talk me through it: what's in it that I'd notice, anything that touches or clashes with the changes I've made in this copy, and anything risky. Section 1 of docs/bringing-in-updates.md says how to see both sides.\(commitLine(r, merge: false)) Don't change anything yet; once we've talked it over, I'll say whether to bring it in, and then follow that doc."
    }

    /// The icon's tooltip. A failure is said, as it shares the grey dot
    /// with an update on its way.
    public static func tooltip(app: AppSide, runner: RunnerUpdates?) -> String {
        let appPart = app.isPending || app.failed
        let runnerPart = runner?.isPending == true || runner?.failed == true
        let appFailed = app.failed && !app.isPending
        let runnerFailed = runner?.failed == true && runner?.isPending != true
        if appFailed && runnerFailed { return "The app's and the runner's updates failed" }
        if appFailed && !runnerPart { return "The app's update failed" }
        if runnerFailed && !appPart { return "The runner's update failed" }
        switch (appPart, runnerPart) {
        case (true, true): return "Updates for the app and the runner"
        case (true, false): return "An app update"
        case (false, true): return "A runner update"
        default: return "Updates"
        }
    }

    public static func appLine(_ a: AppSide) -> String {
        if let staged = a.staged { return "The app's next version (\(staged)) is ready. It switches in when you're not using the app, or now." }
        if a.building { return "Building the app from main." }
        if a.failed { return "The app's last build from main failed. The log says why." }
        return a.running.map { "The app is up to date (\($0))." } ?? "The app is up to date."
    }

    /// The right-click popover's one line, about the app alone: the panel
    /// has the rest. The view puts Restart to Update or Show the Log under
    /// it, and the staged commit in the button's tooltip.
    public static func popoverLine(_ a: AppSide) -> String {
        if a.staged != nil { return "A new version of the app is ready." }
        if a.building { return "Building the app's next version." }
        if a.failed { return "The app's last build failed." }
        return appLine(a)
    }

    /// The runner's own build: building, built and starting, or failed.
    public static func buildLine(_ u: RunnerUpdates) -> String? {
        let at = u.commit.map { " at \($0)" } ?? ""
        let what = u.subject.map { ": \($0)" } ?? ""
        switch u.state {
        case "building": return "Building the runner from main\(at)\(what)."
        case "waiting": return "The runner from main\(at) is built and starting."
        case "failed": return "The runner couldn't update to main\(at)\(u.reason.map { ": \($0)" } ?? ".")"
        default: return nil
        }
    }

    /// Threads still finishing on an old runner; the view links each one
    /// under it.
    public static func oldRunnersLine(_ u: RunnerUpdates) -> String? {
        let threads = u.oldRunners.reduce(0) { $0 + $1.threads.count }
        if threads == 0 { return nil }
        return threads == 1
            ? "1 thread is finishing its turn on the previous version. It moves to the new one when the turn ends."
            : "\(threads) threads are finishing their turns on the previous version. Each moves to the new one when its turn ends."
    }

    /// A LaunchAgent only install-runner.sh brings up to date (launch.mjs,
    /// the plist, Threadbear Runner.app); the view shows the command under
    /// it. An older runner sends no reason, and then it was launch.mjs.
    public static func launcherLine(_ u: RunnerUpdates) -> String? {
        guard u.launcherChanged else { return nil }
        let why = u.launcherReason ?? "launch.mjs has changed on main."
        return "\(why) It only updates when you run this, once nothing is busy:"
    }

    /// Every runner line in order, or the one that says there's nothing.
    public static func runnerLines(_ u: RunnerUpdates?) -> [String] {
        guard let u else { return ["This runner doesn't say how its updates are going."] }
        let out = [buildLine(u), oldRunnersLine(u), launcherLine(u)].compactMap { $0 }
        return out.isEmpty ? ["The runner is up to date."] : out
    }

    /// The command for a changed launch.mjs.
    public static func installCommand(checkout: String?) -> String {
        // An older runner doesn't say where its checkout is: the README's
        // `gh repo fork --clone` puts it in ~/threadbear from the home folder.
        let root = checkout.map { ($0 as NSString).abbreviatingWithTildeInPath } ?? "~/threadbear"
        return "\(root)/runner/scripts/install-runner.sh"
    }
}
