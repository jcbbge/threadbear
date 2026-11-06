import AppKit
import SwiftUI
import ThreadbearCore
import UniformTypeIdentifiers

/// The message box: a rounded card the width of the transcript column.
/// Return sends, Shift-Return adds a line (carrying a markdown list on), paste, drop or "+" adds images,
/// each as a chip in the words where the cursor is (PictureChips.swift)
/// with its thumbnail in the strip over them,
/// and the row under the text holds the account, model and permission
/// chips (and the folder's, away from the default) and send (or Stop).
struct ComposerView: View {
    @Environment(AppModel.self) private var app
    @Environment(\.colorScheme) private var colorScheme
    let thread: ThreadSummary?
    /// The thread's transcript and the controller drawing it, for its open
    /// card (ComposerCard); none for a new thread.
    var session: ThreadSession? = nil
    var controller: TranscriptController? = nil
    @State private var height: CGFloat = ComposerTextField.minHeight
    @State private var importing = 0
    @State private var handle = ComposerHandle()

    static var cornerRadius: CGFloat { zoomed(20) }
    static var padding: CGFloat { zoomed(14) }

    private var draftKey: String { thread?.id ?? "new" }

    var body: some View {
        // Normalized, so a picture added from outside the box (an ask's
        // box, a schedule left behind) shows as a chip too.
        let draft = Binding<Draft>(
            get: { (app.drafts[draftKey] ?? Draft()).normalized },
            set: { app.drafts[draftKey] = $0 }
        )
        // Answers picked on the open card of asks go with the message.
        let picks = thread.map { app.picks(for: $0) } ?? [:]
        // So are follow-ups ticked on a done card.
        let followUps = thread.map { app.pickedFollowUps(threadId: $0.id) } ?? FollowUpPicks()
        let canSend = !picks.isEmpty || !followUps.isEmpty || ComposerChips.canSend(text: draft.wrappedValue.text, imageCount: draft.wrappedValue.images.count)
        // A new thread on its way: what was sent stays, greyed and locked,
        // until the runner has made the thread.
        let creating = thread == nil && app.creatingThread
        // The open card sits at the top of the box (ComposerCard), not
        // while a message is being edited: the edit is a reply of its own.
        let cardRow = thread.flatMap { thread in app.editing[thread.id] == nil ? session?.openCard : nil }
        let needsYou = cardRow.map { row in if case .asks(let card) = row.content { !card.isDone } else { false } } ?? false
        let cardCollapsed = needsYou && thread.map { app.collapsedCards[$0.id] == cardRow?.seq } == true
        VStack(alignment: .leading, spacing: 0) {
        // The folder's actions (patches), on shelves sitting on the box's
        // top edge, in from its rounded corner (ActionChips).
        if let thread, !thread.actions.isEmpty || thread.patches.contains(where: { $0.untrusted != nil }) {
            ActionChips(thread: thread)
                .tourTarget(.actionChips)
                .padding(.horizontal, Self.cornerRadius)
                // Overlap the box's border, so the two read as one piece.
                .padding(.bottom, -0.5)
                .zIndex(1)
        }
        // The box: the open card over a line, then the message.
        VStack(alignment: .leading, spacing: 0) {
        if let cardRow, let controller {
            ComposerCard(row: cardRow, collapsed: cardCollapsed, controller: controller)
                .padding(.horizontal, Self.padding)
                .padding(.top, zoomed(8))
                .padding(.bottom, zoomed(10))
            Rectangle()
                .fill(Color(nsColor: .separatorColor))
                .frame(height: 0.5)
        }
        VStack(alignment: .leading, spacing: zoomed(10)) {
            if let thread, let edit = app.editing[thread.id] {
                EditingBanner(sending: edit.sending) { app.cancelEditing(threadId: thread.id) }
            } else if let thread, !picks.isEmpty, cardRow == nil || cardCollapsed {
                // With the card open right above, its buttons show what's
                // picked. Collapsed, the picks would go with no sign of them.
                AnswerChips(thread: thread, picks: picks)
            }
            if !draft.wrappedValue.images.isEmpty || importing > 0 {
                AttachmentStrip(images: draft.wrappedValue.images, importing: importing) { removePicture(at: $0, from: draft) }
                    .disabled(creating)
                    .opacity(creating ? 0.5 : 1)
            }
            ComposerTextField(
                draft: draft,
                height: $height,
                focusTrigger: app.focusRequests[draftKey] ?? 0,
                placeholder: placeholder(picks, followUps: followUps, needsYou: needsYou),
                onSend: { send() },
                onReturnWhenEmpty: { returnWhenEmpty(draft.wrappedValue) },
                pictures: ComposerTextView.Pictures(allowed: { picturesAllowed() }, importOne: { await importPicture($0) }),
                handle: handle,
                onEscape: { cancelEdit() },
                editable: !creating
            )
            .frame(height: height)
            .opacity(creating ? 0.5 : 1)
            ComposerControls(
                thread: thread,
                running: thread?.status.isBusy == true,
                canSend: canSend,
                sending: creating,
                onAttach: { chooseImages(for: draft) },
                onSend: { send() },
                onSchedule: { app.newSchedule(from: thread, draftKey: draftKey) }
            )
        }
        .padding(Self.padding)
        }
        .background { card(attention: needsYou) }
        }
        // The transcript's reading column: 780 wide at most at 100%,
        // centred, with the same side insets once the window is narrower.
        .frame(maxWidth: Theme.maxContentWidth)
        .padding(.horizontal, Theme.sideInset)
        // At 12 the card looked wedged against the window's rounded bottom
        // corners; Codex and T3 leave about 24.
        .padding(.bottom, zoomed(20))
        .padding(.top, zoomed(4))
    }

    /// A lighter fill on dark; on light, white lifted off the page by a
    /// soft shadow. Clicking the card's padding puts the cursor in the text.
    /// Outlined in the accent while the card in it needs Mike, as the
    /// card was in the transcript.
    private func card(attention: Bool) -> some View {
        let shape = RoundedRectangle(cornerRadius: Self.cornerRadius, style: .continuous)
        let dark = colorScheme == .dark
        return shape
            // About #2e2e2e on the #1c1c1c pane: at 0.05 the card was barely
            // lighter than the pane and read as an outline, not a card.
            .fill(dark ? Color.primary.opacity(0.085) : Color.white)
            .shadow(color: .black.opacity(dark ? 0 : 0.08), radius: zoomed(14), y: zoomed(4))
            .overlay(shape.strokeBorder(attention ? Color(nsColor: .controlAccentColor) : Color(nsColor: .separatorColor), lineWidth: attention ? 1 : 0.5))
            .contentShape(shape)
            .onTapGesture { app.focusComposer(draftKey) }
    }

