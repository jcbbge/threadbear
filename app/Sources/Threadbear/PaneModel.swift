import AppKit
import ThreadbearCore

/// A file or page open in the pane in place of its section: a highlight, a
/// list panel's row, or a file linked from the transcript.
struct PanePreview: Equatable {
    enum Target: Equatable {
        case file(String)
        /// A folder, browsed in the pane (FolderBrowser) rather than Quick
        /// Look's picture of its icon (Mike, 5 Nov).
        case folder(String)
        case page(URL)
        /// Words selected in the transcript, explained (`explainers`).
        case explain
        /// A file on the Mac another runner's thread is on, being fetched
        /// (`files.read`), or why it couldn't be. Once it's here the
        /// preview becomes `.file` of this Mac's copy.
        case remote(path: String, failed: String?)
    }

    var target: Target
    var title: String
    /// The section it was opened from, which Back goes to.
    var from: PaneSection
    /// Bumped each time it's opened, so opening the same file again reads
    /// it again (an agent rewrites its mockup between turns).
    var opened = 0
    /// A text file with its raw text up for editing (TextFileView).
    var editing = false
    /// "bruce": a copy of a file on another runner's Mac. It isn't edited
    /// here (the edit would only change this Mac's copy) or shown in the
    /// Finder (the copy lives in a cache).
    var away: String?
    /// That runner sent only the start of it (over the size cap).
    var cut = false
    /// What Back goes through before the section: the folders and files
    /// Mike came through in the browser, last one nearest. Empty for
    /// anything opened from outside it.
    var back: [PanePreview] = []
    /// A folder's selection and open rows, kept here so coming Back to it
    /// finds it as it was left.
    var folderMemory = FolderMemory()

    var fileURL: URL? {
        if case .file(let path) = target { return URL(fileURLWithPath: path) }
        return nil
    }

    var folderPath: String? {
        if case .folder(let path) = target { return path }
        return nil
    }

    /// What Open hands to the default app or browser. Another Mac's folder
    /// has no copy here to hand over.
    var externalURL: URL? {
        switch target {
        case .file(let path): URL(fileURLWithPath: path)
        case .folder(let path): away == nil ? URL(fileURLWithPath: path) : nil
        case .page(let url): url
        case .explain, .remote: nil
        }
    }
}

/// What a folder in the pane looks like when Mike leaves it.
struct FolderMemory: Equatable {
    var selected: [String] = []
    var expanded: Set<String> = []
}

/// The pane's Highlights section and its preview (docs/protocol.md,
/// "Highlights"): fetching a thread's highlights, and opening what's in them.
extension AppModel {
    // MARK: Fetching

    /// Asks for a thread's highlights after `delay`, once however many times
    /// it's asked meanwhile: a busy turn moves `lastSeq` many times a
    /// second, and this keeps it to about one fetch a second.
    func refreshHighlights(_ threadId: String, after delay: Duration = .seconds(1)) {
        guard !highlightsUnsupported else { return }
        highlightWanted[threadId, default: 0] += 1
        guard highlightFetches[threadId] == nil else { return }
        highlightFetches[threadId] = Task { [weak self] in
            if delay > .zero { try? await Task.sleep(for: delay) }
            var fetched = -1
            while let self, fetched != self.highlightWanted[threadId], !self.highlightsUnsupported {
                fetched = self.highlightWanted[threadId] ?? 0
                await self.fetchHighlights(threadId)
            }
            self?.highlightFetches[threadId] = nil
        }
    }

    private func fetchHighlights(_ threadId: String) async {
        guard let client = client(for: threadId) else { return }
        do {
            let fresh = try await client.threadHighlights(threadId: threadId)
            if highlights[threadId] != fresh { highlights[threadId] = fresh }
            if let pin = highlightAutoShow.receive(fresh, threadId: threadId), let thread = threads[threadId] {
                // The agent asked to show Mike this (`pin` with `show`):
                // open it in the pane, as long as he's on that thread. Only
                // the pane: an agent showing a file never starts its app
                // (Daybreak, 7 Nov: a .tandem symlinked to a .command).
                if selection == threadId { open(pin, in: thread, external: false, shownByAgent: true) }
            }
        } catch RPCError.server(let code, _) where code == RPCError.methodNotFound {
            highlightsUnsupported = true
        } catch {
            AppLog.write("rpc", "threads.highlights failed: \(error.localizedDescription)")
        }
    }

