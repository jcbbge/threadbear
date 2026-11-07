import AppKit
import BearDock
import SwiftUI
import ThreadbearCore

/// The column of icons down the window's left edge, like VS Code's activity
/// bar: the sidebar's views at the top (threads, scheduled, projects, the
/// librarian) and Usage and Settings at the foot. These were rows in a
/// footer under the threads, which took about five rows' height from the list.
/// Hibernating and Archive had icons here too, until they became sections
/// at the foot of the threads (Mike, 29 Oct).
///
/// It's outside the dock (RootView), not part of the sidebar panel, so a
/// panel docked under the sidebar (Usage) or the sidebar moved elsewhere
/// leaves it the full height of the window, as VS Code's is (Mike, 28 Oct).
struct ActivityBar: View {
    @Environment(AppModel.self) private var app
    @Environment(\.openSettings) private var openSettings
    /// The highlight behind the view on show slides between icons in this.
    @Namespace private var activeSpace
    static var width: CGFloat { zoomed(44) }

    var body: some View {
        VStack(spacing: zoomed(4)) {
            // The traffic lights sit here, and it moves the window, as the
            // panels' bars beside it do.
            WindowGrip()
                .frame(height: RootView.options.headerHeight)
            // The views, together, for the tour to light up (not the
            // setup, updates and settings icons at the foot).
            VStack(spacing: zoomed(4)) {
            // How many threads are in the Inbox section, so Mike can see
            // how far off inbox zero he is from any view (29 Oct).
            ActivityButton(symbol: "bubble.left.and.bubble.right", title: "Threads", shortcut: AppShortcuts.shared.display(.showInbox),
                           badge: app.sections.inbox.count, active: app.sidebarMode == .inbox, slides: true) {
                app.sidebarMode = .inbox
            }
            // Only once the runner has said it knows about schedules.
            if app.schedulesSupported {
                ActivityButton(symbol: "clock", title: "Scheduled", shortcut: AppShortcuts.shared.display(.showScheduled),
                               badge: app.activeScheduleCount, active: app.sidebarMode == .scheduled, slides: true) {
                    app.showSchedules()
                }
            }
            // Only once the runner has said it knows about projects.
            if app.projectsSupported {
                ActivityButton(symbol: "square.stack.3d.up", title: "Projects", shortcut: AppShortcuts.shared.display(.showProjects),
                               active: app.sidebarMode == .projects, slides: true) {
                    app.showProjects()
                }
                // A count while it's looking at a thread or has some
                // waiting: what it's doing and about to do.
                ActivityButton(symbol: "books.vertical", title: "Librarian", shortcut: AppShortcuts.shared.display(.showLibrarian),
                               badge: app.librarian?.pendingCount, active: app.sidebarMode == .librarian, slides: true) {
                    app.showLibrarian()
                }
            }
            }
            .tourTarget(.activityBar)
            Spacer(minLength: zoomed(8))
            // Only while something's left to set up and it isn't hidden.
            SetupActivityButton()
            // Only once the runner has said it watches a gateway. It says
            // "off" when none is set up (most people, as the gateway is
            // optional), and a panel saying only that is no use.
            if let connectors = app.connectors, connectors.state != "off" {
                ConnectorsActivityButton()
            }
            // Only with more than one runner: a panel of just this Mac
            // says nothing new.
            if app.runners.count > 1 {
                RunnersActivityButton()
            }
            // Only while the app or the runner has an update on its way.
            UpdatesActivityButton()
            UsageActivityButton()
            // The same window as ⌘, without a trip to the menu bar.
            ActivityButton(symbol: "gearshape", title: "Settings", shortcut: AppShortcuts.shared.display(.settings), active: false) {
                openSettings()
            }
        }
        .environment(\.sidebarRowSpace, activeSpace)
        .animation(Juice.selection, value: app.sidebarMode)
        .padding(.bottom, zoomed(10))
        .frame(width: Self.width)
        .frame(maxHeight: .infinity)
        .overlay(alignment: .trailing) {
            Rectangle().fill(.separator).frame(width: 0.5)
        }
    }
}

/// "Usage", as a honey pot: every pool's logins and their room, in a panel of
/// its own (`UsagePanel`). Toggles it, as VS Code's bar does its views. Its tooltip
/// is the short version: each pool's best room (Mike, 28 Oct).
private struct UsageActivityButton: View {
    @Environment(AppModel.self) private var app

    var body: some View {
        let groups = UsageGroups.build(pools: app.poolsSupported ? app.pools : [], accounts: app.accounts)
        // Filled to the room on the login the next new thread would use.
        let login = app.newThreadAccountId
        let usage = app.draftLogins.account(login)?.usage
        ActivityButton(custom: AnyView(HoneyPot(level: HoneyLevel.level(usage), login: login)),
                       title: "Usage", tip: UsageGroups.tooltip(groups, now: app.now),
                       active: app.usageShown) {
            app.usageShown.toggle()
        }
    }
}

