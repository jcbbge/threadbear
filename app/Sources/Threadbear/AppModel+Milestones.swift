import AppKit
import ThreadbearCore

/// What `MilestoneToast` shows.
struct MilestoneNote: Equatable, Identifiable {
    let id = UUID()
    let tier: Int
}

/// What the milestone note needs beyond the model. Only the real app makes
/// one (scripted runs and tests have none, as with notifications), so a dev
/// app can't use up Mike's note.
@MainActor
final class MilestoneWatch {
    /// The highest milestone shown (`ThreadMilestones`).
    nonisolated static let shownKey = "threadMilestoneShown"
    /// No input for this long and the note waits: he's away, and it'd go by
    /// unseen. The app restarts itself onto a new build after just 5 s idle
    /// (`AppUpdater.autoRestartIdleTime`), so a short pause isn't being away.
    static let awayAfter: TimeInterval = 60

    private let defaults: UserDefaults
    let delay: Duration
    private let watchesInput: Bool
    let isHere: @MainActor () -> Bool
    /// The beat between the new thread opening and the note coming down.
    var showing: Task<Void, Never>?
    /// `threads.count` when last looked at, so a thread's every update doesn't
    /// count them again.
    var lastCount = -1
    private var inputMonitor: Any?

    init(defaults: UserDefaults = .standard, delay: Duration = .milliseconds(400), watchesInput: Bool = true,
         isHere: @escaping @MainActor () -> Bool = MilestoneWatch.mikeIsHere) {
        self.defaults = defaults
        self.delay = delay
        self.watchesInput = watchesInput
        self.isHere = isHere
    }

    var shown: Int? {
        get { defaults.object(forKey: Self.shownKey) as? Int }
        set { defaults.set(newValue, forKey: Self.shownKey) }
    }

    /// The main window's in front and someone's touched the Mac lately.
    static func mikeIsHere() -> Bool {
        guard NSApp.isActive, let window = MainWindowFrame.window, window.isVisible, !window.isMiniaturized,
              NSApp.keyWindow === window else { return false }
        return secondsIdle() < awayAfter
    }

    static func secondsIdle() -> TimeInterval {
        // ~0 is kCGAnyInputEventType, which Swift doesn't import.
        CGEventType(rawValue: ~0).map { CGEventSource.secondsSinceLastEventType(.combinedSessionState, eventType: $0) } ?? 0
    }

    /// Looks again at the next key or click in the app. On only while a note
    /// is waiting, so it costs nothing the rest of the time. Coming back to
    /// the app from elsewhere is `appBecameActive`.
    func lookAgainOnInput(_ look: @escaping @MainActor () -> Void) {
        guard watchesInput, inputMonitor == nil else { return }
        inputMonitor = NSEvent.addLocalMonitorForEvents(matching: [.keyDown, .leftMouseDown, .rightMouseDown, .otherMouseDown, .scrollWheel]) { event in
            Task { @MainActor in look() }
            return event
        }
    }

    func stopLookingOnInput() {
        if let inputMonitor { NSEvent.removeMonitor(inputMonitor) }
        inputMonitor = nil
    }
}

extension AppModel {
    /// Called wherever a thread might have turned up. Cheap: most calls are
    /// a thread's updates, with no change in the number of threads.
    func threadCountMayHaveChanged() {
        guard let milestones, milestones.lastCount != threads.count else { return }
        milestones.lastCount = threads.count
        considerMilestone()
    }

    /// Shows the milestone note if one's due and Mike's there to see it,
    /// otherwise leaves it due for the next look. It's only remembered as
    /// shown once it really is.
    func considerMilestone() {
        guard let milestones, threadsLoaded, milestones.showing == nil, milestoneNote == nil else { return }
        // Archived threads are in `threads` too. Deleted ones aren't, so the
        // count can lag a little behind what was really started; the tour's
        // made-up ones are left out.
        let count = threads.values.reduce(0) { $1.sample ? $0 : $0 + 1 }
        switch ThreadMilestones.decide(count: count, shown: milestones.shown) {
        case .nothing:
            milestones.stopLookingOnInput()
        case .remember(let tier):
            milestones.shown = tier
        case .show(let tier):
            guard canShowMilestoneNote else {
                milestones.lookAgainOnInput { [weak self] in self?.considerMilestone() }
                return
            }
            milestones.showing = Task {
                try? await Task.sleep(for: milestones.delay)
                milestones.showing = nil
                // He might have gone, or archived something, in the beat.
                guard canShowMilestoneNote else {
                    milestones.lookAgainOnInput { [weak self] in self?.considerMilestone() }
                    return
                }
                milestones.stopLookingOnInput()
                milestones.shown = tier
                milestoneNote = MilestoneNote(tier: tier)
            }
        }
    }

    private var canShowMilestoneNote: Bool {
        // The notes float in the same spot, so two never stack.
        archivedNote == nil && inboxEndNote == nil && milestones?.isHere() == true
    }

    func dismissMilestoneNote(_ id: UUID) {
        if milestoneNote?.id == id { milestoneNote = nil }
    }
}
