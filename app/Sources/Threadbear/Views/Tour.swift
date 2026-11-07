import AppKit
import BearDock
import SwiftUI
import ThreadbearCore

/// The parts of the window the tour points at. Each is tagged where it's
/// drawn (`tourTarget`), so the tour finds it wherever Mike's dock has put
/// it, and skips it when it isn't on screen at all.
enum TourTarget: Hashable {
    case threads
    case composer
    /// The chips above the composer, from the thread's patches.
    case actionChips
    /// The Highlights panel, or its icon on the rail when the panel's
    /// closed.
    case highlights
    case highlightsRail
    /// The main panel, bar and all: something to drag when Highlights
    /// isn't open.
    case mainPanel
    /// The icons down the window's left edge.
    case activityBar
    /// A sample thread's row in the list, by its title.
    case sampleRow(String)
    /// A sample row's hover buttons (hibernate and archive), while drawn.
    case rowButtons
    /// A panel of the activity bar's (usage, updates, connectors), for its
    /// first-open intro.
    case panel(String)
    /// Finish setting up's panel, opened when the first thread's sent.
    case setupPanel

    /// A panel Mike may have closed: a step pointing only at these is left
    /// out when none of them is on screen as the tour starts. The rest turn
    /// up as it goes (the samples' rows, the composer, the chips).
    var mayBeClosed: Bool {
        switch self {
        case .threads, .highlights, .highlightsRail, .activityBar: true
        default: false
        }
    }
}

/// The pages and panels with a one-card intro the first time they open,
/// and `pools`, the first time a pool has a second login to move to.
enum TourIntro: String, CaseIterable {
    case scheduled, projects, librarian, usage, updates, connectors, pools

    /// The intro for a sidebar view, if it has one.
    static func of(_ mode: SidebarMode) -> TourIntro? {
        switch mode {
        case .scheduled: .scheduled
        case .projects: .projects
        case .librarian: .librarian
        default: nil
        }
    }
}

/// Which side of what it points at the tour's card goes, in the order
/// they're tried.
enum TourEdge {
    case right, left, below, above
}

/// Something the tour has them do rather than read about. Moving a panel
/// and pressing a patch's button were hands-on too, until Mike found the
/// tour simpler with them told rather than done (2 Nov).
enum TourTask: Equatable {
    /// Send the first thread, its message written for them; sending it
    /// ends the tour.
    case sendFirst
}

struct TourStep: Equatable {
    /// Empty for the welcome, which sits in the middle of the window with
    /// nothing lit up.
    var targets: [TourTarget] = []
    let title: String
    let body: String
    var task: TourTask? = nil
    /// What the card says once the task's done.
    var doneBody: String? = nil
    /// What it says instead when the first thread failed (a login that's
    /// run out, say): "while it works" would be wrong.
    var failBody: String? = nil
    var edges: [TourEdge] = [.right, .left, .below, .above]
    /// The bear on the card.
    var bear: Bear.Pose? = nil
    /// Opens the sample that needs you first, for a composer, Highlights
    /// and the example patch's chip to point at.
    var opensSample = false
    /// The sample whose row is drawn hovered, buttons showing, by title.
    var hovers: String? = nil
    /// The docs page its ⓘ opens (threadbear.mikecann.app/docs/<doc>), one
    /// of site/app-doc-slugs.json: the detail a one-sentence card leaves out.
    var doc: String? = nil
}