/// One icon in the bar: grey, primary with a faint square when it's the
/// view on show, and a small count in its corner when there is one, or a
/// dot when something there needs Mike.
struct ActivityButton: View {
    var symbol: String? = nil
    /// Drawn instead of a symbol (the sleeping bear).
    var image: NSImage? = nil
    /// False draws `image` as it is, in colour: a tool's own icon, which is
    /// how it's recognised. True tints it like the symbols (the bear).
    var tinted = true
    /// Drawn instead of either (Usage's honey pot).
    var custom: AnyView? = nil
    let title: String
    /// The tooltip, when it says more than the title (Usage's and Updates'
    /// short summaries).
    var tip: String? = nil
    var shortcut: String? = nil
    var badge: Int? = nil
    /// Accent, unlike the counts: it means something needs Mike.
    var dot: Bool = false
    /// The same dot in grey, when `dot` isn't set: something's going on
    /// that sorts itself out, like an update on its way.
    var quietDot: Bool = false
    let active: Bool
    /// One of the sidebar's views: the highlight slides between these.
    /// Usage and Settings open beside the view, so theirs just shows.
    var slides = false
    let action: () -> Void
    @State private var hovering = false
    /// Counts clicks, to give the icon a little bounce on each.
    @State private var taps = 0
    @Environment(\.controlActiveState) private var activeState
    @Environment(\.sidebarRowSpace) private var activeSpace

    var body: some View {
        Button {
            if !Juice.reduceMotion { taps += 1 }
            action()
        } label: {
            icon
                .foregroundStyle(active || hovering ? AnyShapeStyle(.primary) : AnyShapeStyle(.secondary))
                // Pressed in a touch, then back with a small overshoot.
                .keyframeAnimator(initialValue: 1.0, trigger: taps) { icon, scale in
                    icon.scaleEffect(scale)
                } keyframes: { _ in
                    KeyframeTrack {
                        CubicKeyframe(0.82, duration: 0.08)
                        SpringKeyframe(1, duration: 0.35, spring: .bouncy(duration: 0.35, extraBounce: 0.25))
                    }
                }
                .frame(width: zoomed(32), height: zoomed(32))
                .background {
                    ZStack {
                        if hovering && !active {
                            RoundedRectangle(cornerRadius: SidebarMetrics.corner).fill(SidebarMetrics.hover)
                                .transition(.opacity)
                        }
                        // Slides to whichever view is on show.
                        if active {
                            RoundedRectangle(cornerRadius: SidebarMetrics.corner)
                                .fill(Color.primary.opacity(activeState == .key ? 0.08 : 0.06))
                                .matched("active", in: slides ? activeSpace : nil)
                        }
                    }
                    .animation(Juice.hover, value: hovering)
                }
                .overlay(alignment: .topTrailing) {
                    if let badge, badge > 0 {
                        // Grey, not accent: a count of what's there, not an
                        // alarm. The rows themselves say which need Mike.
                        Text(badge > 99 ? "99+" : "\(badge)")
                            .font(.system(size: zoomed(9), weight: .semibold))
                            .monospacedDigit()
                            // The number rolls when it changes.
                            .contentTransition(.numericText(value: Double(badge)))
                            .foregroundStyle(.secondary)
                            .padding(.horizontal, zoomed(3.5))
                            .frame(minWidth: zoomed(14), minHeight: zoomed(14))
                            .background(Color(nsColor: .windowBackgroundColor), in: Capsule())
                            .overlay(Capsule().strokeBorder(.separator, lineWidth: 0.5))
                            .offset(x: zoomed(3), y: -zoomed(2))
                            .allowsHitTesting(false)
                            .transition(Juice.popIn)
                    } else if dot || quietDot {
                        Circle()
                            .fill(dot ? AnyShapeStyle(Color.accentColor) : AnyShapeStyle(.secondary))
                            .frame(width: zoomed(7), height: zoomed(7))
                            .overlay(Circle().strokeBorder(Color(nsColor: .windowBackgroundColor), lineWidth: 1.5))
                            .offset(x: zoomed(1), y: zoomed(1))
                            .allowsHitTesting(false)
                            .transition(Juice.popIn)
                    }
                }
                .animation(Juice.pop, value: badge ?? 0)
                .animation(Juice.pop, value: dot || quietDot)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .shortcutHint(shortcut, .after)
        .onHover { hovering = $0 }
        .tip(tip ?? shortcut.map { "\(title) (\($0))" } ?? title)
        .accessibilityLabel(title)
        .accessibilityValue(dot ? "Needs you" : badge.map { $0 > 0 ? "\($0)" : "" } ?? "")
        .accessibilityAddTraits(active ? [.isSelected] : [])
    }

    @ViewBuilder
    private var icon: some View {
        if let custom {
            custom
        } else if let image {
            // The bear, tinted like the symbols.
            Image(nsImage: image)
                .renderingMode(tinted ? .template : .original)
                .resizable()
                .aspectRatio(contentMode: .fit)
                .frame(width: zoomed(21), height: zoomed(21))
        } else if let symbol {
            Image(systemName: symbol)
                .font(.system(size: zoomed(15)))
        }
    }
}
