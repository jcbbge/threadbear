import AppKit
import AVKit
import BearDock
import SwiftUI
import ThreadbearCore

extension AppModel {
    /// Opens a review in a window of its own, most of the screen (Mike,
    /// 30 Oct): beside the thread as a dock tab the images were too small
    /// to compare.
    func openReview(threadId: String, review: DesignReview) {
        // Another Mac's review: its pictures and pages are files on that
        // Mac, and read here they'd be whatever this Mac has at those paths
        // (Codex review, 7 Nov). Its answers went to this Mac's runner too,
        // which doesn't have it, so it never worked from here.
        if let thread = threads[threadId], thread.isRemote {
            errorMessage = "This review is on \(runnerName(of: thread) ?? "another Mac"). Open it there for now."
            return
        }
        let key = threadId + "/" + review.id
        if let existing = reviewWindows[key] {
            existing.session.receive(review)
            existing.present()
            return
        }
        presentReviewWindow(makeReviewSession(threadId: threadId, review: review))
    }

    private func makeReviewSession(threadId: String, review: DesignReview) -> ReviewSession {
        // Resolve the client for each call: a review can stay open through
        // a runner handover and must not keep the disconnected client.
        func connected() throws -> RPCClient {
            // RPCError rather than a plain error, so ReviewSession can tell a
            // runner that's restarting from one that refused.
            guard let client else { throw RPCError.disconnected(nil) }
            return client
        }
        let service = ReviewService(
            load: { try await connected().review(threadId: threadId, reviewId: review.id) },
            save: { revision, draft in try await connected().saveReview(threadId: threadId, reviewId: review.id, revision: revision, draft: draft) },
            respond: { revision, draft in try await connected().respondReview(threadId: threadId, reviewId: review.id, revision: revision, draft: draft).review },
            cancel: { revision in try await connected().cancelReview(threadId: threadId, reviewId: review.id, revision: revision) }
        )
        return ReviewSession(threadId: threadId, review: review, service: service)
    }

    private func presentReviewWindow(_ session: ReviewSession) {
        let threadId = session.threadId
        let key = threadId + "/" + session.review.id
        let controller = ReviewWindowController(session: session, app: self, threadTitle: threads[threadId]?.title ?? "Thread", back: { [weak self] in
            self?.select(threadId)
            #if DEBUG
            if Automation.instanceId != nil { return }
            #endif
            NSApp.windows.first { $0.isVisible && !($0 is ReviewNativeWindow) && !($0 is DockPanelWindow) && $0.frame.width > 600 }?.makeKeyAndOrderFront(nil)
        })
        controller.onClose = { [weak self] in self?.reviewWindows.removeValue(forKey: key) }
        reviewWindows[key] = controller
        controller.present()
    }

    func receiveReview(_ review: DesignReview, threadId: String) {
        reviewWindows[threadId + "/" + review.id]?.session.receive(review)
    }
}

/// A pending request can be older than the loaded transcript page. The
/// runner's list keeps it one click away without fetching the whole thread.
struct PendingReviewsButton: View {
    @Environment(AppModel.self) private var app
    let thread: ThreadSummary
    @State private var showing = false
    @State private var reviews: [DesignReview] = []
    @State private var error: String?
    @State private var loading = false

    var body: some View {
        HStack {
            Button {
                showing = true
            } label: {
                Label("Review design options (\(thread.pendingReviews ?? 0))", systemImage: Symbols.review)
            }.buttonStyle(.plain).foregroundStyle(.secondary)
                .tip("Compare the images the agent made side by side, and reply")
            Spacer()
        }
        .font(.system(size: TypeScale.work)).padding(.horizontal, 20).padding(.vertical, 9)
        .overlay(alignment: .bottom) { Divider() }
        .popover(isPresented: $showing) {
            VStack(alignment: .leading, spacing: 12) {
                if loading { ProgressView().controlSize(.small) }
                if let error { Text(error).foregroundStyle(.secondary) }
                ForEach(reviews) { review in
                    Button {
                        showing = false
                        app.openReview(threadId: thread.id, review: review)
                    } label: {
                        HStack {
                            Text(review.title)
                            Spacer(minLength: 18)
                            Text("\(review.options.count) images").foregroundStyle(.secondary)
                        }.contentShape(Rectangle())
                    }.buttonStyle(.plain)
                        .tip("Open this review")
                }
                if !loading && reviews.isEmpty && error == nil { Text("No reviews waiting.").foregroundStyle(.secondary) }
            }.font(.system(size: TypeScale.work)).padding(16).frame(minWidth: 300)
                .task {
                    loading = true
                    error = nil
                    defer { loading = false }
                    do {
                        guard let client = app.client else { throw NSError(domain: "Threadbear", code: 1, userInfo: [NSLocalizedDescriptionKey: "The runner is disconnected."]) }
                        reviews = try await client.pendingReviews(threadId: thread.id)
                    } catch { self.error = error.localizedDescription }
                }
        }
    }
}

@MainActor
final class ReviewWindowController: NSWindowController, NSWindowDelegate {
    let session: ReviewSession
    var onClose: (() -> Void)?

    init(session: ReviewSession, app: AppModel, threadTitle: String, back: @escaping () -> Void) {
        self.session = session
        // On the screen Threadbear's in, not wherever the mouse is.
        let screen = NSApp.keyWindow?.screen ?? NSApp.mainWindow?.screen ?? NSScreen.main
        let frame = Self.frame(on: screen?.visibleFrame ?? NSRect(x: 0, y: 0, width: 1240 / 0.9, height: 860 / 0.9))
        let window = ReviewNativeWindow(contentRect: frame, styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered, defer: false)
        window.reviewSession = session
        window.title = session.review.title
        window.subtitle = threadTitle
        window.minSize = NSSize(width: 780, height: 650)
        window.isReleasedWhenClosed = false
        window.collectionBehavior = [.fullScreenPrimary]
        // No frame autosave: each review opens at the size below, not
        // whatever the last one was dragged to.
        super.init(window: window)
        window.delegate = self
        // The app, for a page's Open in Browser (LocalPagePreview).
        window.contentView = NSHostingView(rootView: ReviewWindow(session: session, back: back, close: { [weak self] in self?.close() })
            .environment(app).allowsWindowActivationEvents())
        // Up in the title bar rather than a row of their own, so the images
        // and the choices get that height. Wide enough for all of them, as an
        // accessory doesn't resize when some come and go.
        let buttons = NSHostingView(rootView: ReviewTitlebarButtons(session: session, back: back).allowsWindowActivationEvents())
        buttons.frame.size = NSSize(width: 130, height: 28)
        let accessory = NSTitlebarAccessoryViewController()
        accessory.layoutAttribute = .trailing
        accessory.view = buttons
        window.addTitlebarAccessoryViewController(accessory)
        window.setFrame(frame, display: false)
    }

    /// 90% of the screen, centred, so a border of the desktop shows round
    /// it; capped on a huge display, where 90% would be a wall of image.
    static let maxSize = NSSize(width: 2400, height: 1500)