    /// Takes a highlight off for good. It goes from the list straight away;
    /// the runner's answer and the next fetch confirm it.
    func removeHighlight(_ highlight: Highlight, in threadId: String) {
        guard let client = client(for: threadId) else { return }
        highlights[threadId]?.highlights.removeAll { $0.id == highlight.id }
        Task {
            do {
                threads[threadId] = try await client.removeHighlight(threadId: threadId, highlightId: highlight.id)
            } catch {
                errorMessage = "Couldn't remove \(highlight.title): \(error.localizedDescription)"
            }
            refreshHighlights(threadId, after: .zero)
        }
    }

    // MARK: Opening

    /// A click on a highlight: a file previews in the pane (a project file
    /// opens in its app), a page goes where "Default" says (openLink).
    /// `external` is Open in the context menu: always the default app or
    /// browser. `shownByAgent`: a pin with `show` coming up by itself,
    /// which only ever goes to the pane or the browser, never another app.
    func open(_ highlight: Highlight, in thread: ThreadSummary, external: Bool, shownByAgent: Bool = false) {
        if let path = highlight.path, thread.isRemote {
            // On that Mac: fetched, then its copy here is used.
            openRemoteFile(URL(fileURLWithPath: path), external && !shownByAgent ? .app : .panel, in: thread, title: highlight.title)
        } else if let path = highlight.path {
            if !shownByAgent, external || FileLinkAction.opensInItsApp(path) { openExternally(URL(fileURLWithPath: path)) } else { preview(path: path, title: highlight.title, in: thread) }
        } else if let url = highlight.link {
            if shownByAgent {
                // A page where Default says, as a click would; a file in
                // the pane; another app's link not by itself at all.
                if url.isFileURL { preview(path: url.path, title: highlight.title, in: thread) } else if LinkPolicy.web(url) != nil { openLink(url, title: highlight.title, in: thread) }
                return
            }
            openLink(url, title: highlight.title, in: thread, external: external)
        }
    }

    /// A link from a highlight or a list panel's row: a file in the pane
    /// (a project file in its app), a page where "Default" says (the
    /// browser unless Mike picked the panel).
    func openLink(_ url: URL, title: String? = nil, in thread: ThreadSummary, external: Bool = false) {
        if url.isFileURL, thread.isRemote {
            openRemoteFile(url, external ? .app : .panel, in: thread, title: title)
        } else if external || (url.isFileURL && FileLinkAction.opensInItsApp(url.path)) {
            openExternally(url)
        } else if url.isFileURL {
            preview(path: url.path, title: title ?? url.lastPathComponent, in: thread)
        } else if PreviewRules.isWebPage(url), WebLinkAction.click == .panel {
            preview(page: url, title: title ?? HighlightText.address(url.absoluteString), in: thread)
        } else {
            openWebPage(url)
        }
    }

    /// A web page in the browser, unless an agent already has it open in
    /// Chrome through BrowserBear: then that tab comes to Mike instead of
    /// a second one opening (BrowserBear.swift).
    func openWebPage(_ url: URL) {
        Task { @MainActor in
            if await BrowserBear.handoff(url) { return }
            openExternally(url)
        }
    }

    func preview(path: String, title: String? = nil, in thread: ThreadSummary) {
        if thread.isRemote { return openRemoteFile(URL(fileURLWithPath: path), .panel, in: thread, title: title) }
        let target: PanePreview.Target = FolderListing.isBrowsable(path) ? .folder(path) : .file(path)
        show(PanePreview(target: target, title: title ?? (path as NSString).lastPathComponent, from: paneSection(for: thread)), in: thread.id)
    }

    /// A ```mermaid or ```html box opened beside its thread: the page the
    /// app wrote for it on this Mac, whichever runner the thread is on.
    func previewRichBlock(_ file: URL, title: String) {
        guard let thread = selectedThread, openProjectId == nil else { return }
        show(PanePreview(target: .file(file.path), title: title, from: paneSection(for: thread)), in: thread.id)
    }

    func preview(page url: URL, title: String, in thread: ThreadSummary) {
        show(PanePreview(target: .page(url), title: title, from: paneSection(for: thread)), in: thread.id)
    }

    func show(_ preview: PanePreview, in threadId: String) {
        var preview = preview
        preview.opened = (panePreview[threadId]?.opened ?? 0) + 1
        panePreview[threadId] = preview
        // Over the section it's from, opening that if it's closed.
        showPane(preview.from)
        // A page kept loaded from an earlier look is read again: the file
        // or the dev server has likely changed since.
        if preview.folderPath == nil, let url = preview.externalURL, preview.fileURL.map({ PreviewRules.viewer(forPath: $0.path) == .web }) ?? true {
            WebPanelPool.shared.reloadIfLoaded(url)
        }
    }

    /// The bar's pencil (and Done) over a text file.
    func setPreviewEditing(_ editing: Bool, in threadId: String) {
        panePreview[threadId]?.editing = editing
    }