    /// Esc while editing a message leaves the edit.
    private func cancelEdit() -> Bool {
        guard let thread, app.editing[thread.id] != nil else { return false }
        app.cancelEditing(threadId: thread.id)
        return true
    }

    /// With answers picked, the box is for anything else: a Something
    /// else answer has its own box on the card. Under asks with none
    /// picked, it's the way to answer in other words.
    private func placeholder(_ picks: [Int: Int], followUps: FollowUpPicks, needsYou: Bool) -> String {
        if let thread, app.editing[thread.id] != nil { return "Your message…" }
        if !picks.isEmpty || !followUps.isEmpty { return "Add anything else…" }
        return needsYou ? "Or say something else…" : "Message"
    }

    /// AppModel empties the box, and puts the draft back if it isn't sent.
    /// Picked answers go with it.
    private func send() {
        app.send(threadId: thread?.id)
    }

    /// Return with nothing typed sends picked answers on their own, or
    /// else allows the sole approval (below).
    private func returnWhenEmpty(_ draft: Draft) -> Bool {
        // An edit with only pictures left still sends; an empty one does nothing.
        if let thread, app.editing[thread.id] != nil {
            if !draft.images.isEmpty { send() }
            return true
        }
        if let thread, !app.picks(for: thread).isEmpty || !app.pickedFollowUps(threadId: thread.id).isEmpty {
            send()
            return true
        }
        return draft.images.isEmpty && allowSoleApproval()
    }

    /// Return in an empty box allows the open thread's approval card, the
    /// ⏎ its Allow button shows, when there's exactly one waiting (with
    /// two, Return can't know which). Read when the key is pressed, so the
    /// composer doesn't redraw as approvals come and go.
    private func allowSoleApproval() -> Bool {
        guard let thread else { return false }
        let session = app.session(for: thread.id)
        let pending = session.model.pendingApprovalIds
        guard pending.count == 1, let id = pending.first else { return false }
        session.respond(approvalId: id, decision: .allow, answers: nil, message: nil)
        return true
    }

    /// Whether pictures can go in this box, saying why not when they can't.
    /// Through Convex, this Mac's runner uploads them for the other runner
    /// to fetch; over the direct link a picture this Mac's runner keeps
    /// would be a path the other runner hasn't got.
    private func picturesAllowed() -> Bool {
        guard app.directRemoteLink else { return true }
        if let name = thread.flatMap(app.runnerName(of:)) ?? (thread == nil ? app.newThreadRunner?.name : nil) {
            app.errorMessage = "Pictures can't go to \(name) over the direct link yet."
            return false
        }
        return true
    }

    /// Paste, drop and the "+" button put a chip in the words, and each
    /// picture goes through the runner's `media.import` (here) meanwhile.
    private func importPicture(_ url: URL) async -> ImageRef? {
        importing += 1
        let ref = await app.importImages([url]).first
        importing -= 1
        return ref
    }

    /// With no text view to put them in, pictures go at the end.
    private func attach(_ urls: [URL], to draft: Binding<Draft>) {
        guard !urls.isEmpty, picturesAllowed() else { return }
        importing += urls.count
        Task {
            let refs = await app.importImages(urls)
            importing -= urls.count
            draft.wrappedValue.append(refs)
        }
    }

    /// The strip's remove button: through the words, so the chip goes too,
    /// as one undo, and the cursor stays where it was.
    private func removePicture(at index: Int, from draft: Binding<Draft>) {
        if handle.textView?.removePicture(at: index) == true { return }
        draft.wrappedValue = draft.wrappedValue.removingImage(at: index)
    }

    private func chooseImages(for draft: Binding<Draft>) {
        let panel = NSOpenPanel()
        panel.canChooseFiles = true
        panel.canChooseDirectories = false
        panel.allowsMultipleSelection = true
        panel.allowedContentTypes = [.image]
        panel.prompt = "Add"
        let finish = { (response: NSApplication.ModalResponse) in
            guard response == .OK else { return }
            // Chips where the cursor was, as a paste would put them.
            if let textView = handle.textView {
                textView.insertPictures(panel.urls)
            } else {
                attach(panel.urls, to: draft)
            }
        }
        if let window = NSApp.keyWindow {
            panel.beginSheetModal(for: window, completionHandler: finish)
        } else {
            finish(panel.runModal())
        }
    }
}

/// Over the text while one of Mike's messages is being edited: what
/// sending will do, and the way out.
private struct EditingBanner: View {
    let sending: Bool
    let onCancel: () -> Void

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: zoomed(6)) {
            Image(systemName: "pencil")
                .font(.system(size: TypeScale.sidebarMeta))
                .foregroundStyle(.secondary)
            Text(sending
                 ? "Cutting the thread back to this message…"
                 : "Editing a message. Sending cuts the thread back to it and undoes the agent's file changes since.")
                .font(.system(size: TypeScale.sidebarMeta + 1))
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            Spacer(minLength: zoomed(8))
            if sending {
                ProgressView().controlSize(.small)
            } else {
                Button("Cancel", action: onCancel)
                    .buttonStyle(.link)
                    .font(.system(size: TypeScale.sidebarMeta + 1))
                    .tip("Stop editing and put back what was in the box (Esc)")
            }
        }
    }
}

private struct AttachmentStrip: View {
    let images: [ImageRef]
    let importing: Int
    let onRemove: (Int) -> Void

    var body: some View {
        HStack(spacing: zoomed(8)) {
            ForEach(Array(images.enumerated()), id: \.offset) { index, image in
                AttachmentThumbnail(path: image.path) { onRemove(index) }
            }
            // One placeholder per image still being imported, so the strip
            // doesn't jump when they arrive.
            ForEach(0..<importing, id: \.self) { _ in
                RoundedRectangle(cornerRadius: AttachmentThumbnail.cornerRadius, style: .continuous)
                    .fill(Color.primary.opacity(0.06))
                    .frame(width: AttachmentThumbnail.size, height: AttachmentThumbnail.size)
                    .overlay(ProgressView().controlSize(.small))
            }
        }
    }
}

