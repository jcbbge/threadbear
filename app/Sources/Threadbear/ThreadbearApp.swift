import AppKit
import SwiftUI
import ThreadbearCore
import UserNotifications

@main
struct ThreadbearApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var delegate
    @State private var app = AppModel.shared
    @State private var zoom = TextZoom.shared
    @State private var updater = AppUpdater.shared

    init() {
        // A build staged while the app was last running (and it was killed
        // rather than quit, or quitting couldn't swap it): put it in place
        // and start again as the new app, before anything else is set up.
        if AppUpdater.applyStagedAtLaunch() { exit(0) }
        // As early as can be, to catch a crash at launch. Only in the
        // installed release build (CrashReporting says why).
        CrashReporting.start()
        UserDefaults.standard.register(defaults: [
            // AppKit treats command-line arguments it can't pair up as files
            // to open, and then skips opening the window.
            // `--perf-run --stream-seconds 5` leaves "5" over.
            "NSTreatUnknownArgumentsAsOpen": "NO",
            // After a kill (or a crash) AppKit "restores" a saved state with
            // no window in it and SwiftUI then opens nothing. There's no
            // window state worth restoring here; the frame autosaves anyway.
            "ApplePersistenceIgnoreState": "YES",
        ])
    }

    var body: some Scene {
        Window("Threadbear", id: "main") {
            RootView()
                .environment(app)
                // Links in SwiftUI text go through OpenGate.
                .environment(\.openURL, OpenGate.urlAction(files: .unknown))
                // A click counts while another app is in front, rather than
                // only bringing the window forward (FirstClick.swift).
                .allowsWindowActivationEvents()
                .frame(minWidth: 760, minHeight: 480)
                .onAppear { LaunchClock.windowShown() }
        }
        .defaultSize(width: 1180, height: 800)
        // The panels' bars are the top of the window (WindowDock): no title
        // bar, the traffic lights over the top-left panel's bar.
        .windowStyle(.hiddenTitleBar)
        // Always open the window at launch. With restoration on, a saved
        // state with no window (closing the window quits the app, and so
        // does a kill) made the next launch show nothing at all. The frame
        // is still remembered through the window's autosave.
        .defaultLaunchBehavior(.presented)
        .restorationBehavior(.disabled)
        .commands {
            // The app menu's Settings… made here rather than left to the
            // Settings scene, so its key comes from the shortcut list and
            // Settings > Keyboard can change it. It opens the same window.
            CommandGroup(replacing: .appSettings) {
                IconMenuItems {
                    SettingsLink { Label("Settings…", systemImage: "gearshape") }
                        .shortcut(.settings)
                }
            }
            // The Den, in place of the stock About panel.
            CommandGroup(replacing: .appInfo) {
                IconMenuItems {
                    Button("About Threadbear", systemImage: "pawprint") { DenWindow.show(app: app) }
                    // Only while a newer build is staged (AppUpdater).
                    if let staged = updater.staged {
                        Button("Restart to Update to \(staged.short)", systemImage: "arrow.clockwise") { updater.restartToUpdate() }
                    }
                }
            }
            CommandGroup(replacing: .newItem) {
                IconMenuItems {
                    Button("New Thread", systemImage: "square.and.pencil") { app.newThread() }
                        .shortcut(.newThread)
                }
            }
            // In the View menu, as the Electron agent apps and Safari have
            // it. ⌘= is the key under the + sign, so ⌘+ works without shift.
            CommandGroup(after: .toolbar) {
                IconMenuItems {
                    Button("Zoom In", systemImage: "plus.magnifyingglass") { zoom.zoomIn() }
                        .shortcut(.zoomIn)
                        .disabled(!zoom.canZoomIn)
                    Button("Zoom Out", systemImage: "minus.magnifyingglass") { zoom.zoomOut() }
                        .shortcut(.zoomOut)
                        .disabled(!zoom.canZoomOut)
                    Button("Actual Size", systemImage: "1.magnifyingglass") { zoom.reset() }
                        .shortcut(.actualSize)
                        .disabled(zoom.isDefault)
                    Divider()
                    // The sidebar's panel, with the key other Mac apps use.
                    Button(app.dock.layout.contains(WindowDock.threads) ? "Hide Threads" : "Show Threads", systemImage: "sidebar.left") { app.toggleThreadsPanel() }
                        .shortcut(.toggleThreads)
                    // The pane sections (Highlights, a project's panels, Patches)
                    // open in the dock (WindowDock).
                    Button(app.panelsShown ? "Hide Panels" : "Show Panels", systemImage: "sidebar.right") { app.togglePanels() }
                        .shortcut(.togglePanels)
                    Button("Reset Panel Layout", systemImage: "rectangle.3.group") { app.dock.setLayout(WindowDock.defaultLayout) }
                        .shortcut(.resetPanelLayout)
                }
            }
            // Back and forward through the threads and views, as Safari
            // and Finder have them. The mouse's side buttons do the same
            // (MouseNavigation), and so do trackpad swipes (SwipeNavigation).
            CommandMenu("Go") {
                IconMenuItems {
                    Button("Back", systemImage: "chevron.left") { app.goBack() }
                        .shortcut(.back)
                        .disabled(!app.canGoBack)
                    Button("Forward", systemImage: "chevron.right") { app.goForward() }
                        .shortcut(.forward)
                        .disabled(!app.canGoForward)
                    Divider()
                    Button("Next Inbox Thread", systemImage: "chevron.down") { app.nextInboxThread() }
                        .shortcut(.nextInboxThread)
                }
            }
            // Help has no help book to open: the tour is what there is.
            CommandGroup(replacing: .help) {
                IconMenuItems {
                    Button("Take the Tour", systemImage: "map") { Tour.shared.start() }
                    Button("Finish Setting Up", systemImage: "checklist") { app.showSetup() }
                }
            }
            CommandMenu("Thread") {
                IconMenuItems {
                    Button(app.selectedThread?.isArchived == true ? "Unarchive" : "Archive", systemImage: app.selectedThread?.isArchived == true ? "tray.and.arrow.up" : "archivebox") { app.toggleArchive() }
                        .shortcut(.archive)
                        .disabled(app.selection == nil)
                    IconMenu("Hibernate", systemImage: "moon.zzz") {
                        // Titles follow app.now (so the menu rebuilds as time
                        // passes); the date is worked out when the item is chosen.
                        ForEach(Snooze.presets(now: app.now)) { preset in
                            Button(preset.title, systemImage: preset.symbol) { app.snooze(until: Snooze.date(for: preset.id, now: Date())) }
                        }
                        if app.restartPending {
                            Button(Snooze.untilRestartTitle, systemImage: "arrow.clockwise") { app.snoozeUntilRestart() }
                        }
                        Divider()
                        // Hibernate's key: a submenu can't have one, and
                        // the picker's the one item that always makes sense.
                        Button("Pick a time…", systemImage: "calendar") {
                            if let id = app.selection { SnoozePicker.show(threadId: id, app: app) }
                        }
                        .shortcut(.hibernate)
                        Button(WakeWords.menuTitle, systemImage: "text.bubble") {
                            if let id = app.selection { WakeWhenPrompt.show(threadId: id, app: app) }
                        }
                    }
                    .disabled(app.selection == nil)
                    Button("Stop", systemImage: "stop.circle") { app.interrupt() }
                        .shortcut(.stop)
                        .disabled(app.selectedThread?.status.isBusy != true || app.selection.map { app.isBusy(BusyKey.stop($0)) } == true)
                    Divider()
                    Button("Copy Transcript as Markdown", systemImage: "doc.plaintext") {
                        if let id = app.selection { app.session(for: id).copyTranscript() }
                    }
                    .shortcut(.copyTranscript)
                    .disabled(app.selection.map { app.isBusy(BusyKey.copying($0)) } ?? true)
                    Divider()
                    // ⌘1 to ⌘4 in the activity bar's order, as VS Code numbers
                    // its views. Hibernating and Archive are sections of the
                    // inbox now: these unfold them.
                    Button("Show Inbox", systemImage: "tray") { app.sidebarMode = .inbox }
                        .shortcut(.showInbox)
                    Button("Show Scheduled", systemImage: "clock") { app.showSchedules() }
                        .shortcut(.showScheduled)
                        .disabled(!app.schedulesSupported)
                    Button("Show Projects", systemImage: "square.stack") { app.showProjects() }
                        .shortcut(.showProjects)
                        .disabled(!app.projectsSupported)
                    Button("Show Librarian", systemImage: "books.vertical") { app.showLibrarian() }
                        .shortcut(.showLibrarian)
                        .disabled(!app.projectsSupported)
                    Divider()
                    Button("Show Hibernating", systemImage: "moon.zzz") { app.showHibernating() }
                        .shortcut(.showHibernating)
                    Button("Show Archived", systemImage: "archivebox") { app.showArchive() }
                        .shortcut(.showArchived)
                }
            }
        }
        // ⌘, (the app menu's Settings…): the runner's settings.
        Settings {
            SettingsView()
                .environment(app)
        }
    }
}

