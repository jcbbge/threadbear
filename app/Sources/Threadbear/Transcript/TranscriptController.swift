import AppKit
import UniformTypeIdentifiers
import Quartz
import BearDock
import SwiftUI
import ThreadbearCore

/// The transcript table. Owns Quick Look control for image clicks and the
/// row context menu.
final class TranscriptTableView: NSTableView {
    weak var controller: TranscriptController?

    override func menu(for event: NSEvent) -> NSMenu? {
        let point = convert(event.locationInWindow, from: nil)
        return controller?.menu(forRow: row(at: point))
    }

    override func acceptsPreviewPanelControl(_ panel: QLPreviewPanel!) -> Bool { true }
    override func beginPreviewPanelControl(_ panel: QLPreviewPanel!) { QuickLookCoordinator.shared.begin(panel) }
    override func endPreviewPanelControl(_ panel: QLPreviewPanel!) { QuickLookCoordinator.shared.end(panel) }

    override func validateProposedFirstResponder(_ responder: NSResponder, for event: NSEvent?) -> Bool {
        // Let text views inside rows take focus for selection.
        true
    }
}

/// Where a thread was scrolled to, so switching back restores it.
struct ScrollMemory {
    var pinned: Bool
    var anchorId: String?
    var offset: CGFloat
}

/// Drives the `NSTableView` from a `ThreadSession`: row inserts and reloads,
/// never full reloads for live updates; cached heights; bottom pinning; and
/// keeping the visible row anchored when older rows are paged in.
@MainActor
final class TranscriptController: NSObject, NSTableViewDataSource, NSTableViewDelegate, RowCellDelegate {
    var remoteImages: RemoteImages? {
        guard let session, let app = session.app, let thread = app.threads[session.threadId] else { return nil }
        return app.remoteImages(for: thread)
    }

    var linkThreadId: String? { session?.threadId }

    /// Pictures in the words are read from this Mac only for this Mac's
    /// own thread (MarkdownRenderer.localPictures). A thread the app
    /// doesn't list as another runner's is this Mac's: its events come
    /// from this Mac's runner.
    var localPictures: Bool {
        guard let session, let app = session.app else { return true }
        return !app.isRemote(session.threadId)
    }

    nonisolated static let renders = RenderCache()

    /// Overlay scrollers whatever the system setting, so the reading
    /// column and the composer under it are centred in the pane.
    let scrollView: NSScrollView = OverlayScrollView()
    let tableView = TranscriptTableView()
    /// The open card, drawn at the top of the composer.
    weak var composerCard: ComposerCardHost?
    /// The box drops on this transcript go to (ComposerDropView).
    weak var composerHandle: ComposerHandle?
    private(set) weak var session: ThreadSession?
    /// The last message that rose: a batch that moves it doesn't lift it
    /// again, and the real row that replaces it carries on from here.
    private var lifting: (rowId: String, text: String, begun: CFTimeInterval)?
    private(set) var width: CGFloat = 0
    private var deferred = Set<String>()
    private var deferredTimer: Timer?
    private var questionDrafts: [String: [Int: Set<String>]] = [:]
    /// Each secret card's answer on its way, or why it failed. Never the
    /// value: that's only ever in the card's field and the one request.
    private var secretStates: [String: SecretCardState] = [:]
    /// Set by perf runs: called after older rows are added at the top.
    var onPrepend: (() -> Void)?
    /// Pause paging (perf runs drive it themselves at times).
    var pagingEnabled = true
    /// After a width change on a long thread only the rows near the screen
    /// are re-measured at once; this re-measures the rest off the main thread
    /// once the resizing stops.
    private var remeasureTask: Task<Void, Never>?
    /// Up to this many rows are re-measured straight away on a width change.
    static let syncRemeasureLimit = 400
    /// The clip view's height at the last frame change, to tell whether the
    /// view was at the bottom before it got shorter.
    private var lastClipHeight: CGFloat = 0