struct AttachmentThumbnail: View {
    let path: String
    let onRemove: () -> Void
    @State private var hovering = false

    static var size: CGFloat { zoomed(56) }
    static var cornerRadius: CGFloat { zoomed(8) }
    /// Screenshots show the remove badge without a real hover.
    static var debugShowRemove = false

    var body: some View {
        let shape = RoundedRectangle(cornerRadius: Self.cornerRadius, style: .continuous)
        AsyncThumbnail(path: path)
            .frame(width: Self.size, height: Self.size)
            .clipShape(shape)
            .overlay(shape.strokeBorder(Color(nsColor: .separatorColor), lineWidth: 0.5))
            .overlay(alignment: .topTrailing) {
                if hovering || Self.debugShowRemove {
                    Button(action: onRemove) {
                        Image(systemName: "xmark")
                            .font(.system(size: zoomed(8), weight: .bold))
                            .foregroundStyle(.white)
                            .frame(width: zoomed(18), height: zoomed(18))
                            .background(Circle().fill(.black.opacity(0.72)))
                            .overlay(Circle().strokeBorder(.white.opacity(0.2), lineWidth: 0.5))
                            .contentShape(Circle())
                    }
                    .buttonStyle(.plain)
                    .padding(zoomed(4))
                    .tip("Remove")
                    .accessibilityLabel("Remove image")
                }
            }
            .onHover { hovering = $0 }
    }
}

private struct AsyncThumbnail: View {
    let path: String
    @State private var image: CGImage?

    var body: some View {
        Group {
            if let image {
                Image(decorative: image, scale: 2).resizable().aspectRatio(contentMode: .fill)
            } else {
                Rectangle().fill(Color.primary.opacity(0.06))
            }
        }
        .onAppear {
            // Filled into a square, so the short side needs the 2x pixels:
            // decode a bit larger than the tile or wide shots come out soft.
            ThumbnailLoader.shared.load(path: path, maxPixels: Int(AttachmentThumbnail.size * 4)) { image = $0 }
        }
    }
}

/// The composer's text view, for the "+" button and the strip's remove
/// buttons, which work on the words where the cursor is.
final class ComposerHandle {
    weak var textView: ComposerTextView?
}

/// NSTextView-backed field that grows with its text: two lines at least,
/// ten at most, then it scrolls.
struct ComposerTextField: NSViewRepresentable {
    /// Read straight off the text: its words, a mark for each picture's
    /// chip, and the pictures in the chips' order.
    @Binding var draft: Draft
    @Binding var height: CGFloat
    var focusTrigger: Int
    var placeholder: String
    var onSend: () -> Void
    /// Return with nothing typed: true if it did something.
    var onReturnWhenEmpty: () -> Bool = { false }
    var pictures: ComposerTextView.Pictures?
    var handle: ComposerHandle?
    /// Esc: true if it did something (left an edit).
    var onEscape: () -> Bool = { false }
    /// False while what's in it is being sent (a new thread being made).
    var editable = true

    // Computed, so they follow the zoom (`applyTypeScale` re-applies
    // them to a text view that's already up).
    static var font: NSFont { .systemFont(ofSize: TypeScale.composer) }
    /// The transcript's fixed body line height, glyphs centred in it, so a
    /// message keeps its rhythm when it's sent (at 18 + 3 spacing the box
    /// was denser than the bubble it became).
    static var lineHeight: CGFloat { TypeScale.bodyLine }
    static var attributes: [NSAttributedString.Key: Any] {
        let font = font
        let (style, offset) = Theme.lines(lineHeight, font: font)
        return [.font: font, .foregroundColor: NSColor.labelColor, .paragraphStyle: style, .baselineOffset: offset]
    }
    /// Two lines, before the first measure comes in.
    static var minHeight: CGFloat { lineHeight * 2 }

    func makeCoordinator() -> Coordinator { Coordinator(self) }

    func makeNSView(context: Context) -> NSScrollView {
        let textView = Self.makeTextView()
        textView.delegate = context.coordinator
        textView.placeholder = placeholder
        let scroll = OverlayScrollView()
        scroll.documentView = textView
        scroll.drawsBackground = false
        scroll.hasVerticalScroller = true
        scroll.autohidesScrollers = true
        scroll.scrollerStyle = .overlay
        scroll.borderType = .noBorder
        context.coordinator.textView = textView
        handle?.textView = textView
        context.coordinator.watchWidth(of: scroll)
        DispatchQueue.main.async { context.coordinator.updateHeight() }
        return scroll
    }

    static func makeTextView() -> ComposerTextView {
        let textView = ComposerTextView()
        textView.textColor = .labelColor
        textView.applyTypeScale()
        textView.isRichText = false
        textView.allowsUndo = true
        textView.drawsBackground = false
        // No inset or padding, so the text's left edge lines up with the
        // chips under it and the height is whole lines.
        textView.textContainerInset = .zero
        textView.textContainer?.lineFragmentPadding = 0
        textView.isAutomaticQuoteSubstitutionEnabled = false
        textView.isAutomaticDashSubstitutionEnabled = false
        textView.isVerticallyResizable = true
        textView.isHorizontallyResizable = false
        textView.minSize = .zero
        textView.maxSize = NSSize(width: CGFloat.greatestFiniteMagnitude, height: CGFloat.greatestFiniteMagnitude)
        textView.autoresizingMask = [.width]
        textView.textContainer?.widthTracksTextView = true
        return textView
    }

    /// The box height for the text as laid out now: whole lines, two to ten.
    static func fittingHeight(of textView: NSTextView) -> CGFloat {
        guard let layoutManager = textView.layoutManager, let container = textView.textContainer else { return minHeight }
        layoutManager.ensureLayout(for: container)
        let used = layoutManager.usedRect(for: container).height
        return ComposerChips.boxHeight(textHeight: used, lineHeight: lineHeight)
    }

