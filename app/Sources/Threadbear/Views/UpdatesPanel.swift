import AppKit
import SwiftUI
import ThreadbearCore

/// The rail's updates icon. Always there since the CLIs' versions and
/// their update settings moved into its panel (28 Oct). A grey dot while
/// something's on its way for the app, the runner or a CLI (or failed);
/// a small accent dot only when it needs Mike: a launch.mjs only he can
/// install. Anything else sorts itself out (a failed build retries once
/// main is fixed), so it asks nothing of him. The tooltip says what's
/// going on in a line or two; a click opens the panel, and a right-click
/// a little popover for updating the app (`AppUpdatePopover`).
struct UpdatesActivityButton: View {
    @Environment(AppModel.self) private var app
    private var updater: AppUpdater { AppUpdater.shared }

    var body: some View {
        @Bindable var app = app
        let side = UpdatesPanel.appSide(updater)
        let busy = UpdatesText.shown(app: side, runner: app.runnerUpdates) || app.clis.contains(where: UpdatesText.cliPending)
        ActivityButton(symbol: WindowDock.updatesSymbol, title: "Updates",
                       tip: UpdatesText.iconTooltip(app: side, runner: app.runnerUpdates, clis: app.clis),
                       dot: UpdatesText.needsYou(app: side, runner: app.runnerUpdates), quietDot: busy,
                       active: app.updatesShown) {
            app.updatesShown.toggle()
        }
        // The quick way to take an app update: a popover by the icon, not
        // the panel (Mike, 28 Oct).
        .onRightClick(id: "updates") { app.updatePopoverShown.toggle() }
        .popover(isPresented: $app.updatePopoverShown, arrowEdge: .trailing) {
            AppUpdatePopover().environment(app)
        }
    }
}

/// The right-click popover: the app's own update in a line, with Restart
/// to Update when a new version is ready. It changes as it goes, so one
/// opened mid-build gets its button when the build is staged.
struct AppUpdatePopover: View {
    @Environment(AppModel.self) private var app
    private var updater: AppUpdater { AppUpdater.shared }

    var body: some View {
        let side = UpdatesPanel.appSide(updater)
        VStack(alignment: .leading, spacing: zoomed(10)) {
            HStack(spacing: zoomed(7)) {
                if side.building && side.staged == nil {
                    SpinnerMark(color: .secondaryLabelColor)
                        .frame(width: zoomed(11), height: zoomed(11))
                }
                Text(UpdatesText.popoverLine(side))
                    .font(.system(size: zoomed(12)))
                    .fixedSize()
            }
            if let staged = updater.staged {
                Button("Restart to Update") {
                    app.updatePopoverShown = false
                    updater.restartToUpdate()
                }
                // Return takes it, as the popover is there for this.
                .keyboardShortcut(.defaultAction)
                .tip("Quit and reopen on \(staged.short). Running threads carry on in the runner.")
            } else if side.failed && !side.building {
                // Not while a newer main builds: the line is about that.
                Button("Show the Log") {
                    app.updatePopoverShown = false
                    OpenGate.openOwn(URL(fileURLWithPath: AppUpdater.logPath))
                }
                .tip("Open the update build's log, to see why it failed")
            }
        }
        .padding(zoomed(14))
    }
}

/// What's on its way for the app, the runner and the two CLIs, with the
/// one or two things Mike can do about each. A panel in the dock.
struct UpdatesPanel: View {
    @Environment(AppModel.self) private var app
    private var updater: AppUpdater { AppUpdater.shared }

    static func appSide(_ updater: AppUpdater) -> UpdatesText.AppSide {
        UpdatesText.AppSide(running: updater.running?.short, staged: updater.staged?.short,
                            building: updater.building != nil, failed: updater.failed != nil && updater.staged == nil)
    }