    override init() {
        super.init()
        let column = NSTableColumn(identifier: NSUserInterfaceItemIdentifier("row"))
        column.resizingMask = .autoresizingMask
        tableView.addTableColumn(column)
        tableView.headerView = nil
        tableView.style = .plain
        tableView.intercellSpacing = .zero
        tableView.selectionHighlightStyle = .none
        tableView.backgroundColor = .clear
        tableView.gridStyleMask = []
        tableView.columnAutoresizingStyle = .firstColumnOnlyAutoresizingStyle
        tableView.usesAutomaticRowHeights = false
        tableView.allowsColumnReordering = false
        tableView.focusRingType = .none
        tableView.dataSource = self
        tableView.delegate = self
        tableView.controller = self

        scrollView.documentView = tableView
        scrollView.drawsBackground = false
        scrollView.hasVerticalScroller = true
        scrollView.autohidesScrollers = true
        scrollView.scrollerStyle = .overlay
        scrollView.automaticallyAdjustsContentInsets = false
        // Room below the last row for the bottom fade, so a thread pinned to
        // the bottom shows its last row whole. At the top, every row starts
        // with at least 5 pt of its own padding, so 10 here keeps a thread
        // scrolled to its top clear of the top fade.
        applyInsets()
        scrollView.wantsLayer = true
        scrollView.contentView.postsBoundsChangedNotifications = true
        scrollView.contentView.postsFrameChangedNotifications = true
        NotificationCenter.default.addObserver(self, selector: #selector(boundsChanged), name: NSView.boundsDidChangeNotification, object: scrollView.contentView)
        NotificationCenter.default.addObserver(self, selector: #selector(frameChanged), name: NSView.frameDidChangeNotification, object: scrollView.contentView)
        NotificationCenter.default.addObserver(self, selector: #selector(zoomChanged), name: TextZoom.didChange, object: nil)
        NotificationCenter.default.addObserver(self, selector: #selector(richChanged), name: RichBlocks.changed, object: nil)
        NotificationCenter.default.addObserver(self, selector: #selector(buttonsChanged), name: ReplyButtons.changed, object: nil)
    }

    /// A ```mermaid or ```html box was drawn, or flipped between its
    /// picture and its source: the replies holding one render again (their
    /// render keys changed), keeping what's on screen where it is. Several
    /// finishing together are done once.
    private var richPending = false
    @objc private func richChanged() {
        guard !richPending else { return }
        richPending = true
        rerender { [weak self] in self?.richPending = false } where: { RenderCache.holdsRich($0) }
    }

    /// A reply button was made, pressed or failed, or a press set off or
    /// came back (ReplyButtons): the replies linking one draw again, as
    /// for rich blocks. Several together are done once.
    private var buttonsPending = false
    @objc private func buttonsChanged() {
        guard !buttonsPending else { return }
        buttonsPending = true
        rerender { [weak self] in self?.buttonsPending = false } where: { RenderCache.holdsButtons($0) }
    }

    /// Renders the rows `holds` picks again on the next turn of the main
    /// loop, keeping what's on screen where it is.
    private func rerender(_ done: @escaping @MainActor () -> Void, where holds: @escaping (TranscriptRow) -> Bool) {
        DispatchQueue.main.async { [weak self] in
            MainActor.assumeIsolated {
                done()
                guard let self else { return }
                guard let session = self.session else { return }
                let indices = IndexSet((0..<session.displayCount).filter { holds(session.displayRow($0)) })
                guard !indices.isEmpty else { return }
                let wasPinned = self.isAtBottom
                let anchor = wasPinned ? nil : self.captureMemory()
                NSAnimationContext.beginGrouping()
                NSAnimationContext.current.duration = 0
                for index in indices {
                    if let row = self.row(at: index) { self.refreshCell(at: index, row: row) }
                }
                self.tableView.noteHeightOfRows(withIndexesChanged: indices)
                NSAnimationContext.endGrouping()
                if wasPinned {
                    self.scrollToBottom()
                } else if let anchor, let id = anchor.anchorId, let index = session.displayIndex(of: id) {
                    self.scroll(toRow: index, offset: anchor.offset)
                }
            }
        }
    }

    // MARK: Edge fades

    /// The transcript ends a few points above the composer card and starts
    /// right under the header. Cut off there, lines were sliced through
    /// their letters and images got a hard edge, which read as a drawing
    /// glitch. A static mask fades both ends out instead, as Codex and
    /// Claude do; it only changes when the view is resized.
    /// Tall enough that a bright image passing under the composer fades
    /// out rather than turning into a grey strip with its corners floating
    /// above the card (Codex fades over about 40 pt).
    static var fadeHeight: CGFloat { zoomed(36) }
    static var topFadeHeight: CGFloat { zoomed(14) }
    private let fadeMask = CALayer()
    private let fadeGradient = CAGradientLayer()
    private let fadeScroller = CALayer()

    /// Set again on a zoom change: the composer card the bottom inset
    /// clears grows with everything else.
    private func applyInsets() {
        scrollView.contentInsets = NSEdgeInsets(top: zoomed(10), left: 0, bottom: Self.fadeHeight + zoomed(4), right: 0)
    }

    private func updateFade() {
        guard let layer = scrollView.layer else { return }
        if layer.mask !== fadeMask {
            // The bottom eases out: most of the fall happens early, so the
            // last few points above the composer are nearly clear.
            fadeGradient.colors = [NSColor.clear.cgColor, NSColor.black.cgColor, NSColor.black.cgColor,
                                   NSColor.black.withAlphaComponent(0.35).cgColor, NSColor.clear.cgColor]
            fadeScroller.backgroundColor = NSColor.black.cgColor
            fadeMask.addSublayer(fadeGradient)
            fadeMask.addSublayer(fadeScroller)
            layer.mask = fadeMask
        }
        let bounds = scrollView.bounds
        guard bounds.height > 0 else { return }
        // The scroller strip on the right stays whole; only the text fades.
        // AppKit's scroller, so its width doesn't follow the zoom.
        let scroller: CGFloat = 16
        let top = max(0, min(0.5, Self.topFadeHeight / bounds.height))
        let bottom = max(0, min(0.5, Self.fadeHeight / bounds.height))
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        fadeMask.frame = bounds
        fadeGradient.frame = NSRect(x: 0, y: 0, width: max(0, bounds.width - scroller), height: bounds.height)
        fadeScroller.frame = NSRect(x: max(0, bounds.width - scroller), y: 0, width: scroller, height: bounds.height)
        // Layer y runs up from the bottom here (the scroll view isn't flipped).
        let flipped = layer.isGeometryFlipped
        fadeGradient.startPoint = CGPoint(x: 0.5, y: flipped ? 0 : 1)
        fadeGradient.endPoint = CGPoint(x: 0.5, y: flipped ? 1 : 0)
        fadeGradient.locations = [0, NSNumber(value: Double(top)), NSNumber(value: Double(1 - bottom)),
                                  NSNumber(value: Double(1 - bottom * 0.35)), 1]
        CATransaction.commit()
    }

    // MARK: Showing a session

    func show(_ newSession: ThreadSession?) {
        if newSession === session {
            return
        }
        let previous = session
        if let previous { previous.scrollMemory = captureMemory() }
        previous?.view = nil
        if previous?.scrollMemory?.pinned == true { previous?.trimToNewest() }
        session = newSession
        newSession?.view = self
        questionDrafts = [:]
        secretStates = [:]
        deferred = []
        remeasureTask?.cancel()
        width = currentTableWidth
        updateFade()
        reloadAll()
    }

    /// The width rows are laid out at: the whole scroll view, whose
    /// scroller is always an overlay. (With legacy scrollers it came and
    /// went as threads got long or short, and every switch laid rows out
    /// twice.)
    var currentTableWidth: CGFloat {
        max(320, scrollView.frame.width)
    }

    /// Full reload: only used when switching threads or after a fresh load.
    func reloadAll() {
        let memory = session?.scrollMemory
        tableView.reloadData()
        tableView.layoutSubtreeIfNeeded()
        if let memory, !memory.pinned, let id = memory.anchorId, let index = session?.displayIndex(of: id) {
            scroll(toRow: index, offset: memory.offset)
        } else {
            scrollToBottom()
        }
        // Evidence for the blank transcript Mike has seen twice and no debug
        // copy reproduces: what the view had when a thread was drawn afresh.
        if let session {
            let clip = scrollView.contentView.bounds
            let visible = scrollView.window?.occlusionState.contains(.visible) ?? false
            AppLog.write("transcript", "showing \(session.threadId): \(rowCount) rows, \(session.state), width \(Int(width)), clip \(Int(clip.minY))+\(Int(clip.height)) of \(Int(tableView.frame.height)), window \(scrollView.window == nil ? "none" : visible ? "visible" : "hidden")")
        }
        // Paging older rows in is driven by the scroll position changing,
        // and a first page shorter than the view can't scroll, so it never
        // changed. A long last turn's newest 500 events fold into one
        // "Worked for" row, and the thread looked as if it began halfway
        // down with no way up (Mike, 5 Nov). Ask here too, after a fresh
        // load and when an already loaded thread is shown again.
        loadOlderIfNearTop()
    }

    var rowCount: Int { session?.displayCount ?? 0 }

    func row(at index: Int) -> TranscriptRow? {
        guard let session, index >= 0, index < session.displayCount else { return nil }
        return session.displayRow(index)
    }

    func render(_ row: TranscriptRow) -> RowRender {
        // Only diff rows have more lines to show; skipping the lookup keeps
        // a full reload's height pass free of a string per row.
        let showAll = row.kind == .diff && session?.expanded.contains(DiffPreview.allKey(row.id)) == true
        return Self.renders.render(row, expanded: isExpanded(row), showAll: showAll, width: width, localPictures: localPictures)
    }

    /// Item rows keep their open state in the session; groups and changes
    /// cards carry theirs in the row.
    func isExpanded(_ row: TranscriptRow) -> Bool {
        RenderCache.effectiveExpanded(row, session?.expanded.contains(row.id) == true)
    }

    // MARK: Data source and delegate

    func numberOfRows(in tableView: NSTableView) -> Int { rowCount }

    func tableView(_ tableView: NSTableView, heightOfRow index: Int) -> CGFloat {
        guard let row = row(at: index) else { return 1 }
        return max(1, render(row).height)
    }

    func tableView(_ tableView: NSTableView, viewFor tableColumn: NSTableColumn?, row index: Int) -> NSView? {
        guard let row = row(at: index) else { return nil }
        let cell = makeCell(for: row)
        cell.delegate = self
        cell.configure(row: row, render: render(row), tableWidth: width, expanded: isExpanded(row))
        return cell
    }

    func tableView(_ tableView: NSTableView, shouldSelectRow row: Int) -> Bool { false }

    func claimWakeUp(rowId: String) -> Bool {
        guard let session, session.wakeUpPending else { return false }
        // An older thread's older wake note can come on screen first.
        let newest = (0..<session.displayCount).reversed().lazy.map { session.displayRow($0) }.first { $0.content.isWakeNote }
        guard newest?.id == rowId else { return false }
        session.wakeUpPending = false
        return true
    }

    func tableView(_ tableView: NSTableView, didRemove rowView: NSTableRowView, forRow row: Int) {
        for case let cell as RowCellView in rowView.subviews { cell.releaseContent() }
    }

    func tableView(_ tableView: NSTableView, didAdd rowView: NSTableRowView, forRow row: Int) {
        // Placed in the table now, so it knows which part of it is on screen.
        for case let cell as RowCellView in rowView.subviews { cell.updateSlices(force: true) }
    }

    static func cellIdentifier(for row: TranscriptRow) -> String {
        switch row.kind {
        case .user, .assistant, .plan, .asks, .error, .footer: return "text"
        // A system note folded into an open group reads as one of its lines.
        case .note: return row.inGroup ? "header" : "text"
        case .reasoning, .tool, .diff: return "header"
        case .images: return "images"
        // Once answered, an approval is one work line (and can sit in a group).
        case .approval:
            if case .approval(let item) = row.content, item.resolution != nil { return "header" }
            return "approval"
        case .question: return "question"
        // Once settled, a secret card is one work line too.
        case .secret:
            if case .secret(let item) = row.content, item.resolution != nil { return "header" }
            return "secret"
        case .review: return "review"
        case .group: return "group"
        case .working: return "working"
        case .background: return "background"
        case .gap: return "gap"
        case .changes: return "changes"
        case .planCard: return "planCard"
        }
    }

    private func makeCell(for row: TranscriptRow) -> RowCellView {
        let identifier = Self.cellIdentifier(for: row)
        let id = NSUserInterfaceItemIdentifier(identifier)
        if let reused = tableView.makeView(withIdentifier: id, owner: nil) as? RowCellView { return reused }
        let cell: RowCellView
        switch identifier {
        case "text": cell = TextRowCell(frame: .zero)
        case "header": cell = HeaderRowCell(frame: .zero)
        case "images": cell = ImagesRowCell(frame: .zero)
        case "approval": cell = ApprovalRowCell(frame: .zero)
        case "secret": cell = SecretRowCell(frame: .zero)
        case "review": cell = ReviewRowCell(frame: .zero)
        case "group": cell = GroupRowCell(frame: .zero)
        case "working": cell = WorkingRowCell(frame: .zero)
        case "background": cell = BackgroundRowCell(frame: .zero)
        case "gap": cell = GapRowCell(frame: .zero)
        case "changes": cell = ChangesRowCell(frame: .zero)
        case "planCard": cell = PlanCardCell(frame: .zero)
        default: cell = QuestionRowCell(frame: .zero)
        }
        cell.identifier = id
        return cell
    }

    // MARK: Live updates

    /// Applies a batch from the session. Indices are in display space:
    /// `removed` in the rows before the change, the others after it.
    func apply(removed: IndexSet = [], inserted: IndexSet, updated: IndexSet) {
        guard session != nil else { return }
        let wasPinned = isAtBottom
        let anchor = wasPinned ? nil : captureMemory()
        let visible = tableView.rows(in: tableView.visibleRect)
        let visibleRange = visible.location..<(visible.location + visible.length + 1)

        NSAnimationContext.beginGrouping()
        NSAnimationContext.current.duration = 0
        // NSTableView applies these in order, each against the rows as they
        // are after the one before: removals at old indices, then inserts
        // at new ones.
        if !removed.isEmpty {
            tableView.removeRows(at: removed, withAnimation: [])
        }
        if !inserted.isEmpty {
            tableView.insertRows(at: inserted, withAnimation: [])
        }
        var changed = IndexSet()
        for index in updated {
            guard let row = row(at: index) else { continue }
            // Off-screen streaming rows are re-measured a few times a second,
            // not on every delta.
            if !visibleRange.contains(index), isStreaming(row), !wasPinned {
                deferred.insert(row.id)
                continue
            }
            deferred.remove(row.id)
            changed.insert(index)
            refreshCell(at: index, row: row)
        }
        if !changed.isEmpty {
            tableView.noteHeightOfRows(withIndexesChanged: changed)
        }
        NSAnimationContext.endGrouping()

        if !deferred.isEmpty { scheduleDeferred() }
        if wasPinned {
            scrollToBottom()
        } else if let anchor, let id = anchor.anchorId, let index = session?.displayIndex(of: id) {
            // Rows above the anchor can change height (a tool result landing);
            // keep what the user is reading where it was.
            scroll(toRow: index, offset: anchor.offset)
        }
        if wasPinned { liftSent(inserted) }
    }

    /// A message Mike's just sent rises the last of the way from the
    /// composer's edge (`SendLift`), rather than appearing above it. Only
    /// when the table was at the bottom, where it's seen and where it isn't
    /// about to be scrolled to. Goes on the cell's layer once, so the render
    /// server runs it, and never touches the scroll: that's already pinned.
    ///
    /// A runner that answers quickly replaces the faded row with the real
    /// one while it's still rising, often in the same frame, in a cell of
    /// its own. That cell picks the rise up from where it had got to, or a
    /// quick runner would mean no lift at all.
    private func liftSent(_ inserted: IndexSet) {
        for index in inserted {
            guard let row = row(at: index), case .user(let message) = row.content else { continue }
            let begun: CFTimeInterval?
            if SendLift.rises(row), row.id != lifting?.rowId {
                begun = nil
                lifting = (row.id, message.text, CACurrentMediaTime())
            } else if message.pending == nil, let lifting, lifting.text == message.text, CACurrentMediaTime() - lifting.begun < SendLift.firstFrame + SendLift.duration {
                begun = lifting.begun
            } else {
                continue
            }
            guard let cell = tableView.view(atColumn: 0, row: index, makeIfNecessary: true) else { continue }
            SendLift.lift(cell, begun: begun)
        }
    }

    private func isStreaming(_ row: TranscriptRow) -> Bool {
        switch row.content {
        case .assistant(let item), .reasoning(let item): return item.isStreaming
        default: return false
        }
    }

    private func refreshCell(at index: Int, row: TranscriptRow) {
        guard let cell = tableView.view(atColumn: 0, row: index, makeIfNecessary: false) as? RowCellView else { return }
        if cell.identifier?.rawValue != Self.cellIdentifier(for: row) {
            // The row needs another kind of cell now (a note moving into an
            // open group): let the table make it.
            tableView.reloadData(forRowIndexes: [index], columnIndexes: [0])
            return
        }
        cell.configure(row: row, render: render(row), tableWidth: width, expanded: isExpanded(row))
    }

    private func scheduleDeferred() {
        guard deferredTimer == nil else { return }
        deferredTimer = Timer.scheduledTimer(withTimeInterval: 0.25, repeats: false) { [weak self] _ in
            MainActor.assumeIsolated {
                guard let self else { return }
                self.deferredTimer = nil
                self.flushDeferred()
            }
        }
    }

    private func flushDeferred() {
        guard let session, !deferred.isEmpty else { return }
        let indices = IndexSet(deferred.compactMap { session.displayIndex(of: $0) })
        deferred = []
        let wasPinned = isAtBottom
        let anchor = wasPinned ? nil : captureMemory()
        NSAnimationContext.beginGrouping()
        NSAnimationContext.current.duration = 0
        for index in indices {
            if let row = row(at: index) { refreshCell(at: index, row: row) }
        }
        tableView.noteHeightOfRows(withIndexesChanged: indices)
        NSAnimationContext.endGrouping()
        if wasPinned {
            scrollToBottom()
        } else if let anchor, let id = anchor.anchorId, let index = session.displayIndex(of: id) {
            scroll(toRow: index, offset: anchor.offset)
        }
    }

    /// Older rows were added above. Keeps the row that was at the top of the
    /// screen where it was. `memory` must be captured before the session's
    /// rows or `displayStart` changed.
    func insertAtTop(count: Int, changedIds: [String], memory: ScrollMemory?) {
        guard count > 0 || !changedIds.isEmpty, let session else { return }
        NSAnimationContext.beginGrouping()
        NSAnimationContext.current.duration = 0
        if count > 0 {
            tableView.insertRows(at: IndexSet(integersIn: 0..<count), withAnimation: [])
        }
        let changed = IndexSet(changedIds.compactMap { session.displayIndex(of: $0) })
        for index in changed {
            if let row = row(at: index) { refreshCell(at: index, row: row) }
        }
        if !changed.isEmpty { tableView.noteHeightOfRows(withIndexesChanged: changed) }
        NSAnimationContext.endGrouping()
        restore(memory)
        onPrepend?()
    }

    /// Reloads every row and puts the anchored row back where it was. Used
    /// when paging changed the order of rows the table already had.
    func reload(keeping memory: ScrollMemory?) {
        tableView.reloadData()
        restore(memory)
        onPrepend?()
    }

    private func restore(_ memory: ScrollMemory?) {
        guard let memory, let session else { return }
        if memory.pinned {
            scrollToBottom()
        } else if let id = memory.anchorId, let index = session.displayIndex(of: id) {
            scroll(toRow: index, offset: memory.offset)
        }
    }

    func toggleExpanded(rowId: String) {
        guard let session, let index = session.displayIndex(of: rowId), let row = row(at: index) else { return }
        if case .group(let group) = row.content {
            // Opening a group inserts its items under it and closing removes
            // them; `apply` keeps what's on screen where it is.
            session.setModelExpanded(rowId, !group.isExpanded)
            return
        }
        // Opening another runner's tool asks for its output, which fills in the row
        // as more events if that runner has full sync on.
        if !session.expanded.contains(rowId), case .tool(let tool) = row.content, let seq = tool.result?.heldBackSeq {
            session.app?.fetchHeldBody(threadId: session.threadId, seq: seq)
        }
        DiffPreview.set(rowId, open: !session.expanded.contains(rowId), in: &session.expanded)
        refreshInPlace(index: index, row: row)
    }

    /// A review: link opens that review's window, as its card does.
    private func openReviewLink(_ url: URL) {
        guard let session, let id = WorkLinks.reviewId(of: url), let review = WorkLinks.review(id, in: session.model.items) else {
            AppLog.write("transcript", "review link \(url.absoluteString): no such review")
            NSSound.beep()
            return
        }
        openReview(review)
    }

    /// A work: link opens the turn's working at the step it quotes and
    /// lights it up; a thread: link opens that thread; a review: link that
    /// review (WorkLinks).
    func openThreadLink(_ url: URL, fromRow rowId: String) {
        guard let session else { return }
        if WorkLinks.reviewId(of: url) != nil { return openReviewLink(url) }
        if let id = WorkLinks.threadId(of: url)?.lowercased() {
            let app = AppModel.shared
            let matches = app.threads.keys.filter { $0 == id || $0.hasPrefix(id) }
            if matches.count == 1 { app.openThread(matches[0]); return }
            // A beep alone left Mike clicking a link to a thread archived on bruce
            // (another machine's archived threads aren't listed here) and
            // wondering why nothing opened (6 Nov): say why.
            AppLog.write("transcript", "thread link \(url.absoluteString): \(matches.count) matches")
            NSSound.beep()
            app.errorMessage = matches.isEmpty
                ? "That thread isn't in your sidebar, so it can't open here. It was deleted, or it's archived on another machine, and those aren't listed on this Mac."
                : "That link matches \(matches.count) threads, so none was opened."
            return
        }
        guard let quote = WorkLinks.quote(of: url), let index = session.displayIndex(of: rowId), let turn = row(at: index)?.turnId,
              let step = session.feed.model.workStep(quote, turn: turn) else {
            AppLog.write("transcript", "work link \(url.absoluteString) in \(rowId): no step")
            NSSound.beep()
            return
        }
        AppLog.write("transcript", "work link \(url.absoluteString) in \(rowId): \(step.rowId) in \(step.groupId ?? "no group")")
        if let group = step.groupId, let groupIndex = session.displayIndex(of: group), case .group(let g)? = row(at: groupIndex)?.content, !g.isExpanded {
            session.setModelExpanded(group, true)
        }
        // After the table has laid out the opened group's rows.
        DispatchQueue.main.async { [weak self] in
            guard let self, let index = self.session?.displayIndex(of: step.rowId) else { return }
            self.scroll(toRow: index, offset: self.scrollView.contentView.bounds.height / 3)
            self.light(row: index)
        }
    }

    /// Lights a row up for a moment: an accent rail and a tint, fading out,
    /// so the eye lands on the step a summary bullet is about.
    private func light(row index: Int) {
        guard let cell = tableView.view(atColumn: 0, row: index, makeIfNecessary: false) else { return }
        cell.wantsLayer = true
        let glow = CALayer()
        glow.frame = cell.bounds.insetBy(dx: 4, dy: 0)
        glow.cornerRadius = 6
        glow.backgroundColor = NSColor.controlAccentColor.withAlphaComponent(0.24).cgColor
        let rail = CALayer()
        rail.frame = NSRect(x: 0, y: 0, width: 3, height: glow.frame.height)
        rail.backgroundColor = NSColor.controlAccentColor.cgColor
        glow.addSublayer(rail)
        cell.layer?.insertSublayer(glow, at: 0)
        let fade = CABasicAnimation(keyPath: "opacity")
        fade.fromValue = 1
        fade.toValue = 0
        fade.beginTime = CACurrentMediaTime() + 2.5
        fade.duration = 0.8
        fade.fillMode = .forwards
        fade.isRemovedOnCompletion = false
        glow.add(fade, forKey: "fade")
        DispatchQueue.main.asyncAfter(deadline: .now() + 3.4) { glow.removeFromSuperlayer() }
    }

    /// "Show 30 more lines" under an opened diff. A changes card's file is
    /// the model's to open; a tool row's lines are this view's.
    func showAllLines(_ key: String) {
        guard let session else { return }
        if key.hasPrefix("cf:") {
            session.setModelExpanded(key, true)
            return
        }
        let rowId = String(key.dropLast("|all".count))
        guard key == DiffPreview.allKey(rowId), let index = session.displayIndex(of: rowId), let row = row(at: index) else { return }
        DiffPreview.set(key, open: true, in: &session.expanded)
        refreshInPlace(index: index, row: row)
    }

    /// Re-renders one row whose open state changed, keeping what's on
    /// screen where it is.
    private func refreshInPlace(index: Int, row: TranscriptRow) {
        guard let session else { return }
        let memory = captureMemory()
        NSAnimationContext.beginGrouping()
        NSAnimationContext.current.duration = 0
        refreshCell(at: index, row: row)
        tableView.noteHeightOfRows(withIndexesChanged: [index])
        NSAnimationContext.endGrouping()
        if !memory.pinned, let id = memory.anchorId, let anchorIndex = session.displayIndex(of: id), anchorIndex != index {
            scroll(toRow: anchorIndex, offset: memory.offset)
        }
    }

    // MARK: Scrolling

    var isAtBottom: Bool {
        let clip = scrollView.contentView.bounds
        let documentHeight = tableView.frame.height
        return clip.maxY >= documentHeight + scrollView.contentInsets.bottom - 24
    }

    func scrollToBottom() {
        let count = rowCount
        guard count > 0 else { return }
        let bottom = tableView.rect(ofRow: count - 1).maxY + scrollView.contentInsets.bottom
        let y = max(-scrollView.contentInsets.top, bottom - scrollView.contentView.bounds.height)
        scrollView.contentView.scroll(to: NSPoint(x: 0, y: y))
        scrollView.reflectScrolledClipView(scrollView.contentView)
    }

    func scroll(toRow index: Int, offset: CGFloat) {
        let y = tableView.rect(ofRow: index).minY - offset
        scrollView.contentView.scroll(to: NSPoint(x: 0, y: y))
        scrollView.reflectScrolledClipView(scrollView.contentView)
    }

    func captureMemory() -> ScrollMemory {
        if isAtBottom { return ScrollMemory(pinned: true, anchorId: nil, offset: 0) }
        let clip = scrollView.contentView.bounds
        let index = max(0, tableView.row(at: NSPoint(x: 1, y: max(0, clip.minY + 1))))
        guard let row = row(at: index) else { return ScrollMemory(pinned: true, anchorId: nil, offset: 0) }
        return ScrollMemory(pinned: false, anchorId: row.id, offset: tableView.rect(ofRow: index).minY - clip.minY)
    }

    @objc private func boundsChanged() {
        updateVisibleSlices()
        loadOlderIfNearTop()
    }

    /// Tall rows on screen move their drawn slice along as the view scrolls.
    func updateVisibleSlices() {
        let visible = tableView.rows(in: tableView.visibleRect)
        guard visible.length > 0 else { return }
        for index in visible.location..<(visible.location + visible.length) {
            (tableView.view(atColumn: 0, row: index, makeIfNecessary: false) as? RowCellView)?.updateSlices()
        }
    }

    /// Pages older rows in when the view is within a couple of screens of
    /// the top. Also called after a page lands: a view sitting still at the
    /// top sends no bounds change, so it would otherwise wait forever.
    func loadOlderIfNearTop() {
        guard pagingEnabled, let session else { return }
        let clip = scrollView.contentView.bounds
        if clip.minY < clip.height * 2 {
            session.loadOlder()
        }
    }

    @objc private func frameChanged() {
        updateFade()
        // A shorter view (a connection banner appearing, the composer
        // growing with an attachment or a long draft) keeps its top where it
        // was, which hid the newest rows of a thread that was pinned to the
        // bottom. Whether it was pinned is judged by the height it had.
        let clip = scrollView.contentView.bounds
        // A thread shown before its panel was laid out (height 0, as after
        // the app relaunches itself in the background) scrolled to "the
        // bottom" of a zero-height view, which is past the last row; with no
        // earlier height it never counted as pinned, so the transcript
        // stayed blank (Mike, 28 Oct). A view wholly past the end is pinned.
        let pastEnd = rowCount > 0 && clip.minY >= tableView.frame.height
        let wasPinned = pastEnd || lastClipHeight > 0 && abs(clip.height - lastClipHeight) >= 1
            && clip.minY + lastClipHeight >= tableView.frame.height + scrollView.contentInsets.bottom - 24
        lastClipHeight = clip.height
        let newWidth = currentTableWidth
        guard abs(newWidth - width) >= 1, let session else {
            if wasPinned { scrollToBottom() }
            return
        }
        let memory = wasPinned ? ScrollMemory(pinned: true, anchorId: nil, offset: 0) : captureMemory()
        let oldColumn = RowMetrics.column(tableWidth: width).width
        width = newWidth
        let visible = tableView.rows(in: tableView.visibleRect)
        let visibleRange = visible.location..<(visible.location + visible.length)
        NSAnimationContext.beginGrouping()
        NSAnimationContext.current.duration = 0
        if RowMetrics.column(tableWidth: newWidth).width == oldColumn {
            // The reading column only moved sideways (it's at its widest):
            // heights and renders are unchanged, just re-place what's on screen.
            for index in visibleRange {
                if let row = row(at: index) { refreshCell(at: index, row: row) }
            }
            NSAnimationContext.endGrouping()
            if memory.pinned { scrollToBottom() }
            return
        }
        let count = session.displayCount
        let measured: Range<Int>
        if count <= Self.syncRemeasureLimit {
            measured = 0..<count
        } else {
            // A long thread during a live resize (window edge or sidebar):
            // re-measuring all of it on every step blocked the main thread for
            // about 200 ms a step. Measure what's on screen and a margin now,
            // the rest off the main thread once the resizing stops.
            let margin = 60
            measured = max(0, visibleRange.lowerBound - margin)..<min(count, visibleRange.upperBound + margin)
        }
        Self.renders.prepare(measured.map { session.displayRow($0) }, expanded: session.expanded, width: width, localPictures: localPictures)
        tableView.noteHeightOfRows(withIndexesChanged: IndexSet(integersIn: measured))
        for index in visibleRange {
            if let row = row(at: index) { refreshCell(at: index, row: row) }
        }
        NSAnimationContext.endGrouping()
        restore(memory)
        if measured.count < count { scheduleRemeasure() } else { remeasureTask?.cancel() }
    }

    /// ⌘= or ⌘-: every row's height changes, like a column width change,
    /// but as a one-off rather than a live resize. The renders are keyed by
    /// zoom, so nothing cached is reused; the rows near the screen are
    /// re-measured now and the rest off the main thread. A full reload
    /// (rather than re-configuring the cells on screen) drops every cell's
    /// own text layout, which was done at the old sizes.
    @objc private func zoomChanged() {
        applyInsets()
        updateFade()
        guard let session else { return }
        let memory = captureMemory()
        let count = session.displayCount
        let visible = tableView.rows(in: tableView.visibleRect)
        let margin = 60
        let measured = count <= Self.syncRemeasureLimit
            ? 0..<count
            : max(0, visible.location - margin)..<min(count, visible.location + visible.length + margin)
        Self.renders.prepare(measured.map { session.displayRow($0) }, expanded: session.expanded, width: width, localPictures: localPictures)
        NSAnimationContext.beginGrouping()
        NSAnimationContext.current.duration = 0
        tableView.reloadData()
        NSAnimationContext.endGrouping()
        restore(memory)
        if measured.count < count { scheduleRemeasure() } else { remeasureTask?.cancel() }
    }

    private func scheduleRemeasure() {
        remeasureTask?.cancel()
        remeasureTask = Task { [weak self] in
            try? await Task.sleep(for: .milliseconds(200))
            guard let self, !Task.isCancelled, let session = self.session else { return }
            let width = self.width
            let zoom = TypeScale.percent
            let rows = (0..<session.displayCount).map { session.displayRow($0) }
            let expanded = session.expanded
            let localPictures = self.localPictures
            await Task.detached(priority: .userInitiated) {
                TranscriptController.renders.prepare(rows, expanded: expanded, width: width, localPictures: localPictures)
            }.value
            guard !Task.isCancelled, self.session === session, self.width == width, TypeScale.percent == zoom else { return }
            let memory = self.captureMemory()
            NSAnimationContext.beginGrouping()
            NSAnimationContext.current.duration = 0
            self.tableView.noteHeightOfRows(withIndexesChanged: IndexSet(integersIn: 0..<self.rowCount))
            NSAnimationContext.endGrouping()
            self.restore(memory)
        }
    }

    // MARK: Menu and actions

    func menu(forRow index: Int) -> NSMenu? {
        let menu = NSMenu()
        let row = row(at: index)
        if let row, MarkdownExport.message(for: row) != nil {
            let copy = NSMenuItem(title: "Copy message", symbol: "doc.on.doc", action: #selector(copyMessage(_:)), target: self)
            copy.representedObject = row.id
            menu.addItem(copy)
            if [.tool, .reasoning, .diff, .group].contains(row.kind) {
                let expanded = isExpanded(row)
                let toggle = NSMenuItem(title: expanded ? "Collapse" : "Expand", symbol: expanded ? "chevron.up" : "chevron.down",
                                        action: #selector(toggleFromMenu(_:)), target: self)
                toggle.representedObject = row.id
                menu.addItem(toggle)
            }
        }
        let transcript = NSMenuItem(title: "Copy transcript as Markdown", symbol: "doc.plaintext", action: #selector(copyTranscript), target: self)
        menu.addItem(transcript)
        if let row {
            // What an agent needs to find this row again (the thread, the
            // row, the events behind it), so Mike can point at it.
            menu.addItem(.separator())
            let debug = NSMenuItem(title: "Copy debug info", symbol: "ladybug", action: #selector(copyDebugInfo(_:)), target: self)
            debug.representedObject = row.id
            menu.addItem(debug)
        }
        return menu
    }

    @objc private func copyMessage(_ sender: NSMenuItem) {
        guard let id = sender.representedObject as? String, let session, let index = session.displayIndex(of: id),
              let row = row(at: index), let text = MarkdownExport.message(for: row) else { return }
        session.app?.copyToPasteboard(text)
    }

    @objc private func copyDebugInfo(_ sender: NSMenuItem) {
        guard let id = sender.representedObject as? String, let text = debugInfo(rowId: id) else { return }
        session?.app?.copyToPasteboard(text)
    }

    /// "Copy debug info" for a row on screen.
    func debugInfo(rowId: String) -> String? {
        guard let session, let index = session.displayIndex(of: rowId), let row = row(at: index) else { return nil }
        return RowDebug.info(threadId: session.threadId, row: row, seqs: session.model.sourceSeqs(of: row.id),
                             runnerVersion: session.app?.runnerVersion ?? "", source: session.app?.eventsSource ?? .tb("tb"))
    }

    @objc private func toggleFromMenu(_ sender: NSMenuItem) {
        if let id = sender.representedObject as? String { toggleExpanded(rowId: id) }
    }

    @objc private func copyTranscript() {
        session?.copyTranscript()
    }

    func toggleChangedFile(turnId: String, path: String) {
        guard let session else { return }
        let key = ChangedFiles.expansionKey(turnId: turnId, path: path)
        session.setModelExpanded(key, !session.model.isExpanded(key))
    }

    func respond(approvalId: String, decision: ApprovalDecision, answers: [String: String]?, message: String?) {
        session?.respond(approvalId: approvalId, decision: decision, answers: answers, message: message)
    }

    func isAnswering(_ approvalId: String) -> Bool { session?.answering.contains(approvalId) == true }

    /// Lays out an approval or question card again as its answer goes
    /// (ThreadSession.answering). Its height doesn't change.
    func refreshCard(_ approvalId: String) {
        for id in ["ap:" + approvalId, "q:" + approvalId, "pl:" + approvalId] {
            if let index = session?.displayIndex(of: id), let row = row(at: index) { refreshCell(at: index, row: row) }
        }
    }

    func loadStartRequest(_ approvalId: String) {
        session?.loadStartRequest(approvalId)
    }

    func approvePlan(itemId: String) {
        session?.approvePlan(itemId: itemId)
    }

    func sendBackPlan() {
        guard let session else { return }
        session.app?.focusComposer(session.threadId)
    }

    func questionDraft(_ approvalId: String) -> [Int: Set<String>] { questionDrafts[approvalId] ?? [:] }

    func setQuestionDraft(_ approvalId: String, _ draft: [Int: Set<String>]) { questionDrafts[approvalId] = draft }

    func secretState(_ approvalId: String) -> SecretCardState { secretStates[approvalId] ?? .ready }

    func answerSecret(approvalId: String, _ answer: SecretAnswer) {
        guard let session else { return }
        secretStates[approvalId] = .sending
        refreshSecretCard(approvalId)
        Task { [weak self] in
            let failure = await session.answerSecret(approvalId: approvalId, answer)
            // Another thread opened meanwhile: its cards aren't this one's.
            guard let self, self.session === session else { return }
            self.secretStates[approvalId] = failure.map { .failed($0) } ?? .sent
            self.refreshSecretCard(approvalId)
        }
    }

    func secretEdited(_ approvalId: String) {
        guard case .failed = secretStates[approvalId] else { return }
        secretStates[approvalId] = nil
        refreshSecretCard(approvalId)
    }

    /// Lays the card out again for its new state. Its height doesn't
    /// change (an error takes the footer's line), so nothing moves.
    private func refreshSecretCard(_ approvalId: String) {
        guard let index = session?.displayIndex(of: "s:" + approvalId), let row = row(at: index) else { return }
        refreshCell(at: index, row: row)
    }

    /// Mike typed in, or took a picture out of, an ask's Something else box.
    func askNoteChanged(_ card: AsksCard, ask: Int, note: AskNote) {
        guard let session, let app = session.app, let thread = app.threads[session.threadId], thread.asksSeq == card.seq else { return }
        app.setNote(thread: thread, ask: ask, note: note)
    }

    /// Pictures pasted, dropped or chosen in an ask's Something else box.
    func askNoteImages(_ card: AsksCard, ask: Int, urls: [URL]) {
        guard let session, let app = session.app, let thread = app.threads[session.threadId], thread.asksSeq == card.seq else { return }
        app.addNoteImages(thread: thread, ask: ask, urls: urls)
    }

    func askPicturesAllowed(_ card: AsksCard) -> Bool {
        guard let session, let app = session.app, let thread = app.threads[session.threadId], thread.asksSeq == card.seq else { return false }
        // A picture this Mac's runner keeps would be a path another
        // runner hasn't got (as in the composer).
        if let name = app.runnerName(of: thread) {
            app.errorMessage = "Pictures can't go to \(name) from this Mac yet."
            return false
        }
        return true
    }

    func askImportPicture(_ card: AsksCard, url: URL) async -> ImageRef? {
        await session?.app?.importImages([url]).first
    }

    /// Sends the picks, every box and whatever's in the composer, as one
    /// message.
    func sendAnswers(_ card: AsksCard) {
        guard let session, let app = session.app else { return }
        app.send(threadId: session.threadId)
    }

    /// Return in ask `ask`'s Something else box goes on to the next ask
    /// still unanswered, and sends only once there's none: Return on ask 7
    /// of 10, meant as a new line or just early, sent the card with 8 to 10
    /// unanswered (Mike, 7 Nov). Its own box counts too, last: Return in an
    /// empty one beeps. ⌘Return sends whatever's answered.
    func answerBoxReturn(_ card: AsksCard, ask: Int, command: Bool) {
        if command || !showUnanswered(after: ask, orThis: true) { sendAnswers(card) }
    }

    /// Return in the empty composer with picks on the card: the same rule
    /// as a Something else box, from the ask the card is showing. False
    /// when every ask's answered, so Return sends as before.
    func returnWithUnanswered() -> Bool {
        showUnanswered(after: composerCard?.page ?? 0, orThis: true)
    }

    /// Puts the next ask after `ask` with nothing picked in front: its page
    /// on a paged card, with the cursor back in the composer (the box it
    /// was in has gone with its page). On a card showing every ask, it's in
    /// sight already, so a beep says Return didn't send. False if there's
    /// none, or no open card.
    private func showUnanswered(after ask: Int, orThis: Bool) -> Bool {
        guard let session, let app = session.app, let thread = app.threads[session.threadId],
              let card = session.openCard.flatMap({ row -> AsksCard? in
                  if case .asks(let card) = row.content { return card } else { return nil }
              }),
              card.isOpen, thread.asksSeq == card.seq,
              let next = Decisions.nextUnanswered(after: ask, count: card.asks.count, picks: Decisions.filled(picks: app.picks(for: thread), notes: app.notes(for: thread)), orThis: orThis)
        else { return false }
        // Already showing (the composer's Return on an unanswered ask): the beep.
        if composerCard?.page != next, composerCard?.showAsk(next) == true {
            app.focusComposer(thread.id)
        } else {
            NSSound.beep()
        }
        return true
    }

    /// Puts the cursor in ask `ask`'s Something else box on the card from `seq`.
    /// The open card is in the composer (ComposerCard).
    func focusAnswerBox(seq: Int, ask: Int) {
        guard session?.openCard?.id == "ak:\(seq)" else { return }
        composerCard?.focusAnswerBox(ask)
    }

    /// A button on the open asks card: `pick:<ask>:<n>` picks (or unpicks)
    /// an answer, which waits in the composer; `link:<ask>:<n>` opens one of
    /// the ask's links where links open (the pane or the browser). The done
    /// card's `archive` archives the thread, as ⌘E does, and `next:<n>`
    /// ticks or unticks a suggested follow-up, which waits in the composer;
    /// `explain:<n>` (the "?" at its right) turns on asking the agent what
    /// it meant, which waits in the composer the same way.
    /// `page:<n>` shows ask `n` on a paged card, and `collapse` folds the
    /// card to its heading or brings it back.
    func askAction(_ card: AsksCard, action: String) {
        guard let session, let app = session.app, let thread = app.threads[session.threadId] else { return }
        if action == "archive" {
            // Already archived (end_turn's archive: true, or ⌘E): nothing to do,
            // and archiving again would move the selection off it.
            // A plain button again: Mike dropped the Worked / Didn't work /
            // Not needed menu it opened for a day (6 Nov).
            if !thread.isArchived { app.archive(thread.id) }
            return
        }
        if action.hasPrefix("page:") {
            if let n = Int(action.dropFirst(5)) { composerCard?.showPage(n) }
            return
        }
        if action == "collapse" {
            app.toggleCardCollapsed(threadId: thread.id, seq: card.seq)
            return
        }
        if action.hasPrefix("next:") {
            guard card.isOpen, let n = Int(action.dropFirst(5)), card.next.indices.contains(n) else { return }
            app.toggleFollowUp(threadId: thread.id, card: card, index: n)
            return
        }
        if action.hasPrefix("explain:") {
            guard card.isOpen, let n = Int(action.dropFirst(8)), card.next.indices.contains(n) else { return }
            app.toggleExplain(threadId: thread.id, card: card, index: n)
            return
        }
        let parts = action.split(separator: ":")
        guard parts.count == 3, let index = Int(parts[1]), let n = Int(parts[2]), card.asks.indices.contains(index) else { return }
        let ask = card.asks[index]
        switch parts[0] {
        case "pick":
            guard Decisions.choices(for: ask).indices.contains(n) || n == Decisions.ownAnswer, thread.asksSeq == card.seq else { return }
            app.pickAnswer(thread: thread, ask: index, option: n)
            // Something else opened a box under the ask: the cursor goes in
            // it, once the card has made room for it.
            if n == Decisions.ownAnswer, let now = app.threads[thread.id], app.picks(for: now)[index] == Decisions.ownAnswer {
                DispatchQueue.main.async { [weak self] in self?.focusAnswerBox(seq: card.seq, ask: index) }
            }
            // A picked answer on a paged card moves on to the next ask.
            else if n != Decisions.ownAnswer, let now = app.threads[thread.id], app.picks(for: now)[index] == n {
                composerCard?.pagePast(index)
            }
        case "link":
            guard ask.links.indices.contains(n), let url = ask.links[n].target else { return }
            if WorkLinks.reviewId(of: url) != nil { return openReviewLink(url) }
            // A picture, PDF, text, page or folder shows in the pane; anything
            // else (a .tandem project) opens in its own app, as that's where
            // the ask wants him.
            let type = url.isFileURL ? UTType(filenameExtension: url.pathExtension) : nil
            let showable = type.map { t in [UTType.image, .pdf, .text, .html].contains { t.conforms(to: $0) } } ?? false
            let isFolder = url.isFileURL && FolderListing.isBrowsable(url.path)
            app.openLink(url, title: ask.links[n].title, in: thread, external: url.isFileURL && !isFolder && !showable)
        default: break
        }
    }

    func openReview(_ review: DesignReview) {
        guard let session else { return }
        session.app?.openReview(threadId: session.threadId, review: review)
    }

    /// The pencil by one of Mike's messages: its text and pictures go into
    /// the composer, and sending replaces it (docs/protocol.md, "Editing a
    /// message").
    func editMessage(rowId: String) {
        guard let session, let app = session.app,
              case .user(let message)? = session.model.item(id: rowId)?.content, message.editable,
              let row = session.model.item(id: rowId) else { return }
        app.startEditing(threadId: session.threadId, seq: row.seq, text: message.text, images: message.images)
    }
}

/// SwiftUI wrapper. The controller lives as long as the window's detail view,
/// and switching threads hands it a different session.
///
/// The controller has one scroll view, so this hosts it in a container
/// rather than handing it to SwiftUI as is. A second copy of the view (the
/// dock's ghost while a panel is dragged) used to take the scroll view into
/// itself and away with it when the ghost went, leaving the panel blank with
/// the thread loaded and drawn into a view in no window (Mike, 28 Oct, on
/// half dragging a panel). The ghost now gets a picture of the transcript,
/// and a container in a window takes the scroll view back if it's left
/// anywhere that isn't.
struct TranscriptView: NSViewRepresentable {
    let session: ThreadSession?
    let controller: TranscriptController
    @Environment(\.isDockGhost) private var isGhost

    func makeNSView(context: Context) -> TranscriptHost {
        TranscriptHost(controller: controller, ghost: isGhost)
    }

    func updateNSView(_ host: TranscriptHost, context: Context) {
        if isGhost { return }
        host.claim()
        controller.show(session)
    }
}

final class TranscriptHost: ComposerDropView {
    private let controller: TranscriptController
    private let ghost: Bool

    init(controller: TranscriptController, ghost: Bool) {
        self.controller = controller
        self.ghost = ghost
        super.init(frame: .zero)
        if ghost {
            // What the transcript looks like now, scaled with the ghost.
            wantsLayer = true
            let source = controller.scrollView
            if source.bounds.width > 0, source.bounds.height > 0,
               let rep = source.bitmapImageRepForCachingDisplay(in: source.bounds) {
                source.cacheDisplay(in: source.bounds, to: rep)
                let image = NSImage(size: source.bounds.size)
                image.addRepresentation(rep)
                layer?.contents = image
                layer?.contentsGravity = .resize
            }
        } else {
            // Nothing inside the transcript registers for drags (its text is
            // read-only), so a file over any of it ends up here.
            registerForDraggedTypes(ComposerTextView.droppedTypes)
            claim()
        }
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) has not been used") }

    /// The composer this transcript's drops go to, read at drag time as the
    /// box can be made after this view.
    override var handle: ComposerHandle? { controller.composerHandle }

    override var marksDrop: Bool { true }

    /// Puts the scroll view in this container, unless this one isn't in a
    /// window yet and the scroll view is: then it stays put until this one is.
    func claim() {
        guard !ghost else { return }
        let view = controller.scrollView
        if view.superview === self { return }
        if view.window != nil, window == nil { return }
        view.removeFromSuperview()
        view.frame = bounds
        view.autoresizingMask = [.width, .height]
        addSubview(view)
    }

    override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        if window != nil { claim() }
    }
}