    func updateNSView(_ scroll: NSScrollView, context: Context) {
        context.coordinator.parent = self
        guard let textView = scroll.documentView as? ComposerTextView else { return }
        textView.onSend = onSend
        textView.onReturnWhenEmpty = onReturnWhenEmpty
        textView.pictures = pictures
        textView.onEscape = onEscape
        textView.placeholder = placeholder
        handle?.textView = textView
        if textView.isEditable != editable { textView.isEditable = editable }
        let wanted = draft.normalized
        if textView.draftNow != wanted {
            textView.show(wanted)
            context.coordinator.updateHeight()
        }
        if context.coordinator.lastFocus != focusTrigger {
            context.coordinator.lastFocus = focusTrigger
            DispatchQueue.main.async { textView.window?.makeFirstResponder(textView) }
        }
    }

    final class Coordinator: NSObject, NSTextViewDelegate {
        var parent: ComposerTextField
        weak var textView: ComposerTextView?
        var lastFocus = 0
        private var lastWidth: CGFloat = 0
        private var widthObserver: NSObjectProtocol?
        private var zoomObserver: NSObjectProtocol?

        init(_ parent: ComposerTextField) {
            self.parent = parent
            lastFocus = parent.focusTrigger
            super.init()
            zoomObserver = NotificationCenter.default.addObserver(forName: TextZoom.didChange, object: nil, queue: .main) { [weak self] _ in
                guard let self, let textView = self.textView else { return }
                textView.applyTypeScale()
                self.updateHeight()
            }
        }

        deinit {
            if let widthObserver { NotificationCenter.default.removeObserver(widthObserver) }
            if let zoomObserver { NotificationCenter.default.removeObserver(zoomObserver) }
        }

        /// A narrower window wraps the text onto more lines, so the box
        /// re-measures when its width changes (and only then).
        func watchWidth(of scroll: NSScrollView) {
            scroll.postsFrameChangedNotifications = true
            widthObserver = NotificationCenter.default.addObserver(forName: NSView.frameDidChangeNotification, object: scroll, queue: .main) { [weak self, weak scroll] _ in
                guard let self, let scroll, abs(scroll.frame.width - self.lastWidth) > 0.5 else { return }
                self.lastWidth = scroll.frame.width
                self.updateHeight()
            }
        }

        func textDidChange(_ notification: Notification) {
            guard let textView else { return }
            parent.draft = textView.draftNow
            updateHeight()
        }

        func updateHeight() {
            guard let textView else { return }
            let height = ComposerTextField.fittingHeight(of: textView)
            if abs(height - parent.height) > 0.5 {
                DispatchQueue.main.async { self.parent.height = height }
            }
        }
    }
}