/// A short, hands-on look round the window for someone new: the window
/// dims and each step lights up one part of it with a card beside it, and
/// some have you do the thing (move a
/// panel, press a patch's chip, send your first thread). It starts by
/// itself the first time the app connects to its runner, with no Skip
/// then, and Help > Take the Tour runs it again, skippable.
///
/// So there's something to try things on before they've run anything, it
/// asks the runner for a few sample threads (`threads.samples`, made up
/// and finished, no turn) in ~/ThreadbearThreads/Welcome, where it writes an
/// example patch, and removes them when it ends however it ends (Mike,
/// 29 Oct). The first real thread is theirs to send.
///
/// Copy: notifications are played down and never the reason to pair the
/// phone; the phone is for asking and steering while you're out (Mike,
/// 29 Oct).
@MainActor
@Observable
final class Tour {
    static let shared = Tour()
    static let seenKey = "tourSeen"
    static let docsSite = "https://threadbear.mikecann.app/docs"
    /// The tour's last step writes this in the new-thread composer.
    static let firstMessage = "Make me a patch for this folder that adds a button saying hello, then tell me what you did."
    /// Next turns up on a hands-on step after this long, in case the drag
    /// or the click won't take.
    static let patience: Duration = .seconds(20)

    /// One short sentence a card, and a step per idea (Mike, 29 Oct: the
    /// first cut's cards were too much to read). TourTests holds them to it.
    static let steps: [TourStep] = [
        TourStep(title: "Welcome to Threadbear", body: "A quick look round, with a few sample threads to try things on.", bear: .wave),
        TourStep(targets: [.threads], title: "Threads", body: "Everything your agents are working on is listed here.", doc: "threads"),
        // Shown on a sample's row rather than pressed: pressing them was
        // a chore, and "it comes back by itself" read as a riddle (Mike, 30 Oct).
        TourStep(targets: [.rowButtons, .sampleRow("Plan the weekend"), .threads], title: "Star or put away",
                 body: "Hover a thread: star it to keep it on top, or put it away with the moon or the box.",
                 hovers: "Plan the weekend", doc: "hibernate-and-archive"),
        TourStep(targets: [.activityBar], title: "Your views",
                 body: "These icons switch to schedules, projects and the librarian.", doc: "threads"),
        // No card for Full access / Ask before edits: people know access
        // modes from other agent apps, and the chip says it (Mike, 30 Oct).
        TourStep(targets: [.highlights, .highlightsRail], title: "Highlights",
                 body: "The files, links and questions from a thread collect here.",
                 opensSample: true, doc: "highlights"),
        TourStep(targets: [.highlights, .mainPanel], title: "Move a panel",
                 body: "Press and hold a panel, then drag it to move it, or onto another to make tabs.",
                 opensSample: true, doc: "panels"),
        TourStep(targets: [.actionChips], title: "Patches",
                 body: "Patches add buttons like these, and panels; ask any thread to make you one.",
                 edges: [.above, .right, .left, .below], opensSample: true, doc: "patches"),
        TourStep(targets: [.actionChips], title: "Per project or tool",
                 body: "Each patch belongs to a project, or to a tool wherever you use it.",
                 edges: [.above, .right, .left, .below], opensSample: true, doc: "patches"),
        TourStep(targets: [.composer], title: "Your first thread",
                 body: "We've written its first message, so press Return to send it.",
                 task: .sendFirst, edges: [.above, .below, .right, .left], doc: "first-thread"),
        TourStep(targets: [.setupPanel], title: "Finish setting up",
                 body: "While it works, pair your phone here to check in from anywhere.",
                 failBody: "Your first thread hit a snag, and its message says how to fix it.", doc: "finish-setting-up"),
    ]

