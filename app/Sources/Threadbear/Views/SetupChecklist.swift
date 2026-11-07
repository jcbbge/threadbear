import AppKit
import SwiftUI
import ThreadbearCore

/// "Finish setting up": what's left after `./threadbear setup` for a new
/// install, in a panel under the threads (like Usage) with an icon on the
/// activity bar while anything's left. Each item ticks itself off from what
/// the app already knows, so there's nothing to mark done by hand. It took
/// the place of a post-install script (Mike, 28 Oct), and of printing the
/// pairing commands at the end of setup.
///
/// Notifications aren't on it: Mike finds them a bit annoying, so they're
/// not pushed on anyone (macOS still asks once at first launch). The phone
/// is pitched for asking and steering while you're out (29 Oct).
///
/// Tailscale isn't on it: nothing in Threadbear uses Tailscale yet (the
/// runner only listens on 127.0.0.1, docs/setup-and-updates.md). Add it
/// once the phone fetches tool output over it (2.5 there).
enum SetupItem: String, CaseIterable, Identifiable {
    case firstThread, phone, website
    var id: String { rawValue }
}

struct SetupChecklist: Equatable {
    /// In order, with whether each is done. Items that can't be done on
    /// this install (no Convex mirror, so nothing for a phone to read) are
    /// left out rather than shown stuck.
    var items: [(item: SetupItem, done: Bool)]
    /// No Claude Code or Codex login found: the first thread can't run.
    var noLogin: Bool

    var left: Int { items.filter { !$0.done }.count }

    static func == (a: SetupChecklist, b: SetupChecklist) -> Bool {
        a.items.map(\.item) == b.items.map(\.item) && a.items.map(\.done) == b.items.map(\.done) && a.noLogin == b.noLogin
    }

    static func build(threads: some Collection<ThreadSummary>, accounts: [Account], devices: [Device],
                      canPair: Bool) -> SetupChecklist {
        // A turn that reached the model (it reported a cost or how full
        // the context is): the login worked. Not the session id, which a
        // thread gets when it's made, the tour's turnless Welcome one too.
        let ran = threads.contains { ($0.costUsd != nil || $0.contextTokens != nil) && $0.status != .error }
        var items: [(SetupItem, Bool)] = [(.firstThread, ran)]
        if canPair {
            let live = devices.filter { !$0.expired }
            items.append((.phone, live.contains { $0.kind == .phone }))
            items.append((.website, live.contains { $0.kind == .browser }))
        }
        return SetupChecklist(items: items, noLogin: accounts.isEmpty)
    }
}

/// Whether Mike hid the list (Hide this list), kept across launches.
@MainActor
@Observable
final class SetupState {
    static let shared = SetupState()
    static let hiddenKey = "setupHidden"

    var hidden: Bool {
        didSet { defaults.set(hidden, forKey: Self.hiddenKey) }
    }
    @ObservationIgnored let defaults: UserDefaults

    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
        hidden = defaults.bool(forKey: Self.hiddenKey)
    }
}

extension AppModel {
    var setupChecklist: SetupChecklist {
        SetupChecklist.build(threads: threads.values, accounts: accounts, devices: devices,
                             canPair: devicesLoaded && devicesReason == nil && !devicesUnsupported)
    }

    /// The activity bar's icon for it shows while something's left and
    /// Mike hasn't hidden it.
    var setupShowsIcon: Bool { !SetupState.shared.hidden && setupChecklist.left > 0 }

    /// Help > Finish Setting Up: back from hidden, and open.
    func showSetup() {
        SetupState.shared.hidden = false
        setupShown = true
    }
}

/// The icon on the activity bar, with how many are left.
struct SetupActivityButton: View {
    @Environment(AppModel.self) private var app

    var body: some View {
        if app.setupShowsIcon {
            ActivityButton(symbol: WindowDock.setupSymbol, title: "Finish setting up", badge: app.setupChecklist.left,
                           active: app.setupShown) {
                app.setupShown.toggle()
            }
            .transition(Juice.popIn)
        }
    }
}

/// The panel: one row per item, ticked or with what to press.
struct SetupPanel: View {
    @Environment(AppModel.self) private var app

    var body: some View {
        let checklist = app.setupChecklist
        ScrollView {
            VStack(alignment: .leading, spacing: zoomed(14)) {
                if checklist.left == 0 {
                    HStack(spacing: zoomed(10)) {
                        Image(nsImage: Bear.image(.wave, side: zoomed(36)))
                            .renderingMode(.template)
                            .foregroundStyle(.secondary)
                            .accessibilityHidden(true)
                        Text("All set.")
                            .font(.system(size: TypeScale.cardTitle, weight: .semibold))
                    }
                }
                ForEach(checklist.items, id: \.item) { entry in
                    SetupRow(item: entry.item, done: entry.done, noLogin: checklist.noLogin)
                }
                if checklist.left > 0 {
                    Button("Hide this list") {
                        SetupState.shared.hidden = true
                        app.setupShown = false
                    }
                    .buttonStyle(.plain)
                    .foregroundStyle(.secondary)
                    .font(.system(size: TypeScale.detail))
                    .tip("Help > Finish Setting Up brings it back")
                }
            }
            .padding(zoomed(14))
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .animation(Juice.swap, value: checklist)
        .onAppear {
            app.loadDevices()
        }
    }
}

private struct SetupRow: View {
    @Environment(AppModel.self) private var app
    let item: SetupItem
    let done: Bool
    let noLogin: Bool
    @State private var opening = false

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: zoomed(10)) {
            Image(systemName: done ? "checkmark.circle.fill" : "circle")
                .font(.system(size: TypeScale.label))
                .foregroundStyle(.secondary)
                .contentTransition(.symbolEffect(.replace))
            VStack(alignment: .leading, spacing: zoomed(4)) {
                Text(title)
                    .font(.system(size: TypeScale.label, weight: .medium))
                    .foregroundStyle(done ? .secondary : .primary)
                if !done {
                    Text(detail)
                        .font(.system(size: TypeScale.detail))
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                    action
                        .controlSize(.small)
                        .padding(.top, zoomed(2))
                }
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityValue(done ? "Done" : "To do")
    }

    private var title: String {
        switch item {
        case .firstThread: "Start your first thread"
        case .phone: "Pair your iPhone"
        case .website: "Open your website"
        }
    }

    private var detail: String {
        switch item {
        case .firstThread:
            noLogin
                ? "There's no Claude Code or Codex login on this Mac yet. Run claude or codex in Terminal and log in, then come back."
                : "It shows your Claude Code or Codex login works. Try asking what's in the folder."
        case .phone: "Ask questions and steer your threads while you're out, and see how they're getting on."
        case .website: "Check on your threads from any browser, with a link for each."
        }
    }

    @ViewBuilder
    private var action: some View {
        switch item {
        case .firstThread:
            if !noLogin {
                Button("New thread") { app.newThread() }
                    .tip(AppShortcuts.shared.tip("A new thread, in your threads folder unless you pick another", .newThread))
            }
        case .phone:
            Button("Open Phone & browser") {
                app.settingsTab = .devices
                app.settingsRequest += 1
            }
            .tip("Settings › Phone & browser, where Show the code… gives the iPhone app a code to scan")
        case .website:
            Button("Open signed in") {
                opening = true
                Task {
                    await app.openWebsiteSignedIn()
                    opening = false
                }
            }
            .busy(opening)
            .tip("Opens your Threadbear website in \(DefaultBrowser.current()?.name ?? "your browser"), signed in for 90 days")
        }
    }
}