final class ComposerTextView: NSTextView {
    // Clicks count while Threadbear isn't the app in front (FirstClick.swift).
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }

    /// One of a card's Something else boxes (AskAnswerBox), not the
    /// composer: lookups for the composer skip it.
    var inAnswerBox = false
    var onSend: (() -> Void)?
    var onReturnWhenEmpty: (() -> Bool)?
    var onEscape: (() -> Bool)?
    /// Pictures pasted or dropped in an ask's box, which keeps them beside
    /// its words (AskAnswerBox). The composer sets `pictures` instead.
    var onImages: (([URL]) -> Void)?
    /// Set in the composer: pictures pasted, dropped or chosen become chips
    /// in the words where the cursor is (PictureAttachment), each copied in
    /// through the runner as it shows.
    var pictures: Pictures?
    var placeholder = "" {
        didSet { if placeholder != oldValue { needsDisplay = true } }
    }

    override init(frame frameRect: NSRect, textContainer container: NSTextContainer?) {
        super.init(frame: frameRect, textContainer: container)
        registerForDraggedTypes([.fileURL, .png, .tiff])
    }

    /// Builds its own TextKit 1 stack. `init(frame:textContainer: nil)` makes
    /// a text view with no text storage at all, which silently drops every
    /// keystroke (the review found nobody could type a message).
    convenience init() {
        let storage = NSTextStorage()
        let layoutManager = NSLayoutManager()
        storage.addLayoutManager(layoutManager)
        let container = NSTextContainer(size: NSSize(width: 100, height: CGFloat.greatestFiniteMagnitude))
        container.widthTracksTextView = true
        layoutManager.addTextContainer(container)
        self.init(frame: .zero, textContainer: container)
    }

    required init?(coder: NSCoder) { fatalError() }

    /// A draft from another thread, or the box emptied after a send.
    /// Setting `string` doesn't reliably take the typing attributes, so the
    /// font and line spacing are put back on the whole text.
    func replaceText(_ text: String) {
        string = text
        restyle()
    }

    /// The font and line height at the current zoom, for what's typed
    /// next and (after a zoom change) what's already in the box.
    func applyTypeScale() {
        let attributes = ComposerTextField.attributes
        font = ComposerTextField.font
        defaultParagraphStyle = attributes[.paragraphStyle] as? NSParagraphStyle
        typingAttributes = attributes
        restyle()
    }

    /// The composer's font and line spacing on the whole text, keeping the
    /// pictures' chips (setAttributes alone would drop them).
    private func restyle() {
        guard let storage = textStorage, storage.length > 0 else { return }
        let whole = NSRange(location: 0, length: storage.length)
        var chips: [(NSRange, Any)] = []
        storage.enumerateAttribute(.attachment, in: whole) { value, range, _ in
            if let value { chips.append((range, value)) }
        }
        storage.beginEditing()
        storage.setAttributes(ComposerTextField.attributes, range: whole)
        for (range, chip) in chips { storage.addAttribute(.attachment, value: chip, range: range) }
        storage.endEditing()
    }

    // MARK: A chip's hover card
    //
    // The picture over a chip in the box, as in Mike's bubble, to tell which
    // is which. A click stays the cursor's (PictureChipCell), so here it's
    // the hover alone.

    private var chipTracking: NSTrackingArea?
    private var chipCard: ChipCardWindow?
    private var hoveredChip: PictureAttachment?
    private var chipTimer: Timer?

    override func updateTrackingAreas() {
        super.updateTrackingAreas()
        guard chipTracking == nil else { return }
        let area = NSTrackingArea(rect: .zero, options: [.mouseEnteredAndExited, .mouseMoved, .activeInKeyWindow, .inVisibleRect], owner: self)
        addTrackingArea(area)
        chipTracking = area
    }

    override func mouseMoved(with event: NSEvent) {
        super.mouseMoved(with: event)
        hoverChip(chipUnder(convert(event.locationInWindow, from: nil)))
    }

    override func mouseExited(with event: NSEvent) {
        super.mouseExited(with: event)
        hoverChip(nil)
    }

    override func mouseDown(with event: NSEvent) {
        hoverChip(nil)
        super.mouseDown(with: event)
    }

    override func viewWillMove(toWindow newWindow: NSWindow?) {
        super.viewWillMove(toWindow: newWindow)
        if newWindow == nil { hoverChip(nil) }
    }

    private func hoverChip(_ chip: PictureAttachment?) {
        guard chip !== hoveredChip else { return }
        chipTimer?.invalidate()
        chipTimer = nil
        chipCard?.dismiss()
        chipCard = nil
        hoveredChip = chip
        guard chip != nil else { return }
        chipTimer = Timer.scheduledTimer(withTimeInterval: 0.35, repeats: false) { [weak self] _ in
            MainActor.assumeIsolated { self?.showChipCard() }
        }
    }

    private func showChipCard() {
        guard let chip = hoveredChip, let window, let rect = range(of: chip).flatMap(chipRect) else { return }
        let peek = LinkPeek(url: URL(fileURLWithPath: chip.picture?.path ?? chip.source), title: PictureChip.label(chip.number), pictureOnly: true)
        chipCard = ChipCardWindow.show(LinkPeekCard(peek: peek), below: window.convertToScreen(convert(rect, to: nil)), parent: window, above: true)
    }

    /// The chip at `point` in this view.
    private func chipUnder(_ point: NSPoint) -> PictureAttachment? {
        guard let layoutManager, let textContainer, let storage = textStorage, storage.length > 0 else { return nil }
        let origin = textContainerOrigin
        let glyph = layoutManager.glyphIndex(for: NSPoint(x: point.x - origin.x, y: point.y - origin.y), in: textContainer)
        let index = layoutManager.characterIndexForGlyph(at: glyph)
        guard index < storage.length, let chip = storage.attribute(.attachment, at: index, effectiveRange: nil) as? PictureAttachment,
              chipRect(NSRange(location: index, length: 1))?.contains(point) == true else { return nil }
        return chip
    }

    /// A chip's box in this view.
    private func chipRect(_ range: NSRange) -> NSRect? {
        guard let layoutManager, let textContainer else { return nil }
        let glyphs = layoutManager.glyphRange(forCharacterRange: range, actualCharacterRange: nil)
        let origin = textContainerOrigin
        return layoutManager.boundingRect(forGlyphRange: glyphs, in: textContainer).offsetBy(dx: origin.x, dy: origin.y)
    }

    #if DEBUG
    /// Rests the pointer on the chip numbered `number`, through the same
    /// lookup as a real one; says the card's window number once it shows.
    func debugHoverChip(_ number: Int) -> Int? {
        var found: PictureAttachment?
        textStorage?.enumerateAttribute(.attachment, in: whole) { value, _, _ in
            if let chip = value as? PictureAttachment, chip.number == number { found = chip }
        }
        guard let found, let rect = range(of: found).flatMap(chipRect), chipUnder(NSPoint(x: rect.midX, y: rect.midY)) === found else { return nil }
        hoverChip(found)
        showChipCard()
        return chipCard?.windowNumber
    }

    func debugEndHover() { hoverChip(nil) }
    #endif

    override func keyDown(with event: NSEvent) {
        hoverChip(nil)
        let isReturn = event.keyCode == 36 || event.keyCode == 76
        if isReturn, !hasMarkedText() {
            if event.modifierFlags.contains(.shift) || event.modifierFlags.contains(.option) {
                insertLineContinuingList()
            } else if string.isEmpty, onReturnWhenEmpty?() == true {
                // Allowed the waiting approval.
            } else {
                onSend?()
            }
            return
        }
        super.keyDown(with: event)
    }

    /// A new line that carries on a markdown list ("2. " after "1. foo"),
    /// or ends it from an empty item. Through `insertText`, so it's one undo.
    private func insertLineContinuingList() {
        guard let edit = ListContinuation.newline(in: string, selection: selectedRange()) else {
            insertNewlineIgnoringFieldEditor(nil)
            return
        }
        insertText(edit.text, replacementRange: edit.range)
    }

    override func cancelOperation(_ sender: Any?) {
        if onEscape?() == true { return }
        // Not super: NSTextView and NSResponder only declare cancelOperation:,
        // so that call throws "unrecognized selector", and Sentry's
        // uncaught-exception option makes that fatal (THREADBEAR-K). This
        // offers Esc to whatever's above the box instead.
        nextResponder?.tryToPerform(#selector(NSResponder.cancelOperation(_:)), with: sender)
    }

    override func paste(_ sender: Any?) {
        if takeImages(from: .general) { return }
        super.paste(sender)
    }

    override func draggingEntered(_ sender: NSDraggingInfo) -> NSDragOperation {
        let operation = super.draggingEntered(sender)
        return hasFiles(sender.draggingPasteboard) ? .copy : operation
    }

    /// Super's still runs, for the caret showing where it'll go, but a
    /// plain text view turns a file other than a picture away, so a video
    /// dropped on the box did nothing (3 Nov).
    override func draggingUpdated(_ sender: NSDraggingInfo) -> NSDragOperation {
        let operation = super.draggingUpdated(sender)
        return hasFiles(sender.draggingPasteboard) ? .copy : operation
    }

    override func performDragOperation(_ sender: NSDraggingInfo) -> Bool {
        // Where it's dropped, as a paste goes where the cursor is.
        let at = characterIndexForInsertion(at: convert(sender.draggingLocation, from: nil))
        if takeImages(from: sender.draggingPasteboard, at: NSRange(location: at, length: 0)) { return true }
        return super.performDragOperation(sender)
    }

    private func fileURLs(_ pasteboard: NSPasteboard) -> [URL] {
        let options: [NSPasteboard.ReadingOptionKey: Any] = [.urlReadingFileURLsOnly: true]
        return pasteboard.readObjects(forClasses: [NSURL.self], options: options) as? [URL] ?? []
    }

    private func isImage(_ url: URL) -> Bool {
        (try? url.resourceValues(forKeys: [.contentTypeKey]).contentType?.conforms(to: .image)) == true
    }

    private func hasFiles(_ pasteboard: NSPasteboard) -> Bool {
        !fileURLs(pasteboard).isEmpty || pasteboard.data(forType: .png) != nil || pasteboard.data(forType: .tiff) != nil
    }

    /// Files pasted or dropped. Pictures go to `media.import` as chips;
    /// raw image data (a screenshot on the clipboard) is written to a temp
    /// PNG first. Any other file (a video, a PDF, a folder) goes in as its
    /// full path, for the agent to open where it is: nothing's copied, so
    /// a big one costs nothing. In the composer they go in place of
    /// `range` (the selection, for a paste).
    func takeImages(from pasteboard: NSPasteboard, at range: NSRange? = nil) -> Bool {
        let urls = fileURLs(pasteboard)
        if !urls.isEmpty {
            let images = urls.filter(isImage)
            let others = urls.filter { !isImage($0) }
            var at = range
            if !others.isEmpty { at = insertPaths(others, replacing: range) }
            if !images.isEmpty { deliver(images, at: at) }
            return true
        }
        // Text with an image flavour (rich text from a browser) stays text.
        if pasteboard.string(forType: .string) != nil { return false }
        guard let data = pasteboard.data(forType: .png) ?? pasteboard.data(forType: .tiff) else { return false }
        let png: Data?
        if pasteboard.data(forType: .png) != nil {
            png = data
        } else {
            png = NSBitmapImageRep(data: data)?.representation(using: .png, properties: [:])
        }
        guard let png else { return false }
        let folder = FileManager.default.temporaryDirectory.appendingPathComponent("threadbear-paste", isDirectory: true)
        try? FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        let url = folder.appendingPathComponent("pasted-\(UUID().uuidString.prefix(8)).png")
        do {
            try png.write(to: url)
            deliver([url], at: range)
            return true
        } catch {
            return false
        }
    }

    /// What a dropped file that isn't a picture puts in the words: its
    /// full path in backticks, so one with spaces in its name (every
    /// screen recording) still reads as one path.
    static func pathText(for urls: [URL]) -> String {
        urls.map { "`\($0.standardizedFileURL.path)`" }.joined(separator: " ")
    }

    /// `urls` as paths in place of `range` (the selection by default), with
    /// a space either side, through `insertText` so it's one undo. Answers
    /// where the cursor is after them, for any pictures dropped alongside.
    private func insertPaths(_ urls: [URL], replacing range: NSRange?) -> NSRange {
        let ns = string as NSString
        let picked = range ?? selectedRange()
        let location = min(picked.location, ns.length)
        let replace = NSRange(location: location, length: min(picked.length, ns.length - location))
        func isSpace(_ index: Int) -> Bool {
            guard index >= 0, index < ns.length, let scalar = Unicode.Scalar(ns.character(at: index)) else { return false }
            return CharacterSet.whitespacesAndNewlines.contains(scalar)
        }
        var piece = Self.pathText(for: urls)
        if location > 0, !isSpace(location - 1) { piece = " " + piece }
        if !isSpace(NSMaxRange(replace)) { piece += " " }
        window?.makeFirstResponder(self)
        insertText(piece, replacementRange: replace)
        return NSRange(location: location + (piece as NSString).length, length: 0)
    }

    private func deliver(_ urls: [URL], at range: NSRange?) {
        if pictures != nil {
            insertPictures(urls, replacing: range)
        } else {
            onImages?(urls)
        }
    }

    /// Mid grey on the dark card, like Codex's and Claude's: the system
    /// placeholder colour there was about 2.3:1, the dimmest of the four
    /// apps. Light mode keeps the system colour.
    static let placeholderColor = NSColor(name: nil) { appearance in
        appearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua ? NSColor(white: 1, alpha: 0.45) : .placeholderTextColor
    }

    /// The placeholder is drawn outside the glyphs, so the first character
    /// typed (or the last one deleted) has to redraw the whole box.
    private var wasEmpty = true

    override func didChangeText() {
        renumberPictures()
        super.didChangeText()
        if string.isEmpty != wasEmpty {
            wasEmpty = string.isEmpty
            needsDisplay = true
        }
    }

    override var string: String {
        didSet {
            wasEmpty = string.isEmpty
            needsDisplay = true
        }
    }

    override func draw(_ dirtyRect: NSRect) {
        super.draw(dirtyRect)
        if string.isEmpty, !placeholder.isEmpty {
            var attributes = ComposerTextField.attributes
            attributes[.foregroundColor] = Self.placeholderColor
            // Where the first character would go, on the same line height
            // and baseline, so typing doesn't shift it.
            let x = textContainerInset.width + (textContainer?.lineFragmentPadding ?? 0)
            let rect = NSRect(x: x, y: textContainerInset.height, width: max(0, bounds.width - x), height: ComposerTextField.lineHeight)
            NSAttributedString(string: placeholder, attributes: attributes).draw(with: rect, options: [.usesLineFragmentOrigin])
        }
    }
}