    static func frame(on visible: NSRect) -> NSRect {
        let width = min(visible.width * 0.9, maxSize.width)
        let height = min(visible.height * 0.9, maxSize.height)
        return NSRect(x: (visible.midX - width / 2).rounded(), y: (visible.midY - height / 2).rounded(), width: width.rounded(), height: height.rounded())
    }

    required init?(coder: NSCoder) { fatalError() }

    func present() {
        #if DEBUG
        if Automation.instanceId != nil {
            window?.tuckBehind()
            return
        }
        #endif
        showWindow(nil)
        window?.makeKeyAndOrderFront(nil)
    }

    func windowWillClose(_ notification: Notification) {
        // Keystrokes are already cached locally. Try to flush the final
        // debounce too; a failed connection still leaves that local copy.
        Task { [session] in await session.saveNow() }
        onClose?()
    }
}

/// Not private, so ReviewWindowTests can press keys in a real one.
final class ReviewNativeWindow: NSWindow {
    weak var reviewSession: ReviewSession?

    /// Holding Space shows today's version over the shot on show. Caught
    /// before the responder chain, as a focused button would take the
    /// Space press for itself; a text box keeps it for typing.
    override func sendEvent(_ event: NSEvent) {
        if (event.type == .keyDown || event.type == .keyUp), event.keyCode == 49, !(firstResponder is NSTextView),
           event.modifierFlags.intersection([.command, .control, .option]).isEmpty, let session = reviewSession {
            if event.type == .keyUp { session.peeking = false } else if !event.isARepeat, session.canPeek { session.peeking = true }
            return
        }
        // On a shot, the View menu's zoom keys zoom the shot rather than the
        // app's text, as they do in Preview.
        if event.type == .keyDown, event.modifierFlags.intersection([.command, .control, .option]) == .command,
           let session = reviewSession, session.mode == .single {
            switch event.charactersIgnoringModifiers {
            case "=", "+": session.zoom(.closer); return
            case "-": session.zoom(.further); return
            case "0": session.zoom(.fit); return
            default: break
            }
        }
        super.sendEvent(event)
    }

    override func keyDown(with event: NSEvent) {
        // Text editors own their arrows and Return. Outside an editor,
        // browsing works immediately without first clicking the canvas.
        if !(firstResponder is NSTextView), event.modifierFlags.intersection([.command, .control, .option]).isEmpty, let session = reviewSession {
            switch event.keyCode {
            case 123: session.browse(-1); return // left: the shot before
            case 124: session.browse(1); return // right: the next shot
            case 126: session.jump(-1); return // up: the option before
            case 125: session.jump(1); return // down: the next option
            case 36: // Return
                if session.mode == .single { session.showAll() } else { session.browse(0) }
                return
            case 53 where session.mode == .single: // Esc: out of a zoom, then out to all of them
                if session.zoomed { session.zoom(.fit) } else { session.showAll() }
                return
            default: break
            }
        }
        super.keyDown(with: event)
    }
}

extension ReviewOption {
    /// Agents often number their titles already ("1. One decision at a
    /// time"); don't say the number twice.
    var label: String {
        title.hasPrefix(id + ".") || title.hasPrefix(id + " ") || title == id ? title : "\(id). \(title)"
    }
}

/// The buttons in a review window's title bar.
private struct ReviewTitlebarButtons: View {
    @Bindable var session: ReviewSession
    let back: () -> Void
    @State private var confirmingCancel = false

    var body: some View {
        HStack(spacing: 4) {
            Spacer(minLength: 0)
            if session.mode == .single {
                icon("square.grid.2x2", "See them all (Esc)") { session.showAll() }
            }
            // A video or page has its own controls and scrolling; zoom is for pictures.
            if session.mode == .single, session.shownShot?.media == nil {
                icon(session.zoomed ? "minus.magnifyingglass" : "plus.magnifyingglass",
                     session.zoomed ? "Fit the image in its space (\u{2318}0)" : "Show at full size. Scroll or pinch to zoom, drag to move around") {
                    session.zoom(session.zoomed ? .fit : .actual)
                }
            }
            icon("arrow.up.backward", "Show the thread this came from", back)
            if session.review.isPending {
                IconMenu {
                    Button("Cancel review", systemImage: "xmark.circle", role: .destructive) { confirmingCancel = true }
                } label: { Image(systemName: "ellipsis") }
                    .menuStyle(.borderlessButton).menuIndicator(.hidden).fixedSize().frame(width: 26)
                    .tip("More")
            }
        }
        .padding(.trailing, 10)
        .foregroundStyle(.secondary)
        .confirmationDialog("Cancel this review?", isPresented: $confirmingCancel) {
            Button("Cancel review", role: .destructive) { Task { await session.cancelReview() } }
        } message: { Text("The agent won\u{2019}t get a reply. You can still look at the images.") }
    }

    private func icon(_ symbol: String, _ tip: String, _ action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Image(systemName: symbol).frame(width: 26, height: 24).contentShape(Rectangle())
        }.buttonStyle(.plain).tip(tip)
    }
}

/// The review, as Mike picked on 4 Nov: the option on show big on the stage,
/// with its other shots in a strip under it and a mark for every shot of
/// every option; down the right, the options with their reasons and shots,
/// ticks for as many as he wants, and one reply box with Send. Before, each
/// extra shot was an option of its own (A2, A3) that couldn't be picked, a
/// single pick was all he could send, and he answered most reviews by
/// typing in the thread instead.
struct ReviewWindow: View {
    @Bindable var session: ReviewSession
    let back: () -> Void
    let close: () -> Void
    @Environment(\.colorScheme) private var colorScheme
    @FocusState private var replying: Bool

    private static let railWidth: CGFloat = 340
    private static let stageInset: CGFloat = 14
    private static let cellSpacing: CGFloat = 12
    private static let cellPadding: CGFloat = 8
    private static let captionHeight: CGFloat = 20

    var body: some View {
        VStack(spacing: 0) {
            if let error = session.error {
                HStack {
                    Text(error).font(.system(size: TypeScale.detail)).textSelection(.enabled)
                    Spacer()
                    if session.conflict && session.review.isPending {
                        Button("Save my draft") { Task { await session.keepMyDraft() } }
                            .busy(session.saving)
                            .tip("Keep what you have here, over the copy that changed elsewhere")
                    } else if session.review.isPending {
                        Button("Try saving again") { Task { await session.saveNow() } }
                            .busy(session.saving)
                            .tip("Save the draft to the runner again")
                    }
                }.padding(12).background(Color.orange.opacity(0.1))
            }
            if session.review.options.isEmpty {
                ContentUnavailableView("No images to compare", systemImage: "photo")
            } else {
                HStack(spacing: 0) {
                    stage
                    Divider()
                    rail.frame(width: Self.railWidth)
                }
            }
        }
        .background(Color(nsColor: .windowBackgroundColor))
        .task {
            await session.refresh()
            // Keeps up with replies from elsewhere (the phone, a second
            // window) while the thread's transcript isn't subscribed.
            while !Task.isCancelled && session.review.isPending {
                do { try await Task.sleep(for: .seconds(5)) } catch { return }
                await session.refresh()
            }
        }
    }

    // MARK: The images