    /// A page's or panel's own one-card intro, shown the first time it's
    /// opened rather than in the tour, which stays short (Mike, 2 Nov).
    static let intros: [TourIntro: TourStep] = [
        .scheduled: TourStep(targets: [.mainPanel], title: "Scheduled",
                             body: "Schedules send a message at a set time, once or on repeat, to a thread or a new one.",
                             doc: "schedules"),
        .projects: TourStep(targets: [.mainPanel], title: "Projects",
                            body: "Projects group threads by what they're for, with goals and where each is up to.",
                            doc: "projects"),
        .librarian: TourStep(targets: [.mainPanel], title: "The librarian",
                             body: "The librarian uses Haiku on your Claude login to file threads into projects.",
                             doc: "librarian"),
        .usage: TourStep(targets: [.panel("usage")], title: "Usage",
                         body: "How much room each of your logins has left before it hits its limits.",
                         doc: "accounts"),
        .updates: TourStep(targets: [.panel("updates")], title: "Updates",
                           body: "What's on its way for the app, the runner and the agents' tools.",
                           doc: "changing-threadbear"),
        .connectors: TourStep(targets: [.panel("connectors")], title: "Connectors",
                              body: "The services your agents can use, and whether each is signed in.",
                              doc: "connectors"),
        // Nothing in the first run mentions pools: with one login there's
        // nothing for one to do. A second login is when they start to
        // matter, and nothing else would tell you (Mike, 5 Nov).
        .pools: TourStep(targets: [.composer], title: "Pools",
                         body: "A thread moves to another login in its pool when the one it's on nears its limit.",
                         doc: "accounts"),
    ]
    static func introKey(_ intro: TourIntro) -> String { "tourIntro.\(intro.rawValue)" }
    /// Off in scripted runs (screenshots, perf, a dev app) so a page they
    /// open isn't covered; the automation's `tour` turns it on.
    @ObservationIgnored var introsEnabled = true
    /// The card on show is a page's intro, not the tour.
    private(set) var isIntro: TourIntro?

    /// The step on show, as an index into `shown`; nil when the tour's
    /// not running.
    private(set) var step: Int?
    /// The steps this run shows: the ones whose part of the window was on
    /// screen when it started, and the hands-on ones, which bring their
    /// part up themselves.
    private(set) var shown: [TourStep] = []
    /// False the first time, when it started by itself: no Skip then
    /// (Mike, 29 Oct). Help's replay can be skipped.
    private(set) var skippable = true
    /// The step's task is done.
    private(set) var taskDone = false
    /// Where each tagged part of the window is, in the window's content
    /// (RootView's `Tour.space`).
    var frames: [TourTarget: CGRect] = [:]
    @ObservationIgnored var framesFrom: [TourTarget: UUID] = [:]
    /// The sample threads this run asked the runner for, in its order.
    private(set) var sampleIds: [String] = []
    @ObservationIgnored var defaults: UserDefaults = .standard
    /// Set at launch (AppDelegate). Tests leave it nil, so stepping
    /// through touches nothing.
    @ObservationIgnored weak var app: AppModel?
    @ObservationIgnored private var threadsAtStart: Set<String> = []
    /// The first thread the tour had them send.
    private(set) var firstThreadId: String?

    static let space = "tour"

    var current: TourStep? { step.map { shown[$0] } }
    /// The first thread they sent has failed.
    var firstThreadFailed: Bool { firstThreadId.flatMap { app?.threads[$0] }?.status == .error }
    var isLast: Bool { step == shown.count - 1 }

    /// Where the step's part of the window is, or nil to put the card in
    /// the middle.
    func frame(for step: TourStep) -> CGRect? {
        step.targets.lazy.compactMap { self.frames[$0] }.first { $0.width > 1 && $0.height > 1 }
    }

    /// The first time the app has connected on this Mac.
    func startIfNew() {
        guard !defaults.bool(forKey: Self.seenKey), step == nil else { return }
        start(skippable: false)
    }

    func start(skippable: Bool = true) {
        self.skippable = skippable
        if let app {
            Task { sampleIds = await app.makeTourSamples() }
        }
        shown = Self.steps.filter { step in
            step.task != nil || step.targets.contains { !$0.mayBeClosed } || step.targets.isEmpty || frame(for: step) != nil
        }
        go(to: 0)
        // The composer has the keyboard on a new thread: Return is the
        // tour's while it's up, not a send or an empty line.
        NSApp?.mainWindow?.makeFirstResponder(nil)
    }