// MARK: Pictures among the words

/// What the composer's pictures are in the text (docs/protocol.md,
/// "Pictures in a message"): each a `PictureAttachment` on a U+FFFC, the
/// k-th standing for the draft's k-th picture, so the draft is read
/// straight off the text and undo, cut and paste carry the pictures along.
extension ComposerTextView {
    struct Pictures {
        /// Whether pictures can go in at all; says why not itself.
        var allowed: () -> Bool
        /// Copies one in through the runner (`media.import`); nil if it couldn't.
        var importOne: @MainActor (URL) async -> ImageRef?
    }

    /// Chips and their pictures copied or cut in the composer, so a paste
    /// there brings the pictures back, not just their marks.
    struct Clip: Codable {
        var text: String
        var images: [ImageRef]
    }

    static let clipType = NSPasteboard.PasteboardType("com.mikerosoft.threadbear.composer-pictures")

    private var whole: NSRange { NSRange(location: 0, length: textStorage?.length ?? 0) }

    /// What the box holds as a draft: the words, with a mark for each chip
    /// whose picture is in, and those pictures in order. A chip still being
    /// copied in isn't part of it yet, nor is a stray U+FFFC pasted as text.
    var draftNow: Draft { draft(in: whole) }

    func draft(in range: NSRange) -> Draft {
        guard let storage = textStorage, range.length > 0, NSMaxRange(range) <= storage.length else { return Draft() }
        let ns = storage.string as NSString
        var text = ""
        var images: [ImageRef] = []
        var last = range.location
        func words(to end: Int) {
            guard end > last else { return }
            text += InlinePictures.words(ns.substring(with: NSRange(location: last, length: end - last)))
        }
        storage.enumerateAttribute(.attachment, in: range) { value, run, _ in
            guard value != nil else { return }
            words(to: run.location)
            for i in run.location..<NSMaxRange(run) where ns.character(at: i) == 0xFFFC {
                let attachment = storage.attribute(.attachment, at: i, effectiveRange: nil)
                if let picture = (attachment as? PictureAttachment)?.picture {
                    text += InlinePictures.markString
                    images.append(picture)
                } else if let card = attachment as? CardAttachment {
                    // A card is its plain link in the draft and the message.
                    text += card.reference
                }
            }
            last = NSMaxRange(run)
        }
        words(to: NSMaxRange(range))
        return Draft(text: text, images: images)
    }