    private var stage: some View {
        VStack(spacing: 0) {
            if session.mode == .single, let option = session.shownOption { caption(option) }
            images
            stepper
        }
        // minWidth 0: the image view's own size mustn't push the rail away.
        .frame(minWidth: 0, maxWidth: .infinity, maxHeight: .infinity)
        .background(Color.black.opacity(colorScheme == .dark ? 0.22 : 0.05))
    }

    /// Which option and shot this is, and the way to try it live.
    private func caption(_ option: ReviewOption) -> some View {
        let shots = option.allShots
        let shown = session.shownShot
        let index = shots.firstIndex(of: shown ?? shots[0]) ?? 0
        let title = shown?.title
        let where_ = shots.count > 1 ? "\(index + 1) of \(shots.count)" + (title.map { " \u{00B7} \($0)" } ?? "") : title ?? ""
        return HStack(alignment: .firstTextBaseline, spacing: 10) {
            Text(option.label).font(.system(size: TypeScale.work + 2, weight: .semibold)).lineLimit(1)
            Text(where_).font(.system(size: TypeScale.work)).foregroundStyle(.secondary).lineLimit(1)
            Spacer(minLength: 8)
            if let baseline = session.baseline, session.canPeek {
                Button { session.peeking.toggle() } label: {
                    Label(baseline.title, systemImage: "rectangle.2.swap")
                        .font(.system(size: TypeScale.detail, weight: .medium))
                        .padding(.horizontal, 11).frame(height: 26)
                        .foregroundStyle(session.peeking ? Color.white : Color.primary)
                        .background(session.peeking ? Color.accentColor : Color.primary.opacity(0.08), in: Capsule())
                        .contentShape(Capsule())
                }.buttonStyle(.plain)
                    .tip(session.peeking ? "Back to \(session.focusedOption?.id ?? "it") (or let go of Space)" : "Flick to \(baseline.title): click, or hold Space")
            }
            // Only a web page, which is all an option's url is for: a runner
            // (maybe another Mac's) sends it, and a file: or another app's
            // link would open whatever it named here (Daybreak, 7 Nov).
            if let url = LinkPolicy.web(option.url) {
                Button { OpenGate.openWeb(url) } label: {
                    Label("Open live", systemImage: "arrow.up.right")
                        .font(.system(size: TypeScale.detail, weight: .medium))
                        .padding(.horizontal, 11).frame(height: 26)
                        .background(Color.primary.opacity(0.08), in: Capsule())
                        .contentShape(Capsule())
                }.buttonStyle(.plain).tip("Try \(option.id) running live: \(url.absoluteString)")
            }
        }
        .padding(.horizontal, 22).padding(.top, 14)
    }

    private var images: some View {
        GeometryReader { geo in
            let room = CGSize(width: max(0, geo.size.width - Self.stageInset * 2), height: max(0, geo.size.height - Self.stageInset * 2))
            Group {
                if session.mode == .single, let shot = session.shownShot {
                    if let video = shot.video {
                        // Plays on its own, quietly, round and round, as
                        // X does: the controls turn the sound up.
                        ReviewVideo(url: video, controls: true)
                            .frame(maxWidth: .infinity, maxHeight: .infinity)
                            .accessibilityLabel("\(session.shownOption?.label ?? ""), video")
                    } else if let page = shot.page {
                        LocalPagePreview(url: page, opened: 0)
                            .clipShape(RoundedRectangle(cornerRadius: 6))
                            .frame(maxWidth: .infinity, maxHeight: .infinity)
                            .accessibilityLabel("\(session.shownOption?.label ?? ""), page")
                    } else {
                        enlarged(shot.image)
                    }
                } else {
                    let layout = ReviewGalleryLayout.best(
                        aspects: session.review.options.map { aspect($0.image) }, width: room.width, height: room.height, spacing: Self.cellSpacing,
                        chromeWidth: Self.cellPadding * 2, chromeHeight: Self.cellPadding * 2 + Self.captionHeight)
                    let indices = Array(session.review.options.indices)
                    VStack(spacing: Self.cellSpacing) {
                        ForEach(Array(stride(from: 0, to: indices.count, by: layout.columns)), id: \.self) { first in
                            HStack(spacing: Self.cellSpacing) {
                                ForEach(first..<min(first + layout.columns, indices.count), id: \.self) { index in
                                    cell(index, size: CGSize(width: layout.cellWidth, height: layout.cellHeight))
                                }
                            }
                        }
                    }
                }
            }
            .frame(width: geo.size.width, height: geo.size.height)
        }
        .frame(minWidth: 0, maxWidth: .infinity, maxHeight: .infinity)
    }

    /// Back and next, the option's other shots, and a mark for every shot
    /// of every option, grouped under its letter, then the grid where
    /// they're all side by side to choose from. A mark or a shot takes you
    /// straight to it.
    private var stepper: some View {
        HStack(alignment: .center, spacing: 18) {
            stepButton("chevron.left", tip: session.mode == .all ? "Back to the last one (\u{2190})" : "Previous (\u{2190})",
                       enabled: session.canStepBack) { session.browse(-1) }
            if session.mode == .single, let option = session.focusedOption, option.allShots.count > 1 {
                filmstrip(option)
            }
            Spacer(minLength: 8)
            HStack(spacing: 12) {
                ForEach(Array(session.review.options.enumerated()), id: \.element.id) { index, option in
                    marks(index, option)
                }
                Button { session.showAll() } label: {
                    Image(systemName: "square.grid.2x2")
                        .font(.system(size: 13, weight: session.mode == .all ? .semibold : .regular))
                        .foregroundStyle(session.mode == .all ? Color.primary : Color.secondary)
                        .frame(width: 26, height: 26).contentShape(Rectangle())
                }.buttonStyle(.plain).tip("See them all and choose (Esc)")
            }
            stepButton("chevron.right", tip: session.nextIsAll ? "See them all and choose (\u{2192})" : "Next (\u{2192})",
                       enabled: session.canStepForward, prominent: true) { session.browse(1) }
        }
        .padding(.horizontal, 22).padding(.vertical, 12)
        .frame(maxWidth: .infinity)
    }

    private func filmstrip(_ option: ReviewOption) -> some View {
        HStack(spacing: 8) {
            ForEach(Array(option.allShots.enumerated()), id: \.offset) { index, shot in
                let current = index == session.shot
                Button { session.enlarge(session.focused, shot: index) } label: {
                    VStack(alignment: .leading, spacing: 4) {
                        ReviewThumb(path: shot.image.path, width: 92, height: 58)
                            .opacity(current ? 1 : 0.55)
                            .overlay(RoundedRectangle(cornerRadius: 5).strokeBorder(current ? Color.primary : Color.clear, lineWidth: 2).padding(-3))
                        Text(shot.title ?? "\(index + 1)").font(.system(size: TypeScale.detail - 1))
                            .foregroundStyle(current ? Color.primary : Color.secondary).lineLimit(1).frame(width: 92, alignment: .leading)
                    }.contentShape(Rectangle())
                }.buttonStyle(.plain).tip(shotTip(option, index))
            }
        }
    }