final class AppDelegate: NSObject, NSApplicationDelegate, UNUserNotificationCenterDelegate {
    /// A thread link that came in before the thread list loaded (it started the app).
    private var linkedThread: String?

    func applicationDidFinishLaunching(_ notification: Notification) {
        // A voice server the last run left behind by crashing (VoiceServer).
        VoiceServer.reapLeftover()
        MainActor.assumeIsolated {
            let app = AppModel.shared
            let arguments = CommandLine.arguments
            // Before any window draws. Automation's --appearance comes later and wins.
            AppAppearance.saved().apply()
            if AppUpdater.isInstalledApp {
                HangWatch.start(folder: HangWatch.defaultFolder, build: BuildInfo.read(bundle: Bundle.main.bundleURL)?.short, report: CrashReporting.reportHang)
            }
            #if DEBUG
            // Before anything connects.
            if Automation.refusesLiveRunner(dataDir: app.dataDir) { Automation.refuseLiveRunner() }
            #endif
            let perf = arguments.contains("--perf-run")
            let screenshots = arguments.contains("--screenshots")
            // Scripted runs (perf, screenshots, a test driving the app) post
            // no banners on the screen of whoever is using the Mac.
            #if DEBUG
            let scripted = perf || screenshots || arguments.contains("--automation")
            #else
            let scripted = perf || screenshots
            #endif
            // A handover's incoming app stays quiet until it takes over:
            // the outgoing one is still posting banners.
            app.notificationsEnabled = !scripted && Handover.incomingFrom == nil
            ShortcutHints.shared.install()
            // Before anything can start the tour: its samples and hands-on
            // steps need the model from its first step.
            Tour.shared.app = app
            // Not over the pages a screenshot, perf or scripted run opens.
            Tour.shared.introsEnabled = !scripted
            if !scripted { Notifier.setUp(delegate: self) }
            if !scripted { app.milestones = MilestoneWatch() }
            app.onThreadsLoaded = { [weak self] in
                LaunchClock.threadsLoaded()
                if let threadId = self?.linkedThread {
                    self?.linkedThread = nil
                    self?.show(threadId: threadId)
                }
                // After a restart the app made itself for an update: back
                // to where it was (a no-op otherwise).
                AppUpdater.restoreAfterRestart(app: app)
                // Someone's first launch: a look round the window, once
                // it's drawn with their threads in it. Never in a scripted
                // run (the automation's `tour` starts it there).
                // The checklist's phone and website items need the list.
                if !SetupState.shared.hidden { app.loadDevices() }
                if !scripted {
                    DispatchQueue.main.asyncAfter(deadline: .now() + 0.6) { Tour.shared.startIfNew() }
                }
            }
            app.start()
            MouseNavigation.install(app: app)
            SwipeNavigation.shared.install(app: app)
            // Records nothing unless it's switched on in Settings.
            ActivityRecorder.shared.install(app: app)
            MenuWatch.install()
            // Takes the window off the drag Space a drag can leave it on,
            // which hides every menu (macOS 27.2).
            DragSpace.install()
            if perf { PerfRunner.start(app: app) }
            if screenshots { ScreenshotRunner.start(app: app) }
            // What only one of two Threadbears should run: a handover's
            // incoming app starts these once the outgoing one has gone.
            let takeOver = {
                app.notificationsEnabled = !scripted
                #if DEBUG
                Automation.startIfAsked(app: app)
                #endif
                AppUpdater.shared.start()
            }
            if Handover.incomingFrom != nil {
                Handover.shared.startIncoming(app: app, takeOver: takeOver)
            } else {
                takeOver()
            }
        }
    }

