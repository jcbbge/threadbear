import AppKit
import BearDock
import Observation
import ThreadbearCore

/// The view picked in the activity bar. Hibernating and Archive were views
/// too, until they became sections of the inbox (29 Oct).
enum SidebarMode: Equatable {
    case inbox, scheduled, projects, librarian
}

enum ConnectionState: Equatable {
    case connecting
    case connected
    /// The runner isn't listening (or the token file isn't there yet). The
    /// reason is for the banner's tooltip, not its text.
    case runnerDown(String)
    /// A working connection dropped; trying again.
    case lost
    case unauthorized
}

/// What's in a composer. Each picture has a mark in the text where its
/// chip is, the k-th mark standing for `images[k]` (InlinePictures).
struct Draft: Equatable {
    var text = ""
    var images: [ImageRef] = []

    /// One mark per picture: a picture added from outside the composer
    /// gets a chip at the end, and marks whose pictures didn't come along
    /// go.
    var normalized: Draft {
        Draft(text: InlinePictures.normalized(text, imageCount: images.count), images: images)
    }

    /// The words to send, the chips as [Picture N] markers numbered from
    /// `first` (after an ask box's pictures), or none when there's
    /// nothing but pictures.
    func words(first: Int = 1) -> String {
        InlinePictures.sentText(normalized.text, first: first).trimmingCharacters(in: .whitespacesAndNewlines)
    }

    /// Pictures added at the end, each with its chip.
    mutating func append(_ refs: [ImageRef]) {
        self = normalized
        for ref in refs {
            text = InlinePictures.appending(InlinePictures.markString, to: text)
            images.append(ref)
        }
    }

    /// Without the picture at `index`, and its chip.
    func removingImage(at index: Int) -> Draft {
        let whole = normalized
        guard whole.images.indices.contains(index) else { return whole }
        var images = whole.images
        images.remove(at: index)
        return Draft(text: InlinePictures.removingMark(index, from: whole.text), images: images)
    }
}

/// One of Mike's messages being edited in the composer.
struct MessageEdit: Equatable {
    var seq: Int
    /// The draft the box held before, put back once the edit is sent or
    /// cancelled.
    var before: Draft
    /// The edit has gone to the runner and it hasn't answered yet.
    var sending = false
}

/// The answers picked on a thread's open card (ask index to option index),
/// what's written in its Something else boxes, and which card they're for.
struct AskPicks: Equatable {
    var asksSeq: Int
    var picks: [Int: Int]
    var notes: [Int: AskNote] = [:]
}

/// The follow-ups ticked on a thread's done card, and which card they're for.
struct NextPicks: Equatable {
    var seq: Int
    var picked: Set<Int>
    /// Ones with their "?" on, to ask what they mean.
    var explain: Set<Int> = []
    var isEmpty: Bool { picked.isEmpty && explain.isEmpty }
}

/// The done card's follow-ups going with Mike's next message: the ticked
/// ones, and the ones he's asking about with their "?".
struct FollowUpPicks {
    var ticked: [String] = []
    var explain: [String] = []
    var isEmpty: Bool { ticked.isEmpty && explain.isEmpty }
}

/// App state: the runner connection, the thread list, the selection and the
/// open thread sessions. Holds no agent state of its own.
@MainActor
@Observable
final class AppModel {
    static let shared = AppModel()

    var connection: ConnectionState = .connecting
    /// A `threads.create` from the new-thread composer hasn't come back:
    /// its draft stays in the box, greyed and locked, with a spinner for
    /// Send, so the click visibly did something however slow the runner is.
    var creatingThread = false
    /// This Mac's runner's experiments that are on (hello's `experiments`),
    /// for the ones that live in the app: Voice mode.
    var experiments: Set<String> = []
    /// How long a thread may sit idle with one of Mike's messages still
    /// queued before the app gives up on it showing.
    static let queuedGrace: Double = 10
    @ObservationIgnored var queuedChecks: Set<String> = []
    var runnerVersion = ""
    var accounts: [Account] = []
    // Until the runner's hello says otherwise: setup's threads folder, and
    // the login every Mac has (~/.claude), never a folder of Mike's.
    var defaults = RunnerDefaults(cwd: NSString("~/ThreadbearThreads").expandingTildeInPath, accountId: "claude-main")
    /// The thread whose title is a field in the header just now (Rename,
    /// or a click on the title).
    var renamingThread: String?
    /// Threads whose sidebar rows are sliding off on their way to the
    /// archive, as a swiped row does (Mike asked 29 Oct): from the archive
    /// button, ⌘E, the done card, or an agent or the phone archiving it.
    /// `ThreadRowView` slides a row off while its thread is in here.
    var slidingOff: Set<String> = []
    /// What the runner said about a thread archived elsewhere, held back
    /// while its row slides off, so the row's still there to slide.
    @ObservationIgnored var heldWhileSliding: [String: ThreadSummary] = [:]
    /// Archived threads whose panel is still dropping into the Archived
    /// heading (`ArchiveFlight`). The heading leaves them out of its count
    /// and rows until they land, so the count rolls on as one arrives.
    var flyingToArchive: Set<String> = []
    /// How many of those have landed, for the heading's box to bounce.
    var archiveLandings = 0
    /// Archiving the last thread there was, from its own pane: the bear's
    /// due in the pane once the archived page has landed, then it's there
    /// until he types or opens a thread (`PaneBear`).
    var inboxZeroBear: InboxZeroBear?
    enum InboxZeroBear { case due, shown }
    /// The same for Hibernating: threads whose panel is still sinking into
    /// its heading, and how many have landed for the moon to dip.
    var flyingToHibernate: Set<String> = []