    /// A draft in the box (another thread's, or the box emptied after a
    /// send), its marks drawn as chips. Like `replaceText`, the cursor goes
    /// to the end.
    func show(_ draft: Draft) {
        guard let storage = textStorage else { return }
        storage.setAttributedString(chips(for: draft.normalized))
        setSelectedRange(NSRange(location: storage.length, length: 0))
        renumberPictures()
        if string.isEmpty != wasEmpty { wasEmpty = string.isEmpty }
        needsDisplay = true
    }

    /// A draft's words in the composer's style, each mark a chip for its
    /// picture.
    private func chips(for draft: Draft) -> NSAttributedString {
        let attributes = ComposerTextField.attributes
        let out = NSMutableAttributedString()
        var images = draft.images.makeIterator()
        var run = ""
        // Words, with any Notion card or thread mentioned in them drawn as
        // its chip.
        func flush() {
            let ns = run as NSString
            var last = 0
            for mention in CardMentions.find(in: run) {
                out.append(NSAttributedString(string: ns.substring(with: NSRange(location: last, length: mention.range.location - last)), attributes: attributes))
                out.append(chip(CardAttachment(reference: ns.substring(with: mention.range), title: mention.title, kind: mention.kind)))
                last = NSMaxRange(mention.range)
            }
            out.append(NSAttributedString(string: ns.substring(from: last), attributes: attributes))
            run = ""
        }
        for scalar in draft.text.unicodeScalars {
            if scalar == InlinePictures.mark {
                if let picture = images.next() {
                    flush()
                    let attachment = PictureAttachment(picture: picture, source: picture.path)
                    attachment.owner = self
                    out.append(chip(attachment))
                }
            } else {
                run.unicodeScalars.append(scalar)
            }
        }
        flush()
        return out
    }

    private func chip(_ attachment: NSTextAttachment) -> NSAttributedString {
        (attachment as? PictureAttachment)?.owner = self
        var attributes = ComposerTextField.attributes
        attributes[.attachment] = attachment
        return NSAttributedString(string: InlinePictures.markString, attributes: attributes)
    }

    /// Chips for `urls` in place of `range` (the selection by default),
    /// with a space either side, as T3 Code does. Each is copied in through
    /// the runner as it shows, dimmed until it's in; one that can't be read
    /// goes again.
    func insertPictures(_ urls: [URL], replacing range: NSRange? = nil) {
        guard !urls.isEmpty else { return }
        guard let pictures else {
            onImages?(urls)
            return
        }
        guard pictures.allowed(), let storage = textStorage else { return }
        let ns = storage.string as NSString
        let picked = range ?? selectedRange()
        let location = min(picked.location, ns.length)
        let replace = NSRange(location: location, length: min(picked.length, ns.length - location))
        let attributes = ComposerTextField.attributes
        let space = NSAttributedString(string: " ", attributes: attributes)
        func isSpace(_ index: Int) -> Bool {
            guard index >= 0, index < ns.length, let scalar = Unicode.Scalar(ns.character(at: index)) else { return false }
            return CharacterSet.whitespacesAndNewlines.contains(scalar)
        }
        let attachments = urls.map { PictureAttachment(picture: nil, source: $0.path) }
        let piece = NSMutableAttributedString()
        if location > 0, !isSpace(location - 1) { piece.append(space) }
        for (i, attachment) in attachments.enumerated() {
            if i > 0 { piece.append(space) }
            piece.append(chip(attachment))
        }
        if !isSpace(NSMaxRange(replace)) { piece.append(space) }
        guard shouldChangeText(in: replace, replacementString: piece.string) else { return }
        storage.replaceCharacters(in: replace, with: piece)
        didChangeText()
        setSelectedRange(NSRange(location: location + piece.length, length: 0))
        window?.makeFirstResponder(self)
        for (attachment, url) in zip(attachments, urls) {
            Task { @MainActor [weak self] in
                let ref = await pictures.importOne(url)
                self?.settle(attachment, ref)
            }
        }
    }

    /// A chip's picture is in (or couldn't be read). Gone from the words
    /// by then (undone, deleted, or the box shows another draft now), it's
    /// dropped.
    private func settle(_ attachment: PictureAttachment, _ picture: ImageRef?) {
        guard window != nil, let storage = textStorage, let range = range(of: attachment) else { return }
        if let picture {
            attachment.picture = picture
            needsDisplay = true
            // The draft takes it now.
            didChangeText()
        } else {
            let gone = withSpace(range)
            guard shouldChangeText(in: gone, replacementString: "") else { return }
            storage.replaceCharacters(in: gone, with: "")
            didChangeText()
        }
    }

    /// A chip's range and one space beside it (after, or else before), so
    /// taking it out doesn't leave two.
    private func withSpace(_ range: NSRange) -> NSRange {
        let ns = string as NSString
        if NSMaxRange(range) < ns.length, ns.character(at: NSMaxRange(range)) == 0x20 {
            return NSRange(location: range.location, length: range.length + 1)
        }
        if range.location > 0, ns.character(at: range.location - 1) == 0x20 {
            return NSRange(location: range.location - 1, length: range.length + 1)
        }
        return range
    }