    private func shotTip(_ option: ReviewOption, _ index: Int) -> String {
        let shots = option.allShots
        guard shots.count > 1 else { return option.label }
        return "\(option.label), " + (shots[index].title ?? "shot \(index + 1)")
    }

    /// An option's letter and a dot per shot. A reference is hollow: it's
    /// there to look at, not to pick.
    private func marks(_ index: Int, _ option: ReviewOption) -> some View {
        let picked = session.draft.pickedIds.contains(option.id)
        let here = session.mode == .single && session.focused == index
        return HStack(spacing: 0) {
            Text(option.id).font(.system(size: TypeScale.detail - 1, weight: .semibold))
                .foregroundStyle(picked ? Color.accentColor : here ? Color.primary : Color.secondary)
                .lineLimit(1).padding(.trailing, 2)
            ForEach(Array(option.allShots.indices), id: \.self) { shot in
                let current = here && session.shot == shot
                let colour = picked ? Color.accentColor : current || here ? Color.primary : Color.secondary.opacity(0.45)
                Button { session.enlarge(index, shot: shot) } label: {
                    Group {
                        if option.reference { Circle().strokeBorder(colour, lineWidth: 1.5) } else { Circle().fill(colour) }
                    }
                    .frame(width: current ? 10 : 7, height: current ? 10 : 7)
                    .frame(width: 13, height: 26).contentShape(Rectangle())
                }.buttonStyle(.plain).tip(shotTip(option, shot))
            }
        }
    }