    /// Pages in flight that left an Inbox or Running row, noted as each one
    /// sets off. The empty-inbox bear waits for those to land, as arriving
    /// under the heading mid-flight would push it down and the page would
    /// land short. A starred or sleeping thread's flight doesn't hold it up:
    /// the Inbox was already empty, so a bear already there stays put rather
    /// than blinking off and on under the page.
    var leavingTheInbox: Set<String> = []
    var flightLeavingTheInbox: Bool { !leavingTheInbox.isEmpty }

    /// Notes where a flight is leaving from, before the thread moves.
    func noteFlightLeaving(_ threadId: String) {
        let sections = sections
        if sections.inbox.contains(where: { $0.id == threadId }) || sections.running.contains(where: { $0.id == threadId }) {
            leavingTheInbox.insert(threadId)
        }
    }
    var hibernateLandings = 0
    /// The note at the top of the thread panel after Mike archives a thread
    /// here, with Undo; a click on it opens the thread (Mike asked 30 Oct).
    /// Not for one an agent or the phone archives. `ArchivedToast` takes it
    /// down after a few seconds; the next archive replaces it.
    var archivedNote: ArchivedNote?
    /// The note at the top of the thread panel when Next Inbox Thread
    /// (⌥⌘↓) has nowhere to go: the open thread is the Inbox's last, or the
    /// Inbox is empty. `InboxEndToast` takes it down after a few seconds.
    var inboxEndNote: InboxEndNote?
    /// The note at the top of the thread panel when the thread count passes
    /// a milestone. `MilestoneToast` takes it down.
    var milestoneNote: MilestoneNote?
    /// Nil in scripted runs and tests, which never show that note.
    @ObservationIgnored var milestones: MilestoneWatch?
    /// Bumped when a thread is picked from somewhere other than the list
    /// (Next Inbox Thread), so the list scrolls its row into view.
    var revealSelectionRequests = 0
    /// Archives from the button, ⌘E or the done card that haven't gone to
    /// the runner yet (the row's still sliding). Undo takes one out of here,
    /// and then it never goes.
    @ObservationIgnored var archivesNotSent: Set<String> = []
    var threads: [String: ThreadSummary] = [:] {
        didSet {
            // A summary from another runner never says which runner it's on
            // (runnerId is this app's own marker), so one stored over a
            // remote thread's (markSeen's reply, a rename's, an archive's)
            // keeps the runner it had. Without this the thread quietly turns
            // into one of this Mac's: its calls go to this Mac's runner
            // ("Thread not found") and its own runner's events are dropped.
            // Setting threads in its own didSet doesn't run didSet again.
            for (id, thread) in threads where thread.runnerId == nil {
                if let runnerId = oldValue[id]?.runnerId { threads[id]?.runnerId = runnerId }
            }
            // Nor does the sidebar's table say if another runner's thread is
            // shared (thread-index.ts leaves it out), so a link made here
            // (the relay's threads.share reply) stays until a reply says
            // otherwise. Once made, a share never goes back to none: off
            // keeps its slug.
            for (id, thread) in threads where thread.share == nil && thread.runnerId != nil {
                if let share = oldValue[id]?.share { threads[id]?.share = share }
            }
            // A thread read through Convex keeps the asks of the card it
            // shows, whatever summary is stored over it (the table's row,
            // a reply's): none of those carry them (withRelayCard).
            if !directRemoteLink {
                for (id, thread) in threads where thread.runnerId != nil && oldValue[id] != thread {
                    let carded = withRelayCard(thread)
                    if carded != thread { threads[id] = carded }
                }
            }
            threadsVersion &+= 1
            refreshDockBadge()
            noteFailedAccounts(from: oldValue)
            // Most updates change a thread, not which threads there are.
            if threads.count != oldValue.count || threads.keys.contains(where: { oldValue[$0] == nil }) {
                ThreadChips.update(threads.keys)
            }
        }
    }
    /// For a thread whose last turn failed: the account it failed on, as it
    /// was when the thread went into `error`. Moving the thread to another
    /// account doesn't clear the status, so this is how the limit line
    /// knows the new account isn't the one that ran out.
    @ObservationIgnored var failedOnAccount: [String: String] = [:]
    // These four are where the window is; a change to any of them is a
    // step in the back/forward history (Navigation.swift).
    var selection: String? {
        didSet {
            if selection != oldValue {
                noteNavigation()
                mainContextChanged()
                // Back and forward set this without select().
                servePanelRequest()
                tidyRemoteClients()
            }
        }
    }
    /// A sub-agent's transcript is showing instead of its thread's. The
    /// thread stays `selection`, so the sidebar keeps its sub-agents listed
    /// and the toolbar still names it.
    var subagentSelection: SubagentRef? {
        didSet { if subagentSelection != oldValue { noteNavigation() } }
    }
    var sidebarMode: SidebarMode = .inbox {
        didSet {
            if sidebarMode != oldValue { noteNavigation() }
            if sidebarMode != .projects { showsProjectsHome = false }
            if sidebarMode != .librarian { showsLibrarianHome = false }
            if sidebarMode != .scheduled { showsScheduledHome = false }
        }
    }
    /// Back and forward (⌘[ and ⌘], or the mouse's side buttons).
    var history = NavigationHistory<NavigationPlace>()
    @ObservationIgnored var navigationPending = false
    /// What's typed in the search at the top of the inbox, which cuts every
    /// section down to its matches (`ThreadSections.matching`).
    var searchQuery = ""
    /// What's typed in the search on the Projects page. Here rather than in
    /// the page, so backing out of a project finds the same results.
    var projectSearchQuery = ""
    var errorMessage: String? {
        // What the app knew as it came up, for the bar's Investigate:
        // the thread acted on (or else the one open) and what he was doing.
        didSet {
            errorShown = errorMessage == nil ? nil : (threadId: nextErrorThread ?? selection, doing: nextErrorDoing, at: Date())
            nextErrorThread = nil
            nextErrorDoing = nil
        }
    }
    @ObservationIgnored var errorShown: (threadId: String?, doing: String?, at: Date)?
    /// Set just before `errorMessage` by `showError(_:in:doing:)`.
    @ObservationIgnored var nextErrorThread: String?
    @ObservationIgnored var nextErrorDoing: String?
    var continuingRefusals: Set<String> = []
    /// Patch versions whose Trust is on its way, as "file hash". The runner
    /// answers only once it has read every thread's patches again, which
    /// takes seconds, so the row shows a spinner and its button stops taking
    /// clicks until then (AGENTS.md, "Assume every action is slow to land").
    /// By version, so a file that changes again gets its button back.
    var trustingPatches: Set<String> = []
    /// Bumped to put the cursor in a composer, by its draft key (a thread's
    /// id, or "new"): with threads open in several panels, only that one's.
    var focusRequests: [String: Int] = [:]
    var now = Date()
    var drafts: [String: Draft] = [:]
    /// Messages being edited, by thread id: the seq of the message the
    /// composer's draft will replace (docs/protocol.md, "Editing a
    /// message"), and whatever was in the box before, to put back after.
    var editing: [String: MessageEdit] = [:]
    /// The answers Mike has picked on each thread's open card of asks, by
    /// thread id, waiting in the composer to go with his next message.
    /// Ones for an older card count as none.
    var askPicks: [String: AskPicks] = [:]
    /// The seq of the card of asks collapsed on each thread, by thread id.
    /// By card, so the next one, something new to decide, always opens.
    var collapsedCards: [String: Int] = [:]
    /// The follow-ups ticked on each thread's done card, by thread id,
    /// waiting in the composer the same way. Ones for an older card count
    /// as none.
    var nextPicks: [String: NextPicks] = [:]
    @ObservationIgnored var reviewWindows: [String: ReviewWindowController] = [:]
    /// The first thread list has arrived. Until then the sidebar list stays
    /// empty, so it's filled in one go.
    var threadsLoaded = false
    /// New-thread settings shown on the composer. The model and effort
    /// start as whatever was picked last, on any thread, and are kept
    /// across launches; the folder and "Ask before edits" are for one
    /// thread and go back to the defaults after it starts.
    var newThreadCwd: String?
    /// The runner the next new thread starts on ("Runs on", the
    /// composer's machine chip): nil for this Mac, or another runner's id.
    /// Its folder, account, model and effort are then that runner's
    /// (`newThreadLogins`), and the thread is made over its connection.
    /// For one thread, like the folder: back to this Mac after it starts.
    var newThreadRunnerId: String?
    /// The runner new threads start on when Mike hasn't picked one (the
    /// starred row in the machine chip's menu, and Settings > Runners): nil
    /// for this Mac. This Mac's own choice, kept across launches.
    var defaultRunnerId: String? = UserDefaults.standard.string(forKey: AppModel.defaultRunnerKey) {
        didSet { UserDefaults.standard.set(defaultRunnerId, forKey: Self.defaultRunnerKey) }
    }
    static let defaultRunnerKey = "defaultRunnerId"