    /// Back, to the section the preview came from. An explanation is kept
    /// until the next one, though nothing shows it again yet.
    func closePreview(in threadId: String) {
        panePreview[threadId] = nil
    }

    /// The bar's Back: through the folders and files Mike came through in
    /// the browser, then out to the section.
    func previewBack(in threadId: String) {
        guard let current = panePreview[threadId] else { return }
        guard var previous = current.back.last else { return closePreview(in: threadId) }
        previous.back = Array(current.back.dropLast())
        previous.opened = current.opened + 1
        panePreview[threadId] = previous
    }

    // MARK: The folder browser

    /// Goes to a folder from the one showing, which Back then returns to as
    /// `memory` says. `selecting` is what to show picked there: the folder
    /// Mike came up out of, as the Finder does. `current` is the folder
    /// the browser is showing: the rail's Files panel shows the thread's
    /// folder without storing a preview, so the pane's stored one may be
    /// none, or another section's.
    func browseFolder(_ path: String, from memory: FolderMemory, selecting: String? = nil, showing current: PanePreview, in thread: ThreadSummary) {
        var next = PanePreview(target: .folder(path), title: (path as NSString).lastPathComponent, from: current.from)
        next.away = current.away
        next.back = backStack(of: current, leaving: memory)
        if let selecting { next.folderMemory.selected = [selecting] }
        show(next, in: thread.id)
    }

    /// A double-click in the folder browser. A folder goes in; a file shows
    /// in the pane with Back to here; a package or a project file opens in
    /// its app, as neither means anything in the pane.
    func openFromFolder(_ entry: FolderEntry, from memory: FolderMemory, showing current: PanePreview, in thread: ThreadSummary) {
        if entry.isFolder { return browseFolder(entry.path, from: memory, showing: current, in: thread) }
        let back = backStack(of: current, leaving: memory)
        if thread.isRemote {
            return openRemoteFile(URL(fileURLWithPath: entry.path), .panel, in: thread, title: entry.name, back: back, from: current.from)
        }
        if entry.isPackage || FileLinkAction.opensInItsApp(entry.path) { return openExternally(URL(fileURLWithPath: entry.path)) }
        var next = PanePreview(target: .file(entry.path), title: entry.name, from: current.from)
        next.back = back
        show(next, in: thread.id)
    }

    /// What the rail's Files panel shows while nothing's open over it: the
    /// thread's folder, not stored in `panePreview`, so it's there for
    /// every thread. Another Mac's folder says whose it is, as a folder
    /// link there does.
    func filesPanelPreview(for thread: ThreadSummary) -> PanePreview {
        var preview = PanePreview(target: .folder(thread.cwd), title: "Files", from: .panel(BuiltinPanels.files))
        if thread.isRemote { preview.away = runnerName(of: thread) ?? "another Mac" }
        return preview
    }

    private func backStack(of current: PanePreview, leaving memory: FolderMemory) -> [PanePreview] {
        var current = current
        current.folderMemory = memory
        let back = current.back
        current.back = []
        return back + [current]
    }

    /// A file in its app or a link where it goes, through OpenGate: a
    /// program asks first (and never opens from another Mac's copy), a
    /// link that isn't a web page asks before starting its app.
    func openExternally(_ url: URL, from origin: OpenGate.Origin = .thisMac) {
        if url.isFileURL { OpenGate.openFile(url, origin: origin) } else { OpenGate.openLink(url, origin: origin) }
    }

    /// A file a thread's runner named (a patch's file, an edited file) in
    /// its app: this Mac's own, or another Mac's fetched copy. Never the
    /// file here that has that other Mac's path.
    func openFile(_ path: String, of thread: ThreadSummary) {
        if thread.isRemote {
            openRemoteFile(URL(fileURLWithPath: path), .app, in: thread)
        } else {
            openExternally(URL(fileURLWithPath: path))
        }
    }

    /// Where a copy of `thread`'s runner's files comes from, for OpenGate.
    func copyOrigin(of thread: ThreadSummary) -> OpenGate.Origin {
        .otherMac(name: runnerName(of: thread) ?? "another Mac", root: remoteFiles.cache.root)
    }

    /// Whether `url` is in this Mac's copies of other Macs' files.
    func isRemoteCopy(_ url: URL) -> Bool {
        let root = remoteFiles.cache.root.standardizedFileURL.resolvingSymlinksInPath().path
        let path = url.standardizedFileURL.resolvingSymlinksInPath().path
        return path.hasPrefix(root.hasSuffix("/") ? root : root + "/")
    }

    /// The thread a transcript link was followed in (`linkThreadId`), else
    /// the selected one.
    var linkThread: ThreadSummary? {
        linkThreadId.flatMap { threads[$0] } ?? selectedThread
    }

