import SwiftUI
import ThreadbearKit

/// First run, or after the token's been refused: pair with the Mac by
/// scanning the QR code from the Mac app's Settings › Phone & browser.
struct PairView: View {
    @Environment(AppModel.self) private var model
    @State private var scanning = false
    /// The code the scanner read, asked about once its sheet has gone, so
    /// the alert isn't put up while the sheet is still leaving.
    @State private var scanned: URL?

    var body: some View {
        VStack(spacing: 24) {
            Spacer()
            BearView(pose: .sit, size: 96)
                .foregroundStyle(.secondary)
            VStack(spacing: 10) {
                Text("Pair with your Mac").font(.title2.weight(.semibold))
                Text("In Threadbear on your Mac, go to **Settings › Phone & browser › Show the code**, then scan it.")
                    .multilineTextAlignment(.center)
                    .foregroundStyle(.secondary)
            }
            Button {
                model.clearError()
                scanning = true
            } label: {
                if model.isPairing {
                    ProgressView().frame(maxWidth: .infinity)
                } else {
                    Label("Scan the code", systemImage: "qrcode.viewfinder").frame(maxWidth: .infinity)
                }
            }
            .buttonStyle(.borderedProminent)
            .controlSize(.large)
            .disabled(model.isPairing)
            if let problem = model.authProblem {
                Text("The server stopped accepting this phone's token (\(problem)). Pair again to carry on.")
                    .font(.footnote)
                    .multilineTextAlignment(.center)
                    .foregroundStyle(.red)
            }
            if let error = model.lastError {
                Text(error).font(.footnote).multilineTextAlignment(.center).foregroundStyle(.red)
            }
            Spacer()
            // For when the link came another way (Messages to yourself).
            Button("Paste a pairing link") {
                guard let raw = UIPasteboard.general.string, let url = URL(string: raw.trimmingCharacters(in: .whitespacesAndNewlines)) else {
                    model.report(TransportError.server("There's no link on the clipboard."))
                    return
                }
                // The clipboard is anyone's to fill, so this is asked about too.
                model.askToPair(url)
            }
            .font(.subheadline)
            // Made-up threads on the phone only, for a look before there's
            // a Mac to pair with (and for App Review).
            Button("Look around with sample threads") { model.startDemo() }
                .font(.subheadline)
                .foregroundStyle(.secondary)
        }
        .padding(32)
        .fullScreenCover(isPresented: $scanning, onDismiss: {
            if let url = scanned { model.askToPair(url) }
            scanned = nil
        }) {
            // Only a Threadbear pairing link ends the scan; any other code
            // in view is ignored.
            ScanSheet(accept: { $0.hasPrefix("threadbear://pair") }) { code in
                guard let url = URL(string: code) else { return }
                // The sheet has already dismissed itself.
                scanned = url
            }
        }
    }
}

struct SettingsView: View {
    @Environment(AppModel.self) private var model
    @State private var identity: PhoneIdentity?
    @State private var confirmUnpair = false

    var body: some View {
        Form {
            Section("Paired with") {
                LabeledContent("Server", value: model.pairing.map { Pairing.serverName($0.deploymentURL) } ?? (model.isFake ? "Sample data" : "None"))
                if let identity {
                    LabeledContent("Phone", value: identity.name)
                    if let expires = identity.expiresAt {
                        LabeledContent("Token expires", value: expires.formatted(date: .abbreviated, time: .omitted))
                    }
                }
                if !model.canChooseRunner {
                    ForEach(model.runners) { runner in
                        LabeledContent(runner.name, value: runnerStatus(runner))
                    }
                }
            }
            if model.canChooseRunner {
                Section {
                    ForEach(model.runners) { runner in
                        LabeledContent(runner.name, value: runnerStatus(runner))
                    }
                    NavigationLink("Change the order") { RunnerOrderView() }
                } header: {
                    Text("Runners")
                } footer: {
                    Text("New threads start on the first one that's online.")
                }
            }
            if identity?.pushOff == true {
                // A self-hosted backend: the push relay only reaches Convex
                // cloud, so say why nothing comes rather than offer a picker
                // that does nothing (docs/self-hosting.md).
                Section("Notifications") {
                    Label("Your Threadbear backend is self-hosted, so it can't send notifications. Open the app to see what needs you.", systemImage: "bell.slash")
                        .foregroundStyle(.secondary)
                }
            } else if model.canChooseNotifications {
                Section("Notify me") {
                    Picker("Notify me", selection: Binding(get: { model.notifyMode }, set: { model.setNotifyMode($0) })) {
                        ForEach(NotifyMode.allCases, id: \.self) { Text($0.label).tag($0) }
                    }
                    .pickerStyle(.inline)
                    .labelsHidden()
                }
            }
            DictationSettingsSection()
            QuickAskSettingsSection()
            if model.isFake {
                Section {
                    Button("Leave the demo") { model.leaveDemo() }
                } footer: {
                    Text("These are made-up threads, kept on this phone. Leaving goes back to pairing with your Mac.")
                }
            } else {
                Section {
                    Button("Unpair this phone", role: .destructive) { confirmUnpair = true }
                } footer: {
                    Text("Forgets the token on this phone. Revoke it on the Mac too if the phone's lost.")
                }
            }
        }
        .navigationTitle("Settings")
        .task {
            identity = try? await model.backend?.me()
        }
        .confirmationDialog("Unpair this phone?", isPresented: $confirmUnpair, titleVisibility: .visible) {
            Button("Unpair", role: .destructive) { model.unpair() }
        }
    }

    private func runnerStatus(_ runner: PhoneRunner) -> String {
        runner.isOnline(at: model.now) ? "Online" : "Last seen \(RelativeTime.clock(runner.lastSeenAt, now: model.now))"
    }
}

/// The runners in Mike's order, to drag about: new threads start on the
/// first one online (phone:setRunnerOrder). Its own screen because a Form's
/// rows only show drag handles with the whole list in edit mode.
struct RunnerOrderView: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        List {
            Section {
                ForEach(model.runners) { runner in
                    LabeledContent(runner.name, value: runner.isOnline(at: model.now) ? "Online" : "Offline")
                }
                .onMove { from, to in
                    var order = model.runners
                    order.move(fromOffsets: from, toOffset: to)
                    model.setRunnerOrder(order)
                }
            } footer: {
                Text("New threads start on the first one that's online. Drag to change the order.")
            }
        }
        .environment(\.editMode, .constant(.active))
        .navigationTitle("Runner order")
        .navigationBarTitleDisplayMode(.inline)
    }
}