    /// Settings > Runners, "Connect to other machines directly": open other
    /// runners' threads over the tailnet, as before 5 Nov, rather than
    /// through this Mac's runner and Convex (docs/protocol.md, "Other
    /// runners' threads through the backend"). Off by default; it goes once
    /// the Convex way has been used for a while.
    var directRemoteLink: Bool = UserDefaults.standard.bool(forKey: AppModel.directRemoteLinkKey) {
        didSet {
            guard directRemoteLink != oldValue else { return }
            UserDefaults.standard.set(directRemoteLink, forKey: Self.directRemoteLinkKey)
            switchedRemoteLink()
        }
    }
    static let directRemoteLinkKey = "directRemoteLink"
    /// Mike picked this draft's runner himself, so the default doesn't
    /// move it when the runner list next changes.
    var newThreadRunnerPicked = false
    /// Why the chosen runner can't be reached, for the composer to say.
    var newThreadRunnerProblem: String?
    /// The account Mike picked for the next new thread, for that draft only:
    /// with none picked it's the one with the most room (`newThreadAccountId`).
    /// With pools, a pick here pins the new thread to that login.
    var newThreadAccount: String?
    /// The runner's pools (docs/pools-plan.md), in its order. Replaced whole
    /// by `pools.updated`.
    var pools: [Pool] = []
    /// Other runners' logins (accounts, pools, defaults), by runner id, from
    /// the hello their connection made and their accounts.updated and
    /// pools.updated since: what the composer's pickers offer on one of
    /// their threads (`logins(for:)`).
    var remoteLogins: [String: RunnerLogins] = [:]
    /// The runner has pools. False for an older one, which sends none in
    /// hello: then the composer keeps its account chip and the picker's
    /// rail lists providers, as before.
    var poolsSupported = false
    /// The pool Mike picked for the next new thread, for that draft only.
    /// With none, the folder's pool or the one he last picked
    /// (`newThreadPoolId`).
    var newThreadPool: String?
    /// The provider whose model Mike picked for the draft in a mixed pool.
    var newThreadProvider: String?
    /// Why the last `pools.save` didn't take, for Settings › Pools.
    var poolsError: String?
    /// The last model and effort picked, per provider ("claude", "codex"),
    /// kept across launches: a Codex model is no use to a Claude thread.
    private(set) var lastModels: [String: String] = AppModel.loadMemory(AppModel.lastModelKey)
    private(set) var lastEfforts: [String: String] = AppModel.loadMemory(AppModel.lastEffortKey)
    var newThreadPermission: PermissionMode = .full
    /// What the runner says about the Claude and Codex CLIs (`clis.list`,
    /// `clis.updated`). Empty until it's said anything.
    var clis: [CliStatus] = []
    /// Nil until asked; false for a runner older than step 4, which has no
    /// `clis.*` (the usage popover leaves the CLI part out).
    var clisSupported: Bool?
    /// Tokens by the hour and limit readings over time (`usage.stats`),
    /// for the Usage panel. Asked for while the panel is open.
    var usageStats: UsageStats?
    /// Nil until asked; false for a runner without `usage.stats`.
    var usageStatsSupported: Bool?
    /// Update failures Mike has dismissed, by "<provider>|<finishedAt>",
    /// so the line under the toolbar stays gone for that failure.
    var dismissedCliFailures: Set<String> = []
    /// Bumped to open the composer's model picker from the automation
    /// (`composer-menu` with `show`), the way a click on the chip does.
    var modelPickerRequest = 0
    /// The same for the account picker.
    var accountPickerRequest = 0
    /// The same for the composer's context ring.
    var contextMeterRequest = 0
    /// Every schedule, in the runner's order (soonest first, then the
    /// paused and finished ones). Replaced whole by `schedules.updated`.
    var schedules: [Schedule] = [] {
        didSet { schedulesVersion &+= 1 }
    }
    /// The runner knows about schedules: an older one answers
    /// `schedules.list` with -32601, and then the sidebar has no Scheduled row.
    var schedulesSupported = false
    /// The runners a schedule can run on (`runners.list`), this one first.
    /// Empty from a runner before step 6, or before it answers: then
    /// there's no choice to offer and every schedule is this runner's.
    var runners: [RunnerInfo] = []
    /// Other runners, from this one (docs/protocol.md, "Other runners'
    /// threads"): their names, icons, whether they're online and how to
    /// reach them. Their threads are in `threads`, marked with `runnerId`
    /// (RemoteRunners.swift).
    var remoteRunners: [RemoteRunner] = []
    /// Mike's runner order (`remoteIndex.order`, backend API 58), or the
    /// one just dragged to until the runner's list comes back in it, so a
    /// heartbeat in between doesn't snap the rows back. Nil with none to give.
    var runnerOrder: [String]?
    @ObservationIgnored var pendingRunnerOrder: [String]?
    /// Screenshots only: holds the top runner mid-drag by this much, as a
    /// script can't hold a real drag still to photograph it.
    @ObservationIgnored var runnerDragPreview: CGSize?
    /// Each runner's machine figures by runner id (`runners.stats`), asked
    /// every 10 s while a runner's details are open in the Runners panel.
    var runnerStats: [String: RunnerMachineStats] = [:]
    /// The runner has answered `runners.stats` at least once since then.
    var runnerStatsAsked = false
    /// The last `remoteThreads` list, kept to put the sidebar table's rows
    /// back once a runner's own connection closes.
    @ObservationIgnored var remoteIndex = RemoteThreads()
    /// Other runners' threads whose summary came from their own runner's
    /// connection, which is fuller and fresher than the sidebar table's
    /// row, until that connection closes.
    @ObservationIgnored var liveRemote: Set<String> = []
    /// Threads made on another runner through Convex that the sidebar table
    /// doesn't list yet: kept until it does.
    @ObservationIgnored var madeRemote: Set<String> = []
    /// One connection per other runner, made when one of its threads is
    /// opened.
    @ObservationIgnored var remoteClients = RemoteClients(version: Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "dev")
    @ObservationIgnored var remoteTidy: Task<Void, Never>?
    /// This Mac's copies of files in other runners' threads
    /// (`remoteFiles`, RemoteFiles.swift), made on first use.
    @ObservationIgnored var remoteFileStore: RemoteFileStore?
    /// The thread a transcript link is being followed in, while a click on
    /// it is handled (TranscriptTextView.forItsThread): a thread open in a
    /// panel isn't the selected one, and another Mac's paths mustn't be
    /// read as this Mac's (Daybreak, 7 Nov). Nil means the selected thread.
    @ObservationIgnored var linkThreadId: String?
    /// Every project, archived ones too, in the runner's order (newest
    /// activity first). Replaced whole by `projects.updated`.
    var projects: [Project] = [] {
        didSet { projectsVersion &+= 1 }
    }
    /// The runner knows about projects: an older one answers
    /// `projects.list` with -32601, and then the activity bar has no
    /// Projects or Librarian button and threads show no project chips.
    var projectsSupported = false
    /// What the librarian is doing, once `librarian.status` has answered;
    /// replaced by `librarian.updated`.
    var librarian: LibrarianStatus?
    /// The Connectors gateway's services (docs/protocol.md, "Connectors"),
    /// once `connectors.status` has answered; replaced by
    /// `connectors.updated`. Nil from a runner that doesn't know about it,
    /// and then the activity bar has no Connectors icon.
    var connectors: ConnectorsStatus?
    /// The project page showing in the detail area instead of the thread.
    /// Selecting a thread (or a new one) closes it.
    var openProjectId: String? {
        didSet {
            if openProjectId != oldValue {
                noteNavigation()
                mainContextChanged()
            }
        }
    }
    /// The Projects page (a card per project) in the detail area: what
    /// clicking Projects in the activity bar opens. Picking a thread or a
    /// project, or leaving the Projects view, closes it.
    var showsProjectsHome = false {
        didSet {
            if showsProjectsHome != oldValue {
                noteNavigation()
                mainContextChanged()
            }
        }
    }
    /// The Librarian's page (what it is, what it's up to and its numbers)
    /// in the detail area, from the activity bar's Librarian. Closes the
    /// same ways as the Projects page.
    var showsLibrarianHome = false {
        didSet {
            if showsLibrarianHome != oldValue {
                noteNavigation()
                mainContextChanged()
            }
        }
    }
    /// The Scheduled page (what schedules are, what's coming up and their
    /// numbers), from the activity bar's Scheduled. Closes the same ways.
    var showsScheduledHome = false {
        didSet {
            if showsScheduledHome != oldValue {
                noteNavigation()
                mainContextChanged()
            }
        }
    }
    /// One of those pages is in the detail area, not the selected thread.
    var showsHomePage: Bool { showsProjectsHome || showsLibrarianHome || showsScheduledHome }
    /// The runner's settings for the Settings window: nil until
    /// `settings.get` answers, then replaced whole by `settings.updated`.
    var runnerSettings: RunnerSettings?
    /// His standing instructions for every session; nil: no box (InstructionsModel.swift).
    var standingInstructions: StandingInstructions?
    /// The runner is from before settings (it answers -32601).
    var settingsUnsupported = false
    /// Why the last change in the Settings window didn't take, shown there.
    var settingsError: String?
    var settingsTab: SettingsTab = .general
    /// Bumped to open the Settings window from the automation (RootView
    /// opens it, as ⌘, does).
    var settingsRequest = 0
    /// Settings › Phone & browser (DevicesModel.swift): the backend's list
    /// of paired phones and browsers as the runner last gave it, the
    /// website's root, or why nothing can pair. Never a token.
    var devices: [Device] = []
    var devicesSite: String?
    /// The backend can't send phone notifications (a self-hosted one), from
    /// runner.status, so Phone & browser says so.
    var pushOff = false
    var devicesReason: String?
    var devicesError: String?
    var devicesUnsupported = false
    var devicesLoaded = false
    var devicesLoading = false
    /// Bumped by the automation to show the pairing code, for screenshots.
    var pairRequest = 0
    /// The schedule editor sheet, when it's open (ScheduleEditor).
    var scheduleEditor: ScheduleEditorState?
    /// A sidebar row drawn as if the pointer were over it, so the screenshot
    /// run can show the hover buttons without moving the mouse.
    var hoverOverride: String?
    /// The sidebar row whose moon menu is open: it keeps its hover buttons,
    /// as the pointer leaves the row to get into the menu.
    var menuOpenRow: String?
    /// The window's panels and where they are (WindowDock), saved as Mike
    /// moves them.
    @ObservationIgnored let dock = WindowDock.makeController()
    /// Panels opened as tabs beside the main panel for what it's showing
    /// (a review, so far). They close when the main panel moves on to
    /// something else, unless Mike has dragged them out of its group by
    /// then, which keeps them (`dockChanged`).
    @ObservationIgnored var mainTabs: Set<PanelID> = []
    /// The transcripts of threads open in panels of their own, by thread id.
    /// The main panel's is `transcript`.
    @ObservationIgnored var panelTranscripts: [String: TranscriptController] = [:]
    /// The pane sections open when Hide Panels closed them, for Show Panels.
    @ObservationIgnored var hiddenPanes: [PanelID] = []
    /// Whether any pane section (Highlights, a panel, Patches) is open in
    /// the dock. Setting it closes them all, or opens again the ones Hide
    /// Panels closed (Highlights if none).
    var panelsShown: Bool {
        get { !openPanes.isEmpty }
        set {
            if newValue {
                guard openPanes.isEmpty else { return }
                for id in hiddenPanes.isEmpty ? [PaneSection.highlightsId] : hiddenPanes {
                    showPane(PaneSection(id: id))
                }
            } else {
                hiddenPanes = openPanes
                for id in hiddenPanes { dock.close(id) }
            }
        }
    }
    /// Inbox sections folded away under their heading, remembered across
    /// launches (Mike asked 27 Oct). Hibernating and Archive start folded.
    var collapsedSections: Set<InboxSection> = AppModel.storedCollapsedSections() {
        didSet { UserDefaults.standard.set(collapsedSections.map(\.rawValue).sorted(), forKey: Self.collapsedSectionsKey) }
    }
    /// The Scheduled list's folded headings, remembered like the inbox's.
    /// Done starts folded: one-offs that have run are there to look up.
    var collapsedScheduleSections: Set<ScheduleSection> = AppModel.storedCollapsedScheduleSections() {
        didSet { UserDefaults.standard.set(collapsedScheduleSections.map(\.rawValue).sorted(), forKey: Self.collapsedScheduleSectionsKey) }
    }
    /// Highlights' folded headings (`HighlightFold`), remembered across
    /// threads and launches.
    var collapsedHighlights: Set<String> = AppModel.storedCollapsedHighlights() {
        didSet { UserDefaults.standard.set(collapsedHighlights.sorted(), forKey: Self.collapsedHighlightsKey) }
    }
    /// The Inbox section's order, from the sort menu on its heading,
    /// remembered across launches.
    var inboxOrder: InboxOrder = InboxOrder(rawValue: UserDefaults.standard.string(forKey: AppModel.inboxOrderKey) ?? "") ?? .needsYou {
        didSet { UserDefaults.standard.set(inboxOrder.rawValue, forKey: Self.inboxOrderKey) }
    }
    /// A thread's chosen pane section, as `PaneSection.id`.
    var panelChoice: [String: String] = [:]
    /// Each thread's slash commands once `threads.commands` has answered
    /// (SlashPalette.swift), for the composer's palette.
    var slashCommands: [String: [SlashCommand]] = [:]
    @ObservationIgnored var slashFetches: [String: Task<Void, Never>] = [:]
    /// The sizes Mike dragged the palette and its columns to, kept for
    /// next time.
    var slashPaletteLayout: SlashPalette.Layout = (UserDefaults.standard.data(forKey: "slashPaletteLayout")).flatMap { try? JSONDecoder().decode(SlashPalette.Layout.self, from: $0) } ?? SlashPalette.Layout() {
        didSet { UserDefaults.standard.set(try? JSONEncoder().encode(slashPaletteLayout), forKey: "slashPaletteLayout") }
    }
    /// The commands picked from the palette lately, newest first.
    var recentSlashCommands: [String] = UserDefaults.standard.stringArray(forKey: "recentSlashCommands") ?? [] {
        didSet { UserDefaults.standard.set(recentSlashCommands, forKey: "recentSlashCommands") }
    }
    /// Each thread's highlights once `threads.highlights` has answered
    /// (PaneModel.swift). Only threads Mike has opened this session.
    var highlights: [String: ThreadHighlights] = [:]
    /// The runner answered `threads.highlights` with -32601: the section
    /// says so, and nothing asks again until the next connection.
    var highlightsUnsupported = false
    /// A file or page open in the pane in place of its section, per thread.
    var panePreview: [String: PanePreview] = [:]
    /// Each thread's Explain side conversation (ExplainModel.swift).
    var explainers: [String: ExplainSession] = [:]
    @ObservationIgnored var explainCount = 0
    @ObservationIgnored var highlightFetches: [String: Task<Void, Never>] = [:]
    /// Bumped by each request for a thread's highlights, so a change that
    /// lands while a fetch is out gets fetched again after it.
    @ObservationIgnored var highlightWanted: [String: Int] = [:]
    @ObservationIgnored var highlightAutoShow = HighlightAutoShow()
    /// The agents' show_panel requests shown this run (PanelRequestModel).
    @ObservationIgnored var panelRequestGate = PanelRequestGate()
    /// What's waiting on the runner, by `BusyKey`, with how many of each
    /// (AppModel+Busy.swift).
    var busyKeys: [String: Int] = [:]
    /// What those are doing, in words, for the ones clicked somewhere that
    /// can't show a spinner: the newest shows in the banner.
    var busyNotes: [BusyNote] = []
    /// A moment's "that's done", in the same place.
    var doneNote: String?
    /// Actions whose command is running, as "<threadId>/<actionId>", so
    /// the chip shows it and a second click doesn't start another.
    var runningActions: Set<String> = []
    /// The automation hook's `focus`: a scripted app is never in front, so
    /// it never marked anything read; with this it acts as if Mike were
    /// looking at it. Never set outside a scripted debug run.
    @ObservationIgnored var actsActive = false
    /// Mike can see the window: the app is in front (or acting as if).
    var isLooking: Bool { NSApp.isActive || actsActive }
    /// A runner restart that's waiting for threads to finish or under way,
    /// for the quiet banner (see `banner`).
    var restart = RunnerRestart()
    /// Requests a restart turned away, going again on the new runner, and
    /// any made while they wait, each behind the one before
    /// (`inRestartOrder`), with how many are in it.
    @ObservationIgnored var restartQueue: Task<Void, Never>?
    @ObservationIgnored var restartQueued = 0
    /// The website's root, from runner.status (nil while sync is off).
    var websiteURL: URL?
    /// The runner's own update (protocol "Runner updates"), for the rail's
    /// updates icon. Nil from a runner older than that.
    var runnerUpdates: RunnerUpdates?
    /// The little popover a right-click on the updates icon opens, for
    /// updating the app without the panel. On the model so a script can
    /// open it.
    var updatePopoverShown = false
    /// The project whose ⓘ popover is open in Highlights (why the thread
    /// is in it), if any. On the model so a script can open it.
    var projectWhyShown: String?
    /// The thread whose share popover is open, if any. On the model so a
    /// script can open it.
    var sharePopoverThread: String?