    func next() {
        guard let step else { return }
        if step + 1 < shown.count { go(to: step + 1) } else { finish() }
    }

    func back() {
        guard let step, step > 0 else { return }
        go(to: step - 1)
    }

    /// A page's or panel's intro, the first time it's opened (RootView
    /// watches the sidebar's view and the panels). Not while the tour or
    /// another intro is up.
    func introduce(_ intro: TourIntro?) {
        guard introsEnabled, step == nil, let intro, let card = Self.intros[intro], !defaults.bool(forKey: Self.introKey(intro)) else { return }
        isIntro = intro
        skippable = true
        shown = [card]
        step = 0
        taskDone = false
    }

    /// The pools intro, once a pool has a second login. Not before the
    /// first-run tour's been seen: the pools arrive with the runner's
    /// hello, just ahead of the tour, which wouldn't start under it. Someone
    /// who already had two logins then sees it on a later launch.
    func introducePools(_ pools: [Pool]) {
        guard defaults.bool(forKey: Self.seenKey), pools.contains(where: { $0.accountIds.count >= 2 }) else { return }
        introduce(.pools)
    }

    /// Done or skipped: either way it doesn't come up by itself again, and
    /// the samples go.
    func finish() {
        if let intro = isIntro {
            // An intro: once seen, never again; nothing else to undo.
            step = nil
            isIntro = nil
            defaults.set(true, forKey: Self.introKey(intro))
            return
        }
        step = nil
        app?.hoverOverride = nil
        defaults.set(true, forKey: Self.seenKey)
        if let app, !sampleIds.isEmpty { app.removeTourSamples() }
        sampleIds = []
    }

    private func go(to index: Int) {
        step = index
        taskDone = false
        guard let app else { return }
        if shown[index].opensSample { app.openTourSample(sampleIds) }
        // The row's hover buttons, drawn without the pointer (as the
        // screenshot run does); nil puts the row back.
        app.hoverOverride = shown[index].hovers.flatMap { title in sampleIds.first { app.threads[$0]?.title == title } }
        guard let task = shown[index].task else { return }
        switch task {
        case .sendFirst:
            threadsAtStart = Set(app.threads.keys)
            app.newThread()
            app.drafts["new"] = Draft(text: Self.firstMessage)
            app.focusRequests["new", default: 0] += 1
        }
    }

    /// Whether the step's task has been done, as the window changes
    /// (TourOverlay calls it).
    func check() {
        guard let app, let task = current?.task, !taskDone else { return }
        switch task {
        case .sendFirst:
            if let id = app.threads.keys.first(where: { !threadsAtStart.contains($0) }) {
                firstThreadId = id
                // On to what's left while the thread works: the last card,
                // or the end if there's nothing left to set up.
                if app.setupShowsIcon {
                    app.setupShown = true
                    next()
                } else {
                    finish()
                }
            }
        }
    }

    /// Where the card goes: beside `target` on the first of `edges` with
    /// room for it, else in the middle of `bounds`. Kept `margin` in from
    /// the window's edges.
    nonisolated static func cardOrigin(target: CGRect?, card: CGSize, bounds: CGRect, edges: [TourEdge],
                                       gap: CGFloat = 14, margin: CGFloat = 12) -> CGPoint {
        cardPlacement(target: target, card: card, bounds: bounds, edges: edges, gap: gap, margin: margin).origin
    }