    private func stepButton(_ symbol: String, tip: String, enabled: Bool, prominent: Bool = false, _ action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Image(systemName: symbol).font(.system(size: 15, weight: .semibold))
                .frame(width: 50, height: 32)
                .background(Color.primary.opacity(prominent && enabled ? 0.1 : 0.05), in: Capsule())
                .contentShape(Capsule())
        }
        .buttonStyle(.plain).foregroundStyle(enabled ? Color.primary : Color.secondary.opacity(0.4))
        .disabled(!enabled).tip(tip)
    }

    private func aspect(_ image: ImageRef) -> Double {
        guard let width = image.width, let height = image.height, width > 0, height > 0 else { return 1100.0 / 760.0 }
        return Double(width) / Double(height)
    }

    /// One shot, with the whole stage to zoom in. A click goes back to all of
    /// them; zoomed in, a press is for dragging, so it does nothing.
    private func enlarged(_ image: ImageRef) -> some View {
        let id = session.focusedOption?.id ?? ""
        return ReviewCanvas(image: image, zoomable: true, zoomRequest: session.zoomRequest, peeking: session.peeking,
                            onZoom: { if session.mode == .single { session.zoomed = $0 } }, onClick: { session.showAll() })
            .tip(session.zoomed ? "" : "\(id): click to see them all, scroll to zoom")
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .accessibilityLabel("\(session.focusedOption?.label ?? ""). Scroll to zoom into the image.")
    }

    /// An option among them all: its first shot, and how many it has.
    private func cell(_ index: Int, size: CGSize) -> some View {
        let option = session.review.options[index]
        let picked = session.draft.pickedIds.contains(option.id)
        let count = option.allShots.count
        let room = CGSize(width: max(0, size.width - Self.cellPadding * 2), height: max(0, size.height - Self.cellPadding * 2 - Self.captionHeight))
        let fit = ReviewGalleryLayout.fit(aspect: aspect(option.image), width: room.width, height: room.height)
        return VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 6) {
                Text(option.id).font(.system(size: TypeScale.detail, weight: .semibold))
                    .foregroundStyle(picked ? Color.accentColor : Color.secondary)
                if count > 1 { Text("\(count) shots").font(.system(size: TypeScale.detail)).foregroundStyle(.tertiary) }
                if session.review.recommended == option.id {
                    Text("my pick").font(.system(size: TypeScale.detail)).foregroundStyle(Color.accentColor)
                }
            }
            .lineLimit(1).frame(height: Self.captionHeight, alignment: .topLeading)
            Group {
                // A clip plays side by side with the others, so they can
                // be compared moving; a page shows its still, as a live
                // page this small can't be read or used.
                if let video = option.allShots.first?.video {
                    ReviewVideo(url: video, controls: false)
                        .overlay { Color.clear.contentShape(Rectangle()).onTapGesture { session.enlarge(index) } }
                } else {
                    ReviewCanvas(image: option.image, onClick: { session.enlarge(index) })
                }
            }
                .tip("\(option.id): click to enlarge")
                .frame(width: fit.width, height: fit.height)
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .accessibilityLabel(option.label)
        }
        .padding(Self.cellPadding)
        .frame(width: size.width, height: size.height)
        .overlay {
            if picked {
                RoundedRectangle(cornerRadius: 10).strokeBorder(Color.accentColor, lineWidth: 2).allowsHitTesting(false)
            }
        }
    }

    // MARK: The answer

    private var rail: some View {
        VStack(spacing: 0) {
            ScrollViewReader { scroller in ScrollView {
                VStack(alignment: .leading, spacing: 0) {
                    // The agent's lead, as markdown in the text colour: drawn
                    // raw in grey it was one long wall where backticks showed
                    // and nothing stood out (Mike, 7 Nov).
                    if let note = session.review.note, !note.isEmpty {
                        Text(AttributedString.inlineMarkdown(note)).font(.system(size: TypeScale.work)).lineSpacing(2)
                            .fixedSize(horizontal: false, vertical: true).textSelection(.enabled)
                            .padding(14)
                        Divider()
                    }
                    ForEach(Array(session.review.options.enumerated()), id: \.element.id) { index, option in
                        choice(option, index: index).id(option.id)
                        Divider()
                    }
                }
            }
            .onChange(of: session.focused) { _, index in
                guard session.review.options.indices.contains(index) else { return }
                withAnimation(.easeOut(duration: 0.2)) { scroller.scrollTo(session.review.options[index].id) }
            } }
            Divider()
            footer.padding(14)
        }
        .background(Color.primary.opacity(0.025))
    }

    private func choice(_ option: ReviewOption, index: Int) -> some View {
        let picked = session.draft.pickedIds.contains(option.id)
        let note = (session.review.response ?? session.draft).notes[option.id] ?? ""
        let current = session.mode == .single && session.focused == index
        let shots = option.allShots
        return HStack(alignment: .top, spacing: 10) {
            pickMark(option, picked: picked)
            VStack(alignment: .leading, spacing: 8) {
                // The whole row shows its image, references too (Mike, 2 Nov).
                Button { if !current { session.enlarge(index) } } label: { choiceText(option) }
                    .buttonStyle(.plain)
                    .tip(current ? "Showing \(option.id)" : "Show \(option.id)")
                if shots.count > 1 {
                    HStack(spacing: 5) {
                        ForEach(Array(shots.enumerated()), id: \.offset) { shot, item in
                            let on = current && session.shot == shot
                            Button { session.enlarge(index, shot: shot) } label: {
                                ReviewThumb(path: item.image.path, width: 52, height: 33)
                                    .opacity(on ? 1 : 0.7)
                                    .overlay(RoundedRectangle(cornerRadius: 4).strokeBorder(on ? Color.primary : Color.clear, lineWidth: 1.5).padding(-2))
                            }.buttonStyle(.plain).tip(shotTip(option, shot))
                        }
                    }
                }
                // Notes on one option are from before the one reply box,
                // or a client that still sends them: shown, as they'll go.
                if !note.isEmpty {
                    Text(note).font(.system(size: TypeScale.work)).textSelection(.enabled)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
        }
        .padding(.horizontal, 14).padding(.vertical, 12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(current ? Color.primary.opacity(0.06) : picked ? Color.accentColor.opacity(0.07) : Color.clear)
        .overlay(alignment: .leading) {
            if current { Rectangle().fill(Color.primary.opacity(0.5)).frame(width: 3) }
        }
    }

    /// A tick, as several can be picked. A reference has none, and neither
    /// has a sent review's unpicked options; the gap keeps the text lined up.
    @ViewBuilder private func pickMark(_ option: ReviewOption, picked: Bool) -> some View {
        if session.editable && !option.reference {
            Button { session.pick(option.id) } label: {
                Image(systemName: picked ? "checkmark.square.fill" : "square")
                    .font(.system(size: 15))
                    .foregroundStyle(picked ? Color.accentColor : Color.secondary)
                    .frame(width: 16, height: 16).padding(4).contentShape(Rectangle())
            }.buttonStyle(.plain).padding(-4)
                .tip(picked ? "Unpick \(option.id)" : "Pick \(option.id)")
        } else if picked {
            Image(systemName: "checkmark.square.fill").font(.system(size: 15)).foregroundStyle(Color.accentColor).frame(width: 16, height: 16)
        } else {
            Color.clear.frame(width: 16, height: 16)
        }
    }

    private func choiceText(_ option: ReviewOption) -> some View {
        HStack(alignment: .top, spacing: 0) {
            VStack(alignment: .leading, spacing: 3) {
                // The agent's pick, worded and coloured as on an asks card.
                (Text(option.label).font(.system(size: TypeScale.work, weight: .semibold))
                    + (session.review.recommended == option.id
                        ? Text("  my pick").font(.system(size: TypeScale.detail)).foregroundStyle(Color.accentColor)
                        : Text("")))
                    .fixedSize(horizontal: false, vertical: true)
                if let reason = option.note, !reason.isEmpty {
                    Text(AttributedString.inlineMarkdown(reason)).font(.system(size: TypeScale.detail)).foregroundStyle(.secondary).lineSpacing(1.5)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            Spacer(minLength: 0)
        }
        .contentShape(Rectangle())
    }

    /// One box for what he thinks of the lot, as he'd say it in the thread.
    private var replyBox: some View {
        let reply = session.draft.reply ?? ""
        // Grows with what's typed: the hidden copy sets the height, and the
        // editor sits over it, as a TextEditor on its own takes all the
        // room the rail has left.
        return Text(reply + "\n").font(.system(size: TypeScale.work)).opacity(0)
            .padding(.horizontal, 5).padding(.vertical, 1)
            .frame(maxWidth: .infinity, minHeight: 60, alignment: .topLeading)
            .frame(maxHeight: 220)
            .fixedSize(horizontal: false, vertical: true)
            .overlay {
                TextEditor(text: Binding(get: { session.draft.reply ?? "" }, set: { session.setReply($0) }))
                    .font(.system(size: TypeScale.work)).scrollContentBackground(.hidden)
                    .scrollIndicators(.never)
                    .focused($replying)
                    .accessibilityLabel("Reply")
            }
            .overlay(alignment: .topLeading) {
                if reply.isEmpty {
                    Text("Add a reply").font(.system(size: TypeScale.work)).foregroundStyle(.tertiary)
                        .padding(.leading, 5).allowsHitTesting(false)
                }
            }
        .padding(6)
        .background(Color.black.opacity(colorScheme == .dark ? 0.2 : 0.03), in: RoundedRectangle(cornerRadius: 8))
        .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(replying ? Color.accentColor : Color(nsColor: .separatorColor), lineWidth: 1))
    }

    @ViewBuilder private var footer: some View {
        if session.review.isPending {
            VStack(spacing: 10) {
                replyBox
                HStack(spacing: 8) {
                    Button { session.toggleNone() } label: {
                        Text("None").frame(width: 70)
                    }
                    .buttonStyle(.bordered).controlSize(.large).tint(session.draft.none ? .accentColor : nil)
                    .disabled(!session.editable)
                    .tip(session.draft.none ? "Take back none of them" : "None of them will do")
                    Button {
                        Task {
                            await session.submit()
                            // Once it's sent there's nothing left to do here, so
                            // it gets out of the way (Mike, 28 Oct). A failed send
                            // stays open with its error and the reply kept.
                            if session.review.status == "answered" { close() }
                        }
                    } label: {
                        Text(session.sendLabel).fontWeight(.semibold).lineLimit(1).frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.borderedProminent).controlSize(.large)
                    .keyboardShortcut(.return, modifiers: .command)
                    .disabled(!session.canSubmit)
                    .tip("Send your picks and reply to the agent (\u{2318}\u{21A9}). Close the window to finish it later.")
                }
            }
        } else {
            VStack(alignment: .leading, spacing: 10) {
                let sent = session.review.response ?? session.draft
                if sent.none { Text("None of them").font(.system(size: TypeScale.work, weight: .semibold)) }
                if let reply = sent.reply, !reply.isEmpty {
                    Text(reply).font(.system(size: TypeScale.work)).textSelection(.enabled).fixedSize(horizontal: false, vertical: true)
                }
                HStack {
                    Text(status).font(.system(size: TypeScale.detail)).foregroundStyle(.secondary).lineLimit(1)
                    Spacer()
                    Button("Done") { close() }.tip("Close it")
                }
            }
        }
    }

    /// Only for a review that's over, as one that's waiting says it on Send.
    private var status: String {
        switch session.review.status {
        case "answered": return "Sent"
        case "cancelled": return "Cancelled"
        case "superseded": return "Answered in the thread"
        default: return "Closed"
        }
    }
}

/// A small picture of a shot, cropped from its top left, where a mockup's
/// title and controls are, rather than squashed.
/// A shot that's a video: muted and looping from the start. On the stage
/// it has the player's controls, for sound and scrubbing; in a cell among
/// them all it has none, and a click on it enlarges it.
struct ReviewVideo: NSViewRepresentable {
    let url: URL
    let controls: Bool

    final class Coordinator {
        var url: URL?
        var looper: AVPlayerLooper?
    }

    func makeCoordinator() -> Coordinator { Coordinator() }

    /// Never the window's first responder, so the arrow keys keep stepping
    /// through the shots after a click on its controls, not scrubbing.
    final class Player: AVPlayerView {
        override var acceptsFirstResponder: Bool { false }
    }

    func makeNSView(context: Context) -> AVPlayerView {
        let view = Player()
        view.videoGravity = .resizeAspect
        // Live Text over a paused frame would take the click.
        view.allowsVideoFrameAnalysis = false
        return view
    }

    func updateNSView(_ view: AVPlayerView, context: Context) {
        view.controlsStyle = controls ? .floating : .none
        guard context.coordinator.url != url else { return }
        view.player?.pause()
        let player = AVQueuePlayer()
        player.isMuted = true
        // Looping and quiet: it mustn't keep the Mac awake on its own.
        player.preventsDisplaySleepDuringVideoPlayback = false
        context.coordinator.looper = AVPlayerLooper(player: player, templateItem: AVPlayerItem(url: url))
        context.coordinator.url = url
        view.player = player
        player.play()
    }

    static func dismantleNSView(_ view: AVPlayerView, coordinator: Coordinator) {
        view.player?.pause()
        coordinator.looper?.disableLooping()
        view.player = nil
    }
}

private struct ReviewThumb: View {
    let path: String
    let width: CGFloat
    let height: CGFloat
    @State private var image: CGImage?

    var body: some View {
        ZStack(alignment: .topLeading) {
            Color.primary.opacity(0.08)
            if let image {
                Image(decorative: image, scale: 2).resizable().aspectRatio(contentMode: .fill)
                    .frame(width: width, height: height, alignment: .topLeading)
            }
        }
        .frame(width: width, height: height).clipShape(RoundedRectangle(cornerRadius: 4))
        .onAppear(perform: load)
        .onChange(of: path) { _, _ in load() }
    }

    private func load() {
        ThumbnailLoader.shared.load(path: path, maxPixels: Int(width * 4)) { image = $0 }
    }
}

/// The image on the stage, or in a cell among them all. Only one on the stage
/// can zoom: a cell's click and scroll belong to the grid.
private struct ReviewCanvas: NSViewRepresentable {
    let image: ImageRef
    var zoomable = false
    var zoomRequest: ReviewZoomRequest?
    var peeking = false
    var onZoom: ((Bool) -> Void)?
    let onClick: (() -> Void)?
    func makeNSView(context: Context) -> ReviewImageScroll { ReviewImageScroll() }
    func updateNSView(_ view: ReviewImageScroll, context: Context) {
        view.onClick = onClick
        view.onZoom = onZoom
        view.show(image, zoomable: zoomable, request: zoomRequest, peeking: peeking)
    }
}

/// Holds the document in the middle of the stage whenever it's smaller than
/// it. A plain clip view pins it to a corner, and a tall page zoomed in is
/// narrower than the stage for most of the way.
private final class ReviewCentringClip: NSClipView {
    override func constrainBoundsRect(_ proposed: NSRect) -> NSRect {
        var rect = super.constrainBoundsRect(proposed)
        guard let document = documentView?.frame.size else { return rect }
        if rect.width > document.width { rect.origin.x = (document.width - rect.width) / 2 }
        if rect.height > document.height { rect.origin.y = (document.height - rect.height) / 2 }
        return rect
    }

    // A plain scroll(to:) goes wherever it's told, past the image's edges.
    override func scroll(to newOrigin: NSPoint) {
        super.scroll(to: constrainBoundsRect(NSRect(origin: newOrigin, size: bounds.size)).origin)
    }
}

/// Draws the image itself rather than an NSImageView handing it to a layer:
/// a full-page phone shot is 780 x 20852 pixels, over the 16384 a texture can
/// be, and only the part on screen gets drawn this way.
private final class ReviewPicture: NSView {
    var image: CGImage? { didSet { needsDisplay = true } }
    var unavailable = false { didSet { needsDisplay = true } }
    override var isFlipped: Bool { true }

    override func draw(_ dirtyRect: NSRect) {
        NSColor.textBackgroundColor.setFill()
        dirtyRect.fill()
        if let image, let context = NSGraphicsContext.current?.cgContext {
            context.saveGState()
            context.interpolationQuality = .high
            context.translateBy(x: 0, y: bounds.height)
            context.scaleBy(x: 1, y: -1)
            context.draw(image, in: bounds)
            context.restoreGState()
        } else if unavailable, let symbol = NSImage(systemSymbolName: "photo.badge.exclamationmark", accessibilityDescription: "Image unavailable") {
            // The same size on screen at any zoom.
            let side = 40 / (enclosingScrollView?.magnification ?? 1)
            let rect = NSRect(x: bounds.midX - side / 2, y: bounds.midY - side / 2, width: side, height: side)
            symbol.draw(in: rect, from: .zero, operation: .sourceOver, fraction: 0.5, respectFlipped: true, hints: nil)
        }
    }
}

/// The whole image small, with a box for the part on show. Drag or click it
/// to go there: on a page 20,000 pixels long a scroller says how far down
/// you are, not what's there.
final class ReviewMinimap: NSView {
    private let picture = CALayer()
    private let viewport = CALayer()
    /// Where to go, as fractions of the image's width and height.
    var onMove: ((NSPoint) -> Void)?
    /// The box, as fractions of the image. Not private for ReviewWindowTests.
    private(set) var shown = NSRect.zero

    override var isFlipped: Bool { true }

    override init(frame: NSRect) {
        super.init(frame: frame)
        wantsLayer = true
        layer?.cornerRadius = 4
        layer?.borderWidth = 1
        layer?.borderColor = NSColor.white.withAlphaComponent(0.25).cgColor
        layer?.backgroundColor = NSColor.black.withAlphaComponent(0.55).cgColor
        layer?.masksToBounds = true
        picture.contentsGravity = .resize
        picture.opacity = 0.8
        layer?.addSublayer(picture)
        viewport.borderWidth = 1.5
        viewport.borderColor = NSColor.white.cgColor
        viewport.backgroundColor = NSColor.white.withAlphaComponent(0.2).cgColor
        layer?.addSublayer(viewport)
        setTip("Drag to move around the image")
    }
    required init?(coder: NSCoder) { fatalError() }

    func setPicture(_ image: CGImage?) { picture.contents = image }

    func show(visible: NSRect) {
        shown = visible
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        picture.frame = bounds
        // Tall enough to see and grab even when it's a sliver of the page.
        let height = max(6, visible.height * bounds.height)
        viewport.frame = NSRect(x: visible.minX * bounds.width,
                                y: min(visible.minY * bounds.height, bounds.height - height),
                                width: visible.width * bounds.width, height: height)
        CATransaction.commit()
    }

    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
    override func mouseDown(with event: NSEvent) { move(event) }
    override func mouseDragged(with event: NSEvent) { move(event) }

    private func move(_ event: NSEvent) {
        let point = convert(event.locationInWindow, from: nil)
        onMove?(NSPoint(x: min(1, max(0, point.x / bounds.width)), y: min(1, max(0, point.y / bounds.height))))
    }
}

/// One image in a native scroll view, drawn at its real size and magnified
/// down to fit. Fit is where it starts. Pinching zooms, as does a mouse wheel,
/// or a trackpad scroll that starts while the image fits, as there's nothing
/// to scroll then (Mike, 5 Nov: "scroll in and out"). Zoomed in, a trackpad
/// scroll moves around, as does dragging or the minimap.
final class ReviewImageScroll: NSScrollView {
    private let picture = ReviewPicture()
    let minimap = ReviewMinimap()
    private var reference: ImageRef?
    private var zoomable = false
    private var peeking = false
    /// The scale that shows the whole image.
    private var fitScale: CGFloat = 1
    private var fitted = true
    private var reportedZoomed = false
    private var startAtTop = false
    /// Where to put the view's centre after a flick, as fractions of the image.
    private var keepCentre: NSPoint?
    private var orientedSize: NSSize?
    private var handledRequest: Int?
    private var pendingStep: ReviewZoomStep?
    private var shownPixels = 0
    private var askedPixels = 0
    private var minimapPath: String?
    private var gestureZooms = false
    /// 1 or -1 for which way this swipe zooms in; 0 until it's moved.
    private var gestureDirection: CGFloat = 1
    private var dragFrom: NSPoint?
    private var dragOrigin = NSPoint.zero
    var onClick: (() -> Void)?
    var onZoom: ((Bool) -> Void)?

    // The most zoomed in: 4 pixels on screen to one in the image.
    private static let furthest: CGFloat = 4
    private static let keyStep: CGFloat = 1.5
    private static let wheelStep: CGFloat = 0.2
    private static let trackpadStep: CGFloat = 0.012
    // What decoding an image at full size may cost, about 400 MB. A very
    // big image past this is drawn at less than its full size.
    private static let mostPixels: CGFloat = 100_000_000

    override init(frame: NSRect) {
        super.init(frame: frame)
        // Clear, so the stage shows round an image that's narrower than it.
        drawsBackground = false
        let clip = ReviewCentringClip()
        clip.drawsBackground = false
        contentView = clip
        hasHorizontalScroller = true
        hasVerticalScroller = true
        autohidesScrollers = true
        documentView = picture
        minimap.isHidden = true
        minimap.onMove = { [weak self] point in self?.go(to: point) }
        addSubview(minimap)
        contentView.postsBoundsChangedNotifications = true
        NotificationCenter.default.addObserver(self, selector: #selector(viewMoved), name: NSView.boundsDidChangeNotification, object: contentView)
    }
    required init?(coder: NSCoder) { fatalError() }
    deinit { NotificationCenter.default.removeObserver(self) }

    // Takes whatever room SwiftUI gives it, never the image's size.
    override var intrinsicContentSize: NSSize { NSSize(width: NSView.noIntrinsicMetric, height: NSView.noIntrinsicMetric) }

    func show(_ image: ImageRef, zoomable: Bool, request: ReviewZoomRequest?, peeking: Bool) {
        if reference?.path != image.path {
            if reference != nil, peeking != self.peeking {
                // Flicking to today's version stays on the same part of the
                // page, or there'd be nothing to compare, and keeps the old
                // picture up until the new one's decoded rather than a blank.
                let clip = contentView.bounds
                let document = picture.frame.size
                keepCentre = NSPoint(x: clip.midX / max(1, document.width), y: clip.midY / max(1, document.height))
            } else {
                // Through layout rather than a flag here, as a scroll landing
                // before it would work "fitted" out again from the old image.
                picture.image = nil
                pendingStep = .fit
                keepCentre = nil
            }
            picture.unavailable = false
            orientedSize = nil
            shownPixels = 0
            askedPixels = 0
            minimap.setPicture(nil)
            minimapPath = nil
        }
        reference = image
        self.peeking = peeking
        if self.zoomable != zoomable {
            self.zoomable = zoomable
            allowsMagnification = zoomable
        }
        if let request, handledRequest != request.serial {
            handledRequest = request.serial
            pendingStep = request.step
        }
        needsLayout = true
    }

    /// The image's size in points, at which one image pixel is one on screen.
    private var documentSize: NSSize {
        let scale = window?.backingScaleFactor ?? 2
        let source = sourceSize
        return NSSize(width: max(1, source.width / scale), height: max(1, source.height / scale))
    }

    private var sourceSize: NSSize {
        orientedSize ?? NSSize(width: reference?.width ?? 1100, height: reference?.height ?? 760)
    }

    override func layout() {
        super.layout()
        guard reference != nil, bounds.width > 0, bounds.height > 0 else { return }
        let document = documentSize
        if picture.frame.size != document { picture.frame = NSRect(origin: .zero, size: document) }
        // A hair under, as rounding the other way would bring up scrollers
        // on an image with nothing to scroll.
        fitScale = min(bounds.width / document.width, bounds.height / document.height) * 0.9999
        minMagnification = fitScale
        maxMagnification = max(fitScale * 2, Self.furthest)
        // Fitted stays fitted through a window resize; zoomed keeps its scale.
        let target = fitted ? fitScale : min(maxMagnification, max(minMagnification, magnification))
        if magnification != target { magnification = target }
        if let step = pendingStep {
            pendingStep = nil
            apply(step)
        }
        if startAtTop {
            startAtTop = false
            contentView.scroll(to: NSPoint(x: max(0, (document.width - contentView.bounds.width) / 2), y: 0))
            reflectScrolledClipView(contentView)
        }
        if let centre = keepCentre {
            keepCentre = nil
            if !fitted { go(to: centre) }
        }
        viewMoved()
    }

    private func apply(_ step: ReviewZoomStep) {
        switch step {
        case .fit:
            magnification = fitScale
        case .actual:
            // One image pixel to one on screen, from the top of the page. An
            // image smaller than the stage is already past that, so it doubles.
            magnification = fitScale < 1 ? 1 : fitScale * 2
            startAtTop = true
        case .closer: zoom(by: Self.keyStep, around: nil)
        case .further: zoom(by: 1 / Self.keyStep, around: nil)
        }
        fitted = magnification <= fitScale * 1.001
    }

    /// Zooms keeping the spot under the pointer under it, or the middle of
    /// the view without one.
    func zoom(by factor: CGFloat, around windowPoint: NSPoint?) {
        let before = contentView.bounds
        let anchor = windowPoint.map { contentView.convert($0, from: nil) } ?? NSPoint(x: before.midX, y: before.midY)
        let across = (anchor.x - before.minX) / max(1, before.width)
        let down = (anchor.y - before.minY) / max(1, before.height)
        magnification = min(maxMagnification, max(minMagnification, magnification * factor))
        let after = contentView.bounds.size
        contentView.scroll(to: NSPoint(x: anchor.x - across * after.width, y: anchor.y - down * after.height))
        reflectScrolledClipView(contentView)
    }

    /// Puts the view's centre on a spot, given as fractions of the image.
    private func go(to point: NSPoint) {
        let document = picture.frame.size
        let clip = contentView.bounds.size
        contentView.scroll(to: NSPoint(x: point.x * document.width - clip.width / 2, y: point.y * document.height - clip.height / 2))
        reflectScrolledClipView(contentView)
    }

    /// Every zoom and scroll comes through here, pinches included, which
    /// AppKit runs itself.
    @objc private func viewMoved() {
        fitted = magnification <= fitScale * 1.001
        let cursor: NSCursor? = fitted || !zoomable ? nil : .openHand
        if documentCursor != cursor { documentCursor = cursor }
        let zoomed = zoomable && !fitted
        if zoomed != reportedZoomed {
            reportedZoomed = zoomed
            // Later, as this can run in the middle of SwiftUI laying us out.
            DispatchQueue.main.async { [weak self] in self?.onZoom?(zoomed) }
        }
        layoutMinimap()
        loadSharpEnough()
    }

    private func layoutMinimap() {
        let document = picture.frame.size
        let clip = contentView.bounds
        let overflows = zoomable && (clip.width < document.width - 1 || clip.height < document.height - 1)
        minimap.isHidden = !overflows
        guard overflows, let reference else { return }
        let room = NSSize(width: 150, height: max(40, bounds.height - 32))
        let scale = min(room.width / document.width, room.height / document.height)
        // Scrollers run down the right edge, so it stays clear of them.
        let size = NSSize(width: max(20, (document.width * scale).rounded()), height: max(20, (document.height * scale).rounded()))
        let frame = NSRect(x: bounds.width - size.width - 22, y: bounds.height - size.height - 16, width: size.width, height: size.height)
        if minimap.frame != frame { minimap.frame = frame }
        let visible = clip.intersection(NSRect(origin: .zero, size: document))
        minimap.show(visible: NSRect(x: visible.minX / document.width, y: visible.minY / document.height,
                                     width: visible.width / document.width, height: visible.height / document.height))
        if minimapPath != reference.path {
            let path = reference.path
            minimapPath = path
            ThumbnailLoader.shared.load(path: path, maxPixels: 1200) { [weak self] image in
                guard let self, self.minimapPath == path else { return }
                self.minimap.setPicture(image)
            }
        }
    }

    /// Decodes only as many pixels as are on show, and more as it's zoomed
    /// in: a 20,000 pixel page is 65 MB decoded and needn't be in a thumbnail.
    private func loadSharpEnough() {
        guard let reference else { return }
        let source = sourceSize
        let longest = max(source.width, source.height)
        let area = source.width * source.height
        let most = longest * min(1, (Self.mostPixels / max(1, area)).squareRoot())
        let needed = Int(min(most, ceil(longest * min(1, magnification))))
        guard needed > max(shownPixels, askedPixels) else { return }
        // Twice what's needed, so a zoom doesn't decode it again at each step.
        let pixels = Int(min(most, max(128, CGFloat(needed) * 2)))
        askedPixels = pixels
        let path = reference.path
        ThumbnailLoader.shared.load(path: path, maxPixels: pixels) { [weak self] image in
            guard let self, self.reference?.path == path else { return }
            guard let image else {
                guard self.shownPixels == 0 else { return }
                self.picture.setTip("Couldn’t load this image. The saved file may be missing.")
                self.picture.image = nil
                self.picture.unavailable = true
                return
            }
            // An earlier, smaller decode can arrive after a bigger one.
            guard pixels > self.shownPixels else { return }
            self.shownPixels = pixels
            self.picture.setTip("")
            self.picture.unavailable = false
            if self.orientedSize == nil {
                // ImageIO applied EXIF orientation while decoding. Keep its
                // ratio rather than the file header's unrotated size.
                let ratio = longest / CGFloat(max(image.width, image.height))
                let oriented = NSSize(width: CGFloat(image.width) * ratio, height: CGFloat(image.height) * ratio)
                let rotated = (oriented.width > oriented.height) != (source.width > source.height)
                self.orientedSize = rotated ? oriented : source
                if rotated { self.needsLayout = true }
            }
            self.picture.image = image
        }
    }

    // MARK: Pointer

    /// The stage takes every press and scroll itself, bar the scrollers and
    /// the minimap, so nothing inside has to know about clicks.
    override func hitTest(_ point: NSPoint) -> NSView? {
        guard let hit = super.hitTest(point) else { return nil }
        if hit === minimap || hit is NSScroller || hit.superview is NSScroller { return hit }
        return self
    }

    // The first click counts even if the window wasn't in front, like a
    // SwiftUI button beside it does.
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }

    override func mouseDown(with event: NSEvent) {
        if fitted || !zoomable {
            onClick?()
            return
        }
        if event.clickCount == 2 {
            apply(.fit)
            return
        }
        dragFrom = event.locationInWindow
        dragOrigin = contentView.bounds.origin
        NSCursor.closedHand.push()
    }

    override func mouseDragged(with event: NSEvent) {
        guard let dragFrom else { return }
        let moved = NSPoint(x: event.locationInWindow.x - dragFrom.x, y: event.locationInWindow.y - dragFrom.y)
        // The image follows the hand. It's flipped and window points aren't.
        contentView.scroll(to: NSPoint(x: dragOrigin.x - moved.x / magnification, y: dragOrigin.y + moved.y / magnification))
        reflectScrolledClipView(contentView)
    }

    override func mouseUp(with event: NSEvent) {
        guard dragFrom != nil else { return }
        dragFrom = nil
        NSCursor.pop()
    }

    override func scrollWheel(with event: NSEvent) {
        guard zoomable else { return super.scrollWheel(with: event) }
        // A made-up event has no window, and its location means nothing.
        let at = event.window == nil ? nil : event.locationInWindow
        let held = !event.modifierFlags.intersection([.command, .control, .option]).isEmpty
        if !event.hasPreciseScrollingDeltas {
            // A mouse wheel has no other way to zoom, and dragging moves
            // around. Shift is how a wheel scrolls sideways.
            if event.modifierFlags.contains(.shift) { return super.scrollWheel(with: event) }
            zoom(by: exp(event.scrollingDeltaY * Self.wheelStep), around: at)
            return
        }
        // Decided once per gesture: a scroll that starts while it fits zooms
        // to its end, and the coast after it does nothing. Otherwise the same
        // swipe would turn from zooming into scrolling as soon as it zoomed.
        if !event.momentumPhase.isEmpty {
            if !gestureZooms { super.scrollWheel(with: event) }
            return
        }
        if event.phase == .began || event.phase.isEmpty {
            gestureZooms = held || fitted
            gestureDirection = held ? 1 : 0
        }
        guard gestureZooms else { return super.scrollWheel(with: event) }
        // From fit, either way of swiping goes in, as out is nowhere: with
        // natural scrolling the swipe up you'd use to read on would do nothing.
        if gestureDirection == 0, event.scrollingDeltaY != 0 { gestureDirection = event.scrollingDeltaY > 0 ? 1 : -1 }
        zoom(by: exp(event.scrollingDeltaY * gestureDirection * Self.trackpadStep), around: at)
    }

    // A point is two pixels on one display and one on another.
    override func viewDidChangeBackingProperties() {
        super.viewDidChangeBackingProperties()
        needsLayout = true
    }

    // Two-finger double tap: AppKit's own guesses a column to zoom to.
    override func smartMagnify(with event: NSEvent) {
        guard zoomable else { return }
        if fitted { zoom(by: (fitScale < 1 ? 1 : fitScale * 2) / magnification, around: event.locationInWindow) } else { apply(.fit) }
    }

    #if DEBUG
    /// For ReviewWindowTests: the part of the image on show, in its points.
    var visibleForTests: NSRect { contentView.bounds }
    var pictureSizeForTests: NSSize { picture.frame.size }
    var isFittedForTests: Bool { fitted }
    #endif
}