    @ObservationIgnored var client: RPCClient?
    @ObservationIgnored var sessions: [String: ThreadSession] = [:]
    /// Sub-agent transcripts, keyed by `SubagentRef.key`. A handful at most.
    @ObservationIgnored var subagentSessions: [String: ThreadSession] = [:]
    @ObservationIgnored var subagentPoll: Task<Void, Never>?
    @ObservationIgnored var connectTask: Task<Void, Never>?
    /// By thread: the main panel's and those in panels of their own can
    /// be marked at once.
    @ObservationIgnored var markSeenTasks: [String: Task<Void, Never>] = [:]
    @ObservationIgnored var backoff = Backoff()
    @ObservationIgnored let transcript = TranscriptController()
    @ObservationIgnored var dataDir = RunnerConfig.dataDir()
    @ObservationIgnored var notificationsEnabled = true
    @ObservationIgnored var onThreadsLoaded: (() -> Void)?
    @ObservationIgnored private var clockTimer: Timer?
    /// Where the Copy menu items put things. A scripted debug run points it
    /// at a private pasteboard, so it never touches Mike's clipboard.
    @ObservationIgnored var pasteboard = NSPasteboard.general
    @ObservationIgnored var statusTask: Task<Void, Never>?
    @ObservationIgnored var restartExpiry: Task<Void, Never>?
    /// The last reason a connection attempt failed, so a runner that stays
    /// down logs once rather than on every retry.
    @ObservationIgnored var lastDownReason: String?