    /// The card's place, and the side of the target it went on (nil in the
    /// middle), for its arrow.
    nonisolated static func cardPlacement(target: CGRect?, card: CGSize, bounds: CGRect, edges: [TourEdge],
                                          gap: CGFloat = 14, margin: CGFloat = 12) -> (origin: CGPoint, edge: TourEdge?) {
        let centred = (origin: CGPoint(x: bounds.midX - card.width / 2, y: bounds.midY - card.height / 2), edge: TourEdge?.none)
        guard let target else { return centred }
        func clampX(_ x: CGFloat) -> CGFloat { min(max(x, bounds.minX + margin), bounds.maxX - margin - card.width) }
        func clampY(_ y: CGFloat) -> CGFloat { min(max(y, bounds.minY + margin), bounds.maxY - margin - card.height) }
        for edge in edges {
            switch edge {
            case .right where target.maxX + gap + card.width <= bounds.maxX - margin:
                return (CGPoint(x: target.maxX + gap, y: clampY(target.midY - card.height / 2)), edge)
            case .left where target.minX - gap - card.width >= bounds.minX + margin:
                return (CGPoint(x: target.minX - gap - card.width, y: clampY(target.midY - card.height / 2)), edge)
            case .below where target.maxY + gap + card.height <= bounds.maxY - margin:
                return (CGPoint(x: clampX(target.midX - card.width / 2), y: target.maxY + gap), edge)
            case .above where target.minY - gap - card.height >= bounds.minY + margin:
                return (CGPoint(x: clampX(target.midX - card.width / 2), y: target.minY - gap - card.height), edge)
            default:
                continue
            }
        }
        return centred
    }
}

// MARK: - The samples' folder and its patch

extension Tour {
    /// ~/ThreadbearThreads/Welcome: Threadbear's own folder, nowhere macOS asks
    /// about. A scripted dev app keeps it in its own data folder, away from
    /// the real one.
    @MainActor
    static func welcomeFolder(app: AppModel) -> String {
        #if DEBUG
        if Automation.instanceId != nil { return app.dataDir.appendingPathComponent("Welcome").path }
        #endif
        return NSString(string: "~/ThreadbearThreads/Welcome").expandingTildeInPath
    }

}

extension AppModel {
    /// The tour's sample threads, made (or found) in the Welcome folder
    /// with its example patch. Empty when the runner can't make them (one
    /// from before `threads.samples`): the tour goes on without.
    func makeTourSamples() async -> [String] {
        let folder = Tour.welcomeFolder(app: self)
        guard let client else { return [] }
        do {
            // The runner makes the folder and its example patch, and trusts
            // that patch, so Roll a die shows without asking.
            let samples = try await client.samples(cwd: folder)
            for thread in samples { threads[thread.id] = thread }
            return samples.map(\.id)
        } catch {
            AppLog.write("rpc", "threads.samples failed: \(error.localizedDescription)")
            return []
        }
    }

    /// Opens the first sample still in the inbox (the one that needs you,
    /// unless it's been put away), for a step about the open thread.
    func openTourSample(_ ids: [String]) {
        let now = Date()
        guard let id = ids.first(where: { threads[$0].map { !$0.isArchived && !$0.isSnoozed(at: now) } ?? false }) else { return }
        sidebarMode = .inbox
        select(id)
    }

    /// Deletes the samples, archived and hibernating ones too. The runner
    /// says each is gone, which takes it off the list.
    func removeTourSamples() {
        guard let client else { return }
        let folder = Tour.welcomeFolder(app: self)
        Task {
            do {
                try await client.samples(cwd: folder, remove: true)
            } catch {
                AppLog.write("rpc", "removing the tour's samples failed: \(error.localizedDescription)")
            }
        }
    }
}

// MARK: - Drawing it

extension View {
    /// Marks this view as the part of the window a tour step points at.
    /// `withBar` for a dock panel's content: the spotlight takes in the
    /// panel's bar above it too, so it reads as the whole panel.
    /// `when` false leaves it untagged (a row that isn't a sample's).
    func tourTarget(_ target: TourTarget, withBar: Bool = false, when active: Bool = true) -> some View {
        modifier(TourTargetModifier(target: target, bar: withBar ? RootView.options.headerHeight : 0, active: active))
    }
}

private struct TourTargetModifier: ViewModifier {
    let target: TourTarget
    let bar: CGFloat
    let active: Bool
    /// Which view last said where the target is. A panel moved in the dock
    /// is drawn afresh: the new view says where it is before the old one
    /// disappears, so only the one that last said may clear it.
    @State private var me = UUID()

