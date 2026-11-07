import AppKit
import SwiftUI
import ThreadbearCore

/// The share icon beside the thread's ... menu: whether anyone with the
/// link can read the thread on the website (protocol "Sharing"). Out of
/// sight while threads aren't mirrored to Convex, as there's no website to
/// share on then.
struct ShareButton: View {
    @Environment(AppModel.self) private var app
    /// For a thread open in a panel of its own; nil for the main panel's.
    var pinned: String? = nil

    var body: some View {
        let thread = pinned.map { app.threads[$0] } ?? (pinned == nil && app.openProject == nil && !app.showsHomePage ? app.selectedThread : nil)
        let shown = thread != nil && app.websiteURL != nil
        let on = thread?.share?.isOn == true
        Button {
            guard let thread else { return }
            app.sharePopoverThread = app.sharePopoverThread == thread.id ? nil : thread.id
        } label: {
            Image(systemName: "square.and.arrow.up")
                .font(.system(size: TypeScale.label, weight: .medium))
                // Accent only when it means something: someone else can read it.
                .foregroundStyle(on ? AnyShapeStyle(Color.accentColor) : AnyShapeStyle(.secondary))
                .frame(width: zoomed(26), height: zoomed(26))
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .tip(thread.map(ShareText.buttonTip) ?? "Share")
        .popover(isPresented: Binding(
            get: { thread != nil && app.sharePopoverThread == thread?.id },
            set: { if !$0, app.sharePopoverThread == thread?.id { app.sharePopoverThread = nil } }
        ), arrowEdge: .bottom) {
            if let thread { SharePopover(threadId: thread.id) }
        }
        .disabled(!shown)
        .opacity(shown ? 1 : 0)
    }
}

/// What the share button and popover say, kept apart so tests can read it.
enum ShareText {
    static func buttonTip(_ thread: ThreadSummary) -> String {
        thread.share?.isOn == true ? "Shared: anyone with the link can read it" : "Share this thread on the web"
    }

    static func title(_ access: ThreadShare.Access) -> String {
        switch access {
        case .off: "Only you"
        case .link: "Anyone with the link"
        }
    }

    static func symbol(_ access: ThreadShare.Access) -> String {
        switch access {
        case .off: "lock"
        case .link: "globe"
        }
    }

    static let about = "Anyone with the link reads this thread on your Threadbear website: its messages, one line per step and its pictures, as it carries on. Tool output, its folder and cost stay on your Mac. Only you stops the link working; sharing again brings the same link back. You can change it from the website too."
}

struct SharePopover: View {
    @Environment(AppModel.self) private var app
    let threadId: String
    @State private var busy = false
    @State private var copied = false
    @State private var problem: String?

    private var share: ThreadShare? { app.threads[threadId]?.share }
    private var access: ThreadShare.Access { share?.access ?? .off }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(spacing: 6) {
                Text("Share this thread").font(.headline)
                InfoTip(ShareText.about)
                Spacer()
            }

            Picker(selection: Binding(get: { access }, set: { change(to: $0) })) {
                ForEach(ThreadShare.Access.allCases, id: \.self) { a in
                    Label(ShareText.title(a), systemImage: ShareText.symbol(a)).labelStyle(.titleAndIcon).tag(a)
                }
            } label: {
                EmptyView()
            }
            .labelsHidden()
            .pickerStyle(.menu)
            .fixedSize()
            .disabled(busy)
            .tip("Who can read it")

            if let share, share.isOn, let link = app.shareLink(share) {
                HStack(spacing: 6) {
                    Text(link.absoluteString)
                        .font(.callout)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                        .truncationMode(.middle)
                        .textSelection(.enabled)
                        .frame(maxWidth: .infinity, alignment: .leading)
                    Button {
                        Task { await run { try await app.share(threadId, access: .link, newLink: true) } }
                    } label: {
                        Image(systemName: "arrow.triangle.2.circlepath")
                    }
                    .buttonStyle(.borderless)
                    .disabled(busy)
                    .tip("Make a new link. The old one stops working.")
                    Button {
                        OpenGate.openWeb(link)
                    } label: {
                        Image(systemName: "arrow.up.right.square")
                    }
                    .buttonStyle(.borderless)
                    .tip("Open the shared page in your browser")
                    Button(copied ? "Copied" : "Copy link") { copy(link) }
                        .keyboardShortcut(.defaultAction)
                        .tip("Copy the link to paste anywhere")
                }
            }

            if let problem {
                Text(problem)
                    .font(.callout)
                    .foregroundStyle(.red)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .padding(16)
        .frame(width: 380)
    }

    private func change(to next: ThreadShare.Access) {
        guard next != access else { return }
        Task { await run { try await app.share(threadId, access: next) } }
    }

    private func run(_ body: () async throws -> Void) async {
        busy = true
        problem = nil
        copied = false
        do { try await body() } catch { problem = error.localizedDescription }
        busy = false
    }

    private func copy(_ link: URL) {
        app.copyToPasteboard(link.absoluteString)
        copied = true
        Task {
            try? await Task.sleep(for: .seconds(1.5))
            copied = false
        }
    }
}