    static let maxSessions = 24
    static let lastAccountKey = "lastAccountId"
    /// The last pool Mike picked, and the provider he last picked a model
    /// of in each pool (a mixed one has two).
    static let lastPoolKey = "lastPoolId"
    static let lastPoolProvidersKey = "lastPoolProviders"
    /// Claude's keys keep their old names, so a model picked before Codex
    /// came along is still remembered; other providers add ".<provider>".
    static let lastModelKey = "lastModel"
    static let lastEffortKey = "lastEffort"
    static let memoryProviders = ["claude", "codex"]
    static let collapsedSectionsKey = "collapsedSections"
    /// Set once Hibernating and Archive have been folded the first time.
    /// They came after collapsedSections did, so a saved list without them
    /// can't tell "never seen" from "opened".
    static let putAwayFoldedKey = "putAwaySectionsFolded"

    static func storedCollapsedSections(_ defaults: UserDefaults = .standard) -> Set<InboxSection> {
        var sections = Set((defaults.stringArray(forKey: collapsedSectionsKey) ?? []).compactMap(InboxSection.init(rawValue:)))
        if !defaults.bool(forKey: putAwayFoldedKey) {
            sections.formUnion([.hibernating, .archived])
            defaults.set(sections.map(\.rawValue).sorted(), forKey: collapsedSectionsKey)
            defaults.set(true, forKey: putAwayFoldedKey)
        }
        return sections
    }
    static let collapsedScheduleSectionsKey = "collapsedScheduleSections"