    @ViewBuilder
    func body(content: Content) -> some View {
        if !active {
            content
        } else {
            tagged(content)
        }
    }

    private func tagged(_ content: Content) -> some View {
        content
            .onGeometryChange(for: CGRect.self) { $0.frame(in: .named(Tour.space)) } action: { frame in
                Tour.shared.frames[target] = CGRect(x: frame.minX, y: frame.minY - bar, width: frame.width, height: frame.height + bar)
                Tour.shared.framesFrom[target] = me
            }
            // A closed panel's frame would leave the tour lighting up
            // whatever took its place.
            .onDisappear {
                guard Tour.shared.framesFrom[target] == me else { return }
                Tour.shared.frames[target] = nil
            }
    }
}

/// What a hands-on step watches for.
private struct TourProgress: Equatable {
    var threadCount: Int
}

/// The dimmed window with the step's part cut out of it, and the card.
/// Over RootView, in its `Tour.space`.
struct TourOverlay: View {
    @Environment(AppModel.self) private var app
    @Environment(\.colorScheme) private var colorScheme
    @State private var cardSize = CGSize(width: 300, height: 160)

    var body: some View {
        let tour = Tour.shared
        if let index = tour.step, let step = tour.current {
            GeometryReader { geometry in
                let bounds = CGRect(origin: .zero, size: geometry.size)
                let target = tour.frame(for: step)
                // A few points round it, and never past the window's edge.
                let hole = target.map { $0.insetBy(dx: -4, dy: -4).intersection(bounds) }
                let placed = Tour.cardPlacement(target: hole, card: cardSize, bounds: bounds, edges: step.edges)
                let origin = placed.origin
                let shape = Spotlight(hole: hole ?? CGRect(x: bounds.midX, y: bounds.midY, width: 0, height: 0))
                ZStack(alignment: .topLeading) {
                    shape
                        // Darker in dark mode, where 0.4 barely showed
                        // against the dark panels.
                        .fill(Color.black.opacity(colorScheme == .dark ? 0.55 : 0.35), style: FillStyle(eoFill: true))
                        // Clicks on the window behind wait until the
                        // tour's done, except in the lit part of a
                        // hands-on step (the composer).
                        .contentShape(step.task == nil ? AnyShape(Rectangle()) : AnyShape(shape), eoFill: step.task != nil)
                        .onTapGesture {}
                    if let hole {
                        // A soft glow round the lit part, so the eye goes
                        // there (Mike, 30 Oct: the card alone didn't say
                        // what it meant).
                        TourGlow()
                            .frame(width: hole.width, height: hole.height)
                            .offset(x: hole.minX, y: hole.minY)
                            .allowsHitTesting(false)
                            .id(index)
                    }
                    TourCard(step: step, index: index, count: tour.shown.count)
                        .onGeometryChange(for: CGSize.self) { $0.size } action: { cardSize = $0 }
                        .offset(x: origin.x, y: origin.y)
                    // And an arrow from the card to it, on the card's side
                    // that faces it.
                    if let hole, let edge = placed.edge {
                        TourArrow(edge: edge, at: TourArrow.anchor(edge: edge, card: CGRect(origin: origin, size: cardSize), target: hole))
                            .fill(Color(nsColor: .windowBackgroundColor))
                            .frame(width: bounds.width, height: bounds.height)
                            .allowsHitTesting(false)
                    }
                }
                .animation(Juice.reduceMotion ? nil : .snappy(duration: 0.3), value: index)
                .animation(Juice.reduceMotion ? nil : .snappy(duration: 0.3), value: hole)
            }
            .transition(.opacity)
            .onChange(of: TourProgress(threadCount: app.threads.count)) {
                tour.check()
            }
        }
    }
}