    /// The file on this Mac that dragging, Quick Look or a hover card may
    /// use for a link in `thread`: the file itself for this Mac's thread,
    /// this Mac's whole copy for another Mac's, or nil while there isn't
    /// one. Never the other Mac's path read as this Mac's, which named a
    /// file here that the drag then handed out (Daybreak, 7 Nov).
    func localCopy(of url: URL, in thread: ThreadSummary?) -> URL? {
        guard url.isFileURL else { return url }
        guard let thread, let runnerId = thread.runnerId else { return url }
        guard let copy = remoteFiles.ready(url.path, runnerId: runnerId), !copy.truncated else { return nil }
        return copy.url
    }

    func revealInFinder(_ path: String) {
        NSWorkspace.shared.activateFileViewerSelecting([URL(fileURLWithPath: path)])
    }

    /// A click on a file link in the transcript does what Mike picked in
    /// its right-click menu (FileLinkAction.click); ⌘-click and a project
    /// file open in the file's own app (FileLinkAction.forClick).
    func openTranscriptFileLink(_ url: URL, commandKey: Bool) -> Bool {
        openTranscriptFile(url, FileLinkAction.forClick(on: url.path, commandKey: commandKey, remote: linkThread?.isRemote == true))
    }

    /// `url` is a file URL, perhaps with a `?query` or `#fragment` for the
    /// page (FilePathRefs.fileLink), which a page in the panel or the
    /// browser keeps.
    @discardableResult
    func openTranscriptFile(_ url: URL, _ action: FileLinkAction) -> Bool {
        // The thread the link is in, all the way through: a thread open in
        // a panel isn't the selected one, whose pane isn't its (Codex review).
        let thread = linkThread
        let inPane = thread != nil && thread?.id == selection && openProjectId == nil
        if let thread, thread.isRemote {
            // Its own pane only when it's the one showing; else its app.
            openRemoteFile(url, inPane || action == .finder ? action : .app, in: thread)
            return true
        }
        let path = url.path
        var action = action
        if action == .automatic { action = PreviewRules.previewsInPane(transcriptLink: url) || FolderListing.isBrowsable(path) ? .panel : .app }
        switch action {
        case .panel:
            // The pane belongs to a thread; on a project page there's none,
            // and a thread open in a panel has none showing.
            guard let thread, inPane else {
                openExternally(url)
                return true
            }
            if url.query != nil || url.fragment != nil, PreviewRules.viewer(forPath: path) == .web {
                preview(page: url, title: url.lastPathComponent, in: thread)
            } else {
                preview(path: path, in: thread)
            }
            return true
        case .finder:
            revealInFinder(path)
            return true
        case .app, .automatic:
            openExternally(url)
            return true
        }
    }

    /// A web link in the transcript, in the browser or the panel.
    @discardableResult
    func openTranscriptWebLink(_ url: URL, _ action: WebLinkAction) -> Bool {
        // The pane belongs to a thread; on a project page there's none.
        guard action == .panel, let thread = selectedThread, openProjectId == nil else {
            openWebPage(url)
            return true
        }
        preview(page: url, title: HighlightText.address(url.absoluteString), in: thread)
        return true
    }

    /// The file a transcript link names, as a file URL keeping any query
    /// and fragment: a file link itself, or a path in inline code found
    /// from the selected thread's folder and what its tools touched
    /// (FilePathRefs). Nil for one that names nothing.
    func transcriptLinkFile(_ url: URL) -> URL? {
        if url.isFileURL { return url }
        guard let text = FilePathRefs.text(of: url) else { return nil }
        let thread = linkThread
        let known = thread.flatMap { loadedSession($0.id) }.map { FilePathRefs.toolPaths($0.model.items) } ?? []
        // Another runner's paths are that Mac's, so nothing is looked for
        // here: the path as written, or from the thread's folder there,
        // and its runner says whether it's there when it's fetched.
        if let thread, thread.isRemote {
            return FilePathRefs.fileLink(text, root: thread.cwd, known: known, home: remoteHome(of: thread),
                                         exists: { $0.hasPrefix("/") }, search: { _, _ in nil })
        }
        return FilePathRefs.fileLink(text, root: thread?.cwd, known: known)
    }

    /// A click on a path in inline code. One that names nothing beeps.
    func openTranscriptPathRef(_ text: String, commandKey: Bool) -> Bool {
        guard let url = FilePathRefs.url(for: text), let file = transcriptLinkFile(url) else {
            NSSound.beep()
            return false
        }
        return openTranscriptFileLink(file, commandKey: commandKey)
    }
}