    static func storedCollapsedScheduleSections(_ defaults: UserDefaults = .standard) -> Set<ScheduleSection> {
        guard let saved = defaults.stringArray(forKey: collapsedScheduleSectionsKey) else { return [.done] }
        return Set(saved.compactMap(ScheduleSection.init(rawValue:)))
    }
    static let collapsedHighlightsKey = "collapsedHighlights"

    static func storedCollapsedHighlights(_ defaults: UserDefaults = .standard) -> Set<String> {
        Set(defaults.stringArray(forKey: collapsedHighlightsKey) ?? [])
    }
    static let inboxOrderKey = "inboxOrder"
    /// The error banner text shown for a connection problem, so it can be
    /// cleared when the connection comes back.
    @ObservationIgnored var connectionErrorMessage: String?

    init() {
        // The dock saves its layout on every change (WindowDock); this
        // follows panels in and out of the main panel's group as well.
        let save = dock.onChange
        dock.onChange = { [weak self] layout in
            save?(layout)
            self?.dockChanged(layout)
        }
        wireRemoteClients()
        clockTimer = Timer.scheduledTimer(withTimeInterval: 30, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated {
                guard let self else { return }
                self.now = Date()
                // Background work that ends sends no thread update, so a
                // pending restart's count is asked for again now and then.
                if self.restart.isPending { self.refreshRunnerStatus() }
            }
        }
    }