/// The lit part's outline: the accent, glowing softly in and out (still
/// with Reduce Motion).
private struct TourGlow: View {
    @State private var bright = false

    var body: some View {
        RoundedRectangle(cornerRadius: Spotlight.corner)
            .strokeBorder(Color.accentColor, lineWidth: 2)
            .shadow(color: Color.accentColor.opacity(bright ? 0.9 : 0.35), radius: bright ? 12 : 5)
            .onAppear {
                guard !Juice.reduceMotion else { return }
                withAnimation(.easeInOut(duration: 1.1).repeatForever(autoreverses: true)) { bright = true }
            }
    }
}

/// The card's pointer: a small triangle on the card's side that faces what
/// it's about, its tip toward it. Drawn over the card's edge in the card's
/// own colour, so the two read as one shape.
private struct TourArrow: Shape {
    static let size: CGFloat = 10
    let edge: TourEdge
    /// The middle of the arrow's base, on the card's edge.
    let at: CGPoint

    /// Where on the card's edge the arrow sits: level with the target's
    /// middle, kept clear of the card's rounded corners.
    static func anchor(edge: TourEdge, card: CGRect, target: CGRect) -> CGPoint {
        let inset: CGFloat = 20
        func clampY(_ y: CGFloat) -> CGFloat { min(max(y, card.minY + inset), card.maxY - inset) }
        func clampX(_ x: CGFloat) -> CGFloat { min(max(x, card.minX + inset), card.maxX - inset) }
        switch edge {
        case .right: return CGPoint(x: card.minX, y: clampY(target.midY))
        case .left: return CGPoint(x: card.maxX, y: clampY(target.midY))
        case .below: return CGPoint(x: clampX(target.midX), y: card.minY)
        case .above: return CGPoint(x: clampX(target.midX), y: card.maxY)
        }
    }

    func path(in rect: CGRect) -> Path {
        let s = Self.size
        var p = Path()
        switch edge {
        // The card's to the right of the target: the arrow points left.
        case .right:
            p.move(to: CGPoint(x: at.x + 1, y: at.y - s)); p.addLine(to: CGPoint(x: at.x - s, y: at.y)); p.addLine(to: CGPoint(x: at.x + 1, y: at.y + s))
        case .left:
            p.move(to: CGPoint(x: at.x - 1, y: at.y - s)); p.addLine(to: CGPoint(x: at.x + s, y: at.y)); p.addLine(to: CGPoint(x: at.x - 1, y: at.y + s))
        case .below:
            p.move(to: CGPoint(x: at.x - s, y: at.y + 1)); p.addLine(to: CGPoint(x: at.x, y: at.y - s)); p.addLine(to: CGPoint(x: at.x + s, y: at.y + 1))
        case .above:
            p.move(to: CGPoint(x: at.x - s, y: at.y - 1)); p.addLine(to: CGPoint(x: at.x, y: at.y + s)); p.addLine(to: CGPoint(x: at.x + s, y: at.y - 1))
        }
        p.closeSubpath()
        return p
    }
}

/// The window with a rounded hole in it, filled even-odd. The hole moves
/// from one part to the next rather than jumping.
private struct Spotlight: Shape {
    static let corner: CGFloat = 10
    var hole: CGRect

    var animatableData: CGRect.AnimatableData {
        get { hole.animatableData }
        set { hole.animatableData = newValue }
    }

    func path(in rect: CGRect) -> Path {
        var path = Path(rect)
        path.addRoundedRect(in: hole, cornerSize: CGSize(width: Self.corner, height: Self.corner))
        return path
    }
}

private struct TourCard: View {
    let step: TourStep
    let index: Int
    let count: Int
    /// A hands-on step that hasn't taken after `Tour.patience`: Next
    /// shows anyway, so nobody's stuck.
    @State private var waited = false