    private func range(of attachment: PictureAttachment) -> NSRange? {
        var found: NSRange?
        textStorage?.enumerateAttribute(.attachment, in: whole) { value, range, stop in
            if (value as? PictureAttachment) === attachment {
                found = NSRange(location: range.location, length: 1)
                stop.pointee = true
            }
        }
        return found
    }

    /// Takes out the `index`-th picture that's in (the strip's order) and
    /// a space beside it, as one undo step. False when there's no such chip.
    func removePicture(at index: Int) -> Bool {
        guard let storage = textStorage else { return false }
        var found: NSRange?
        var seen = 0
        storage.enumerateAttribute(.attachment, in: whole) { value, range, stop in
            guard (value as? PictureAttachment)?.picture != nil else { return }
            if seen == index {
                found = NSRange(location: range.location, length: 1)
                stop.pointee = true
            }
            seen += 1
        }
        guard let found else { return false }
        let range = withSpace(found)
        guard shouldChangeText(in: range, replacementString: "") else { return false }
        storage.replaceCharacters(in: range, with: "")
        didChangeText()
        return true
    }

    /// Each chip's number is its place among the box's pictures, so the
    /// chips read 1, 2, 3 left to right whatever was added or taken out.
    func renumberPictures() {
        guard let storage = textStorage, let layoutManager else { return }
        var number = 0
        storage.enumerateAttribute(.attachment, in: whole) { value, range, _ in
            guard let attachment = value as? PictureAttachment else { return }
            number += 1
            guard attachment.number != number else { return }
            attachment.number = number
            // Picture 10 is wider than Picture 9.
            layoutManager.invalidateLayout(forCharacterRange: range, actualCharacterRange: nil)
            layoutManager.invalidateDisplay(forCharacterRange: range)
        }
    }

    // Copy and cut carry the chips' pictures; anywhere else they read as
    // the markers the agent would get.

    override func writeSelection(to pboard: NSPasteboard, types: [NSPasteboard.PasteboardType]) -> Bool {
        let selected = draft(in: selectedRange())
        // Cards alone copy as their links, not as the attachment's character.
        if selected.images.isEmpty, hasCard(in: selectedRange()) {
            pboard.declareTypes([.string], owner: nil)
            return pboard.setString(selected.text, forType: .string)
        }
        guard !selected.images.isEmpty, let data = try? JSONEncoder().encode(Clip(text: selected.text, images: selected.images)) else {
            return super.writeSelection(to: pboard, types: types)
        }
        pboard.declareTypes([Self.clipType, .string], owner: nil)
        pboard.setData(data, forType: Self.clipType)
        return pboard.setString(InlinePictures.messageText(selected.text), forType: .string)
    }

    private func hasCard(in range: NSRange) -> Bool {
        guard let storage = textStorage, range.length > 0, NSMaxRange(range) <= storage.length else { return false }
        var found = false
        storage.enumerateAttribute(.attachment, in: range) { value, _, stop in
            if value is CardAttachment {
                found = true
                stop.pointee = true
            }
        }
        return found
    }

    override var readablePasteboardTypes: [NSPasteboard.PasteboardType] {
        pictures == nil ? super.readablePasteboardTypes : [Self.clipType] + super.readablePasteboardTypes
    }

    override func preferredPasteboardType(from availableTypes: [NSPasteboard.PasteboardType], restrictedToTypesFrom allowedTypes: [NSPasteboard.PasteboardType]?) -> NSPasteboard.PasteboardType? {
        if pictures != nil, availableTypes.contains(Self.clipType), allowedTypes?.contains(Self.clipType) ?? true { return Self.clipType }
        return super.preferredPasteboardType(from: availableTypes, restrictedToTypesFrom: allowedTypes)
    }

    /// A paste that's only a known thread's id (or link), as the link that
    /// draws as its chip. Any other id pastes as words.
    private static func threadReference(_ pasted: String) -> String? {
        let threads = MainActor.assumeIsolated { AppModel.shared.threads }
        guard let id = CardMentions.pastedThreadId(pasted, known: { threads[$0] != nil }) else { return nil }
        return CardMentions.threadReference(id: id, title: threads[id]?.title ?? "")
    }

    private static func isPlainText(_ type: NSPasteboard.PasteboardType) -> Bool {
        type == .string || type.rawValue == "NSStringPboardType"
    }

    override func readSelection(from pboard: NSPasteboard, type: NSPasteboard.PasteboardType) -> Bool {
        // A card's link pasted back (or from a message) is a chip again, and
        // so is a thread's id from "Copy thread id" (Mike asked 5 Nov): it
        // goes in as a thread: link with the thread's title.
        // A real ⌘V asks for the old name of plain text, NSStringPboardType,
        // not `.string`: checking for `.string` alone missed every paste
        // (5 Nov).
        if Self.isPlainText(type), var words = pboard.string(forType: .string), let storage = textStorage,
           !CardMentions.find(in: words).isEmpty || Self.threadReference(words) != nil {
            if let reference = Self.threadReference(words) { words = reference }
            let piece = chips(for: Draft(text: InlinePictures.words(words)))
            let replace = rangeForUserTextChange
            guard replace.location != NSNotFound, shouldChangeText(in: replace, replacementString: piece.string) else { return false }
            storage.replaceCharacters(in: replace, with: piece)
            didChangeText()
            setSelectedRange(NSRange(location: replace.location + piece.length, length: 0))
            return true
        }
        guard type == Self.clipType, pictures != nil, let storage = textStorage,
              let data = pboard.data(forType: type), let clip = try? JSONDecoder().decode(Clip.self, from: data) else {
            return super.readSelection(from: pboard, type: type)
        }
        let piece = chips(for: Draft(text: clip.text, images: clip.images))
        let replace = rangeForUserTextChange
        guard replace.location != NSNotFound, shouldChangeText(in: replace, replacementString: piece.string) else { return false }
        storage.replaceCharacters(in: replace, with: piece)
        didChangeText()
        setSelectedRange(NSRange(location: replace.location + piece.length, length: 0))
        return true
    }
}