    // Bumped on every change to these, for the memos below: cheaper than
    // comparing every thread.
    @ObservationIgnored private var threadsVersion = 0
    @ObservationIgnored private var schedulesVersion = 0
    @ObservationIgnored private var projectsVersion = 0
    private struct DerivedKey: Equatable {
        var threads: Int, other: Int, now: Date, order: InboxOrder?
    }
    @ObservationIgnored private var sectionsMemo: (key: DerivedKey, value: ThreadSections)?
    @ObservationIgnored private var projectSectionsMemo: (key: DerivedKey, value: ProjectSections)?
    @ObservationIgnored private var panelOwnersMemo: (version: Int, value: [String: String])?

    // MARK: Derived

    /// Built once per change rather than once per reader. The activity
    /// bar's badge, the inbox list and the projects views all read these, and
    /// every thread.updated from a running thread used to rebuild them for
    /// each one, copying and sorting every thread each time: most of what an
    /// update cost the main thread.
    var sections: ThreadSections {
        // Read through the observed properties every time, memo or not, so
        // a view reading this still redraws when any of them changes.
        let (threads, now, schedules, order) = (threads, now, schedules, inboxOrder)
        let key = DerivedKey(threads: threadsVersion, other: schedulesVersion, now: now, order: order)
        if let memo = sectionsMemo, memo.key == key { return memo.value }
        let built = ThreadSections.build(threads.values, now: now, wakes: ThreadSections.wakes(schedules), order: order)
        sectionsMemo = (key, built)
        return built
    }

    var projectSections: ProjectSections {
        let (threads, now, projects) = (threads, now, projects)
        let key = DerivedKey(threads: threadsVersion, other: projectsVersion, now: now, order: nil)
        if let memo = projectSectionsMemo, memo.key == key { return memo.value }
        let built = ProjectSections.build(projects: projects, threads: threads.values, now: now)
        projectSectionsMemo = (key, built)
        return built
    }
    /// Any thread with a panel by this id, for a tab whose panel stays in the
    /// layout when Mike moves to a thread without it. Every tab asks several
    /// times on every thread update, mostly for panels nobody has (Threads,
    /// the transcript), which walked every thread each time; so the answers
    /// are kept until the threads change.
    func threadOwning(panel: String) -> ThreadSummary? {
        let threads = threads
        if panelOwnersMemo?.version != threadsVersion {
            var owners: [String: String] = [:]
            for thread in threads.values where !thread.panels.isEmpty {
                for panel in thread.panels where owners[panel.id] == nil { owners[panel.id] = thread.id }
            }
            panelOwnersMemo = (threadsVersion, owners)
        }
        return panelOwnersMemo?.value[panel].flatMap { threads[$0] }
    }