    var body: some View {
        let side = Self.appSide(updater)
        let runner = app.runnerUpdates
        ScrollView {
            VStack(alignment: .leading, spacing: zoomed(14)) {
                section("App") {
                    line(UpdatesText.appLine(side))
                    if side.staged != nil {
                        Button("Restart to Update") { updater.restartToUpdate() }
                            .tip("Quit and reopen on the new version. Running threads carry on in the runner.")
                    } else if side.failed {
                        Button("Show the Log") { OpenGate.openOwn(URL(fileURLWithPath: AppUpdater.logPath)) }
                            .tip("Open the update build's log, to see why it failed")
                    }
                }
                section("Runner") {
                    if let runner {
                        let lines = [UpdatesText.buildLine(runner), UpdatesText.oldRunnersLine(runner), UpdatesText.launcherLine(runner)]
                        if lines.allSatisfy({ $0 == nil }) { line("The runner is up to date.") }
                        if let build = lines[0] { line(build) }
                        if let old = lines[1] {
                            line(old)
                            // The threads on the previous version, to jump to.
                            ForEach(runner.oldRunners.flatMap(\.threads), id: \.self) { id in
                                Button {
                                    app.select(id)
                                } label: {
                                    Text(app.threads[id]?.title.nonEmpty ?? String(id.prefix(8)))
                                        .lineLimit(1)
                                        .frame(maxWidth: .infinity, alignment: .leading)
                                }
                                .buttonStyle(.link)
                                .font(.system(size: zoomed(12)))
                                .tip("Open this thread")
                            }
                        }
                        if let launcher = lines[2] {
                            line(launcher)
                            let command = UpdatesText.installCommand(checkout: updater.running?.checkout)
                            HStack(spacing: zoomed(6)) {
                                Text(command)
                                    .font(.system(size: zoomed(11), design: .monospaced))
                                    .textSelection(.enabled)
                                    .lineLimit(2)
                                Spacer(minLength: 0)
                                Button("Copy") { app.copyToPasteboard(command) }
                                    .tip("Copy the command, to run in Terminal")
                            }
                        }
                    } else {
                        ForEach(UpdatesText.runnerLines(nil), id: \.self) { line($0) }
                    }
                }
                // Mike's releases, on a fork; on Mike's own copy, the last
                // one it tagged.
                if let upstream = runner?.upstream, let text = UpdatesText.upstreamLine(upstream) {
                    section("From Mike") {
                        line(text)
                        if upstream.available, let release = upstream.release {
                            // Mike's plain-words notes, or commit subjects
                            // from a release made before there were any.
                            ForEach(Array(UpdatesText.releaseLines(release).enumerated()), id: \.offset) { _, group in
                                if let heading = group.heading {
                                    Text(heading)
                                        .font(.system(size: zoomed(11), weight: .medium))
                                        .padding(.top, zoomed(2))
                                }
                                ForEach(Array(group.lines.enumerated()), id: \.offset) { _, line in
                                    Text(line)
                                        .font(.system(size: zoomed(11)))
                                        .foregroundStyle(.secondary)
                                        .lineLimit(2)
                                }
                            }
                            HStack(spacing: zoomed(8)) {
                                Button("Bring Them In") { app.bringInUpstream(upstream) }
                                    .tip("Start a thread that merges Mike's release into your main. It asks before it lands.")
                                Button("Let's Discuss") { app.bringInUpstream(upstream, discuss: true) }
                                    .tip("Start a thread that talks the release through against your own changes first, and changes nothing until you say")
                                if app.creatingThread {
                                    SpinnerMark(color: .secondaryLabelColor).frame(width: zoomed(11), height: zoomed(11))
                                }
                            }
                            .disabled(app.creatingThread)
                        }
                    }
                }
                // The CLIs' versions and whether they update by themselves.
                // In Usage until 28 Oct; they're updates, not room.
                section("CLIs") {
                    CliSection()
                }
            }
            .padding(zoomed(16))
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    // Small headings, as the Usage panel groups its logins.
    private func section(_ title: String, @ViewBuilder _ content: () -> some View) -> some View {
        VStack(alignment: .leading, spacing: zoomed(7)) {
            Text(title)
                .font(.system(size: zoomed(11), weight: .medium))
                .foregroundStyle(.tertiary)
                .accessibilityAddTraits(.isHeader)
            content()
        }
    }

    private func line(_ text: String) -> some View {
        Text(text)
            .font(.system(size: zoomed(12)))
            .fixedSize(horizontal: false, vertical: true)
    }
}

/// The two CLIs: their versions, Update (or Update anyway, or Go back),
/// whether updates install by themselves, and when the runner last looked.
struct CliSection: View {
    @Environment(AppModel.self) private var app

    var body: some View {
        VStack(alignment: .leading, spacing: zoomed(12)) {
            if app.clisSupported == false || (app.clisSupported == nil && app.clis.isEmpty) {
                Text("The CLI versions need a newer runner.")
                    .font(.system(size: zoomed(12)))
                    .foregroundStyle(.secondary)
            } else {
                ForEach(app.clis) { cli in
                    CliRow(cli: cli)
                }
                HStack {
                    if let checked = CliText.checkedLine(app.clis, now: app.now) {
                        Text(checked).font(.system(size: zoomed(11))).foregroundStyle(.tertiary)
                    }
                    Spacer()
                    Button("Check now") { app.checkClis() }
                        .buttonStyle(.borderless)
                        .busy(app.isBusy(BusyKey.checkClis))
                        .tip("Look for new versions of the CLIs now")
                        .font(.system(size: zoomed(11)))
                }
            }
        }
    }
}

private struct CliRow: View {
    @Environment(AppModel.self) private var app
    let cli: CliStatus

    var body: some View {
        VStack(alignment: .leading, spacing: zoomed(6)) {
            HStack(alignment: .firstTextBaseline) {
                Text(CliText.statusLine(cli))
                    .font(.system(size: zoomed(12)))
                    .foregroundStyle(cli.status == "held" ? AnyShapeStyle(Color.orange) : AnyShapeStyle(.primary))
                    .fixedSize(horizontal: false, vertical: true)
                Spacer(minLength: zoomed(6))
                if let title = CliText.updateTitle(cli) {
                    Button(title) { app.updateCli(cli.provider, force: cli.status == "held") }
                        .controlSize(.small)
                        .busy(app.isBusy(BusyKey.updateCli(cli.provider)))
                        .tip(cli.status == "held" ? "Install it even though the check held it back" : "Install the new version now")
                }
            }
            if let text = CliText.isUpdating(cli) ? CliText.bannerText(cli) : nil {
                Text(text).font(.system(size: zoomed(11))).foregroundStyle(.secondary)
            }
            if let missing = cli.hold?.missing, !missing.isEmpty {
                Text("Missing: " + missing.joined(separator: ", "))
                    .font(.system(size: zoomed(11)))
                    .foregroundStyle(.tertiary)
                    .lineLimit(2)
            }
            if let managed = CliText.managedLine(cli) {
                Text(managed).font(.system(size: zoomed(11))).foregroundStyle(.tertiary)
            }
            HStack(spacing: zoomed(8)) {
                // A menu, not a segmented control: two rows of three
                // buttons were most of the popover's noise, and the choice
                // is set once and left.
                IconMenu {
                    ForEach(CliText.policies, id: \.self) { policy in
                        // A real tick beside the icon: the tick used to be
                        // the icon, so it was hidden along with all of them.
                        Toggle(CliText.policyTitle(policy), systemImage: CliText.policySymbol(policy), isOn: Binding(
                            get: { policy == cli.policy },
                            set: { _ in app.setCliPolicy(cli.provider, policy) }
                        ))
                    }
                } label: {
                    Text("Updates: " + CliText.policyTitle(cli.policy))
                }
                .menuStyle(.borderlessButton)
                .menuIndicator(.visible)
                .controlSize(.small)
                .fixedSize()
                .foregroundStyle(.secondary)
                // It already says the new setting (`setCliPolicy`).
                .disabled(app.isBusy(BusyKey.cliPolicy(cli.provider)))
                .tip("Whether new versions install by themselves")
                Spacer()
                if let back = CliText.goBackTitle(cli), let previous = cli.previousVersion {
                    Button(back) { app.updateCli(cli.provider, version: previous) }
                        .buttonStyle(.borderless)
                        .busy(app.isBusy(BusyKey.updateCli(cli.provider)))
                        .tip("Go back to the version you had before the last update")
                        .font(.system(size: zoomed(11)))
                }
            }
        }
    }
}

private extension String {
    var nonEmpty: String? { isEmpty ? nil : self }
}