    func applicationWillTerminate(_ notification: Notification) {
        MainActor.assumeIsolated {
            ActivityRecorder.shared.quit()
            VoiceMode.shared.stop()
            VoiceServer.shared.stop()
            AppUpdater.shared.applyAtQuit()
        }
    }

    func applicationDidBecomeActive(_ notification: Notification) {
        MainActor.assumeIsolated { AppModel.shared.appBecameActive() }
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }

    // The completion-handler forms, not `async`: Swift calls an async
    // delegate method's handler from a background thread when its task
    // ends, which crashed the iPhone app on a tapped push
    // (THREADBEAR-12). Each handler is called on the main actor.
    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse, withCompletionHandler completionHandler: @escaping @Sendable () -> Void) {
        let threadId = response.notification.request.content.userInfo["threadId"] as? String
        Task { @MainActor in
            NSApp.activate()
            // A tap that started the app waits for the thread list, as a link does.
            if let threadId {
                if AppModel.shared.threadsLoaded { show(threadId: threadId) } else { linkedThread = threadId }
            }
            completionHandler()
        }
    }

    /// `threadbear://thread/<id>` (ThreadLink): the thread comes up as it
    /// does from a notification. Opening BrowserBear's pill on an agent's
    /// Chrome tab sends one.
    func application(_ application: NSApplication, open urls: [URL]) {
        MainActor.assumeIsolated {
            guard let threadId = urls.lazy.compactMap(ThreadLink.threadId(from:)).last else { return }
            NSApp.activate()
            if AppModel.shared.threadsLoaded { show(threadId: threadId) } else { linkedThread = threadId }
        }
    }

    @MainActor private func show(threadId: String) {
        AppModel.shared.sidebarMode = .inbox
        AppModel.shared.select(threadId)
    }

    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification, withCompletionHandler completionHandler: @escaping @Sendable (UNNotificationPresentationOptions) -> Void) {
        Task { @MainActor in completionHandler([.banner, .sound]) }
    }
}

/// Launch timing for the perf report: process start to window and to a
/// loaded thread list.
@MainActor
enum LaunchClock {
    static var windowMs: Double?
    static var threadsMs: Double?

    static func windowShown() {
        if windowMs == nil { windowMs = sinceLaunch() }
    }

    static func threadsLoaded() {
        if threadsMs == nil { threadsMs = sinceLaunch() }
    }

    static func sinceLaunch() -> Double {
        var info = kinfo_proc()
        var size = MemoryLayout<kinfo_proc>.stride
        var mib: [Int32] = [CTL_KERN, KERN_PROC, KERN_PROC_PID, getpid()]
        guard sysctl(&mib, 4, &info, &size, nil, 0) == 0 else { return 0 }
        let start = info.kp_proc.p_starttime
        let started = Double(start.tv_sec) + Double(start.tv_usec) / 1_000_000
        return (Date().timeIntervalSince1970 - started) * 1000
    }
}