    /// The schedule due to message each thread soonest, for the rows under
    /// Hibernating that are waiting on one.
    var wakes: [String: Schedule] { ThreadSections.wakes(schedules) }
    var snoozed: [ThreadSummary] { ThreadSections.snoozed(threads.values, now: now) }
    var archivedCount: Int { threads.values.reduce(0) { $0 + ($1.isArchived ? 1 : 0) } }
    var selectedThread: ThreadSummary? { selection.flatMap { threads[$0] } }

    var lastAccountId: String {
        UserDefaults.standard.string(forKey: Self.lastAccountKey) ?? defaults.accountId
    }

    /// The account the next new thread starts on: Mike's pick for this
    /// draft, else the one with the most room on the provider he last used
    /// (`AccountUsageText.pickAccount`, the runner's rule too). Follows
    /// `accounts.updated`, so it moves as usage does until he picks one.
    var newThreadAccountId: String {
        let logins = draftLogins
        // On another runner, only one of its own logins will do.
        if let newThreadAccount, newThreadRunnerId == nil || logins.account(newThreadAccount) != nil { return newThreadAccount }
        // With pools, the login the runner would pick in the new thread's
        // pool, so the picker lists that provider's models.
        if let poolId = newThreadPoolId, let pool = logins.pool(poolId) {
            let provider = newThreadProvider(in: poolId)
            if let login = Pools.pickLogin(pool, accounts: logins.accounts, provider: provider, current: lastAccountId(provider: provider)) { return login }
        }
        if newThreadRunnerId != nil { return AccountUsageText.pickAccount(logins.accounts, lastUsedId: lastAccountId) ?? logins.defaults.accountId }
        return AccountUsageText.pickAccount(accounts, lastUsedId: lastAccountId) ?? lastAccountId
    }

    /// The logins a new thread's pickers offer and it starts on: this
    /// Mac's, or the chosen runner's once its connection has said hello
    /// (nil until then).
    var newThreadLogins: RunnerLogins? {
        guard let runnerId = newThreadRunnerId else { return RunnerLogins(accounts: accounts, pools: pools, defaults: defaults) }
        return remoteLogins[runnerId]
    }

    /// The same, with none for a runner that hasn't said hello yet.
    var draftLogins: RunnerLogins {
        newThreadLogins ?? RunnerLogins(accounts: [], pools: [], defaults: RunnerDefaults(cwd: "", accountId: ""))
    }

    func provider(ofAccount id: String) -> String { account(id)?.provider ?? "claude" }

    /// The provider of the login the next new thread starts on.
    var newThreadProviderId: String { draftLogins.account(newThreadAccountId)?.provider ?? "claude" }

    /// The model and effort the next new thread starts on, for the
    /// provider of the account it starts on.
    var newThreadModel: String? {
        get { lastModels[newThreadProviderId] }
        set { remember(model: newValue, provider: newThreadProviderId) }
    }

    var newThreadEffort: String? {
        get { lastEfforts[newThreadProviderId] }
        set { remember(effort: newValue, provider: newThreadProviderId) }
    }

    func remember(model: String?, provider: String) {
        lastModels[provider] = model.flatMap { $0.isEmpty ? nil : $0 }
        Self.remember(model, forKey: Self.memoryKey(Self.lastModelKey, provider: provider))
    }

    func remember(effort: String?, provider: String) {
        lastEfforts[provider] = effort.flatMap { $0.isEmpty ? nil : $0 }
        Self.remember(effort, forKey: Self.memoryKey(Self.lastEffortKey, provider: provider))
    }

    static func memoryKey(_ base: String, provider: String) -> String {
        provider == "claude" || provider.isEmpty ? base : base + "." + provider
    }

    private static func loadMemory(_ base: String) -> [String: String] {
        var memory: [String: String] = [:]
        for provider in memoryProviders {
            if let value = UserDefaults.standard.string(forKey: memoryKey(base, provider: provider)), !value.isEmpty { memory[provider] = value }
        }
        return memory
    }

    func accountTitle(_ id: String) -> String {
        account(id).map(AccountName.title) ?? id
    }

    /// The part of the account's email before the @ (see `AccountName`).
    func accountShortTitle(_ id: String) -> String {
        AccountName.short(id, accounts: accounts)
    }
}

/// What `ArchivedToast` shows.
struct ArchivedNote: Equatable, Identifiable {
    let id = UUID()
    let threadId: String
    let title: String
    /// It was the open thread, so Undo opens it again.
    let wasOpen: Bool
}

/// What `InboxEndToast` shows.
struct InboxEndNote: Equatable, Identifiable {
    let id = UUID()
    /// The Inbox had nothing in it at all, rather than nothing after the
    /// open thread.
    let empty: Bool
}

/// What `ConnectionBanner` shows.
struct Banner: Equatable {
    enum Style: String {
        /// A restart: expected, nothing to do. Grey text, no buttons.
        case quiet
        /// The runner can't be reached: yellow, with Try again.
        case warning
    }

    var style: Style
    /// An SF Symbol, or nil for a spinner.
    var icon: String?
    var text: String
    var detail: String?
    var showStart = false
    var showRetry = false
    /// A failed CLI update: the line has a Dismiss button, which forgets it.
    var dismissKey: String?
}