    var body: some View {
        let tour = Tour.shared
        let done = tour.taskDone
        let failed = tour.firstThreadFailed
        VStack(alignment: .leading, spacing: zoomed(8)) {
            if let bear = step.bear {
                Image(nsImage: Bear.image(bear, side: zoomed(44)))
                    .renderingMode(.template)
                    .foregroundStyle(.secondary)
                    .accessibilityHidden(true)
            }
            HStack(spacing: zoomed(6)) {
                Text(step.title)
                    .font(.system(size: TypeScale.cardTitle + 1, weight: .semibold))
                if done {
                    Image(systemName: "checkmark.circle.fill")
                        .foregroundStyle(.secondary)
                        .transition(Juice.popIn)
                }
                Spacer(minLength: zoomed(8))
                // By the title, out of the buttons' way (beside them it
                // squeezed Back to "Ba…").
                if let doc = step.doc, let url = URL(string: "\(Tour.docsSite)/\(doc)") {
                    // The detail the card leaves out, on the website.
                    Button { OpenGate.openOwn(url) } label: {
                        Image(systemName: "info.circle")
                    }
                    .buttonStyle(.plain)
                    .foregroundStyle(.secondary)
                    .tip("More about this, in the docs")
                }
            }
            Text(failed ? step.failBody ?? step.body : done ? step.doneBody ?? step.body : step.body)
                .font(.system(size: TypeScale.label))
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
                .contentTransition(.opacity)
            HStack(spacing: zoomed(8)) {
                // Where you are in it, as dots: the step on show is darker.
                // No dots for a page's one-card intro: a lone dot says nothing.
                if count > 1 {
                HStack(spacing: zoomed(5)) {
                    ForEach(0..<count, id: \.self) { dot in
                        Circle()
                            .fill(dot == index ? AnyShapeStyle(.primary) : AnyShapeStyle(.quaternary))
                            .frame(width: zoomed(5), height: zoomed(5))
                    }
                }
                .accessibilityElement()
                .accessibilityLabel("Step \(index + 1) of \(count)")
                // The dots give way before a button's label does.
                .layoutPriority(-1)
                .clipped()
                }
                Spacer(minLength: zoomed(8))
                if tour.skippable && step.task != .sendFirst && !tour.isLast {
                    Button("Skip") { withAnimation(.easeOut(duration: 0.2)) { tour.finish() } }
                        .buttonStyle(.plain)
                        .foregroundStyle(.secondary)
                        .keyboardShortcut(.cancelAction)
                        .tip("End the tour (Esc). Help > Take the Tour brings it back")
                }
                if index > 0 {
                    Button("Back") { tour.back() }
                        .tip("The step before")
                }
                if step.task == .sendFirst {
                    // Sending is the way on; this leaves the message in the
                    // composer for later. No Return here: that's the send.
                    Button("Not now") { withAnimation(.easeOut(duration: 0.2)) { tour.finish() } }
                        .tip("End the tour. The message stays in the composer")
                } else {
                    Button(tour.isLast ? "Done" : index == 0 ? "Show me" : "Next") { tour.next() }
                        .buttonStyle(.borderedProminent)
                        .keyboardShortcut(.defaultAction)
                        .disabled(step.task != nil && !done && !waited)
                        .tip(step.task != nil && !done && !waited ? "Have a go first" : tour.isLast ? "End the tour (Return)" : "The next step (Return)")
                }
            }
            .font(.system(size: TypeScale.label))
            .padding(.top, zoomed(4))
        }
        .padding(zoomed(16))
        .frame(width: zoomed(320), alignment: .leading)
        .background(Color(nsColor: .windowBackgroundColor), in: RoundedRectangle(cornerRadius: 12))
        .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(.separator, lineWidth: 0.5))
        .shadow(color: .black.opacity(0.25), radius: 18, y: 6)
        .animation(Juice.swap, value: done)
        .task(id: index) {
            waited = false
            try? await Task.sleep(for: Tour.patience)
            waited = true
        }
    }
}
