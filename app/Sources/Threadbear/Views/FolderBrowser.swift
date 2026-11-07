import AppKit
import Quartz
import QuickLookThumbnailing
import SwiftUI
import ThreadbearCore
import UniformTypeIdentifiers

// A folder in the side pane, working like a Finder window: a list with
// columns and fold-out rows or a grid of thumbnails, double-click to go in,
// a path bar to go back up, the space bar for Quick Look and files that
// drag out. Mike clicked a link to a folder and got Quick Look's picture of
// its icon (5 Nov), which he couldn't do anything with.
//
// It's AppKit rather than SwiftUI as a folder can hold thousands of rows,
// and the keyboard, selection, type-to-select, disclosure triangles, column
// sorting and drags all come with NSOutlineView and NSCollectionView.

/// List or icons, the same for every folder, as the bar's button left it.
enum FolderViewMode: String {
    case list, icons

    static let key = "folderBrowserMode"
    static var current: FolderViewMode {
        get { UserDefaults.standard.string(forKey: key).flatMap(FolderViewMode.init(rawValue:)) ?? .list }
        set { UserDefaults.standard.set(newValue.rawValue, forKey: key) }
    }
}

/// The bar's button between the two views.
struct FolderModeButton: View {
    @AppStorage(FolderViewMode.key) private var mode: FolderViewMode = .list

    var body: some View {
        PaneHeaderButton(symbol: mode == .list ? "square.grid.2x2" : "list.bullet",
                         help: mode == .list ? "Show as icons" : "Show as a list") {
            mode = mode == .list ? .icons : .list
        }
    }
}

struct FolderBrowser: NSViewRepresentable {
    @Environment(AppModel.self) private var app
    @AppStorage(FolderViewMode.key) private var mode: FolderViewMode = .list
    let thread: ThreadSummary
    let path: String
    let preview: PanePreview

    final class Coordinator {
        var opened: Int?
        /// The preview this browser shows now, which a file or folder
        /// opened from it comes Back to. Kept up to date here, as the view
        /// outlives a preview replaced by another of the same folder.
        var showing: PanePreview?
    }

    func makeCoordinator() -> Coordinator { Coordinator() }

    func makeNSView(context: Context) -> FolderPaneView {
        let app = app
        let thread = thread
        let source: FolderPaneView.Source
        if thread.isRemote {
            source = { [weak app] folder in
                guard let app else { throw RPCError.disconnected(nil) }
                let client = try await app.openClient(for: thread.id)
                return try await client.listFolder(path: folder, runnerId: app.viaRelay(thread.id) ? thread.runnerId : nil)
            }
        } else {
            source = { folder in try await Task.detached(priority: .userInitiated) { try FolderListing.read(folder) }.value }
        }
        let view = FolderPaneView(path: path, away: preview.away, memory: preview.folderMemory, mode: mode, source: source)
        let coordinator = context.coordinator
        coordinator.showing = preview
        let first = preview
        view.onOpen = { [weak app] entry, memory in app?.openFromFolder(entry, from: memory, showing: coordinator.showing ?? first, in: thread) }
        view.onBrowse = { [weak app] folder, memory, selecting in app?.browseFolder(folder, from: memory, selecting: selecting, showing: coordinator.showing ?? first, in: thread) }
        view.onExternal = { [weak app] url in app?.openExternally(url) }
        view.onReveal = { [weak app] file in app?.revealInFinder(file) }
        return view
    }

    func updateNSView(_ view: FolderPaneView, context: Context) {
        view.setMode(mode)
        // Opened again (a link clicked, Back): read it again.
        if context.coordinator.opened != nil, context.coordinator.opened != preview.opened { view.refresh() }
        context.coordinator.opened = preview.opened
        context.coordinator.showing = preview
    }

    static func dismantleNSView(_ view: FolderPaneView, coordinator: Coordinator) {
        view.close()
    }
}

/// One row. The same object stays with its path across reloads, as
/// NSOutlineView knows its open rows by the object.
final class FolderNode: NSObject {
    var entry: FolderEntry
    /// Nil until it's been read, for a folder that's never been opened.
    var children: [FolderNode]?

    init(_ entry: FolderEntry) {
        self.entry = entry
    }
}

final class FolderPaneView: NSView, NSOutlineViewDataSource, NSOutlineViewDelegate, NSCollectionViewDataSource, NSCollectionViewDelegate, NSCollectionViewDelegateFlowLayout {
    typealias Source = @MainActor (String) async throws -> FolderContents

    /// The one in the pane, for the scripted app and its dump.
    nonisolated(unsafe) static weak var current: FolderPaneView?

    var onOpen: ((FolderEntry, FolderMemory) -> Void)?
    var onBrowse: ((String, FolderMemory, String?) -> Void)?
    var onExternal: ((URL) -> Void)?
    var onReveal: ((String) -> Void)?

    private let path: String
    /// "bruce": it's a folder on that Mac, so nothing here can touch it.
    private let away: String?
    /// Folders on another Mac opened and not read yet.
    private var loadingFolders: Set<String> = []
    private let source: Source
    private var mode: FolderViewMode
    private var sort = FolderPaneView.savedSort
    private var showHidden = UserDefaults.standard.bool(forKey: FolderPaneView.hiddenKey)
    /// Where Mike left it, applied as the rows it names are read.
    private var pendingMemory: FolderMemory

    private var listings: [String: FolderContents] = [:]
    private var nodes: [String: FolderNode] = [:]
    private var rootNodes: [FolderNode]?
    private var loads: [String: Task<Void, Never>] = [:]
    private var watchers: [String: DispatchSourceFileSystemObject] = [:]
    private var pendingReads: Set<String> = []
    private var poll: Task<Void, Never>?
    private var activeObserver: NSObjectProtocol?
    private var failure: String?
    /// Set while this code selects rows itself, so that isn't taken as Mike
    /// moving through them with Quick Look up.
    private var restoring = false

    private let outline = FolderOutlineView()
    private let listScroll = NSScrollView()
    private let grid = FolderCollectionView()
    private let gridScroll = NSScrollView()
    private let pathBar = FolderPathBar()
    private let pathRule = NSBox()
    private let note = NSTextField(labelWithString: "")
    private let nameColumn = NSTableColumn(identifier: .init("name"))
    private let dateColumn = NSTableColumn(identifier: .init("modified"))
    private let sizeColumn = NSTableColumn(identifier: .init("size"))

    init(path: String, away: String?, memory: FolderMemory, mode: FolderViewMode, source: @escaping Source) {
        self.path = path
        self.away = away
        self.pendingMemory = memory
        self.mode = mode
        self.source = source
        super.init(frame: .zero)
        Self.current = self
        buildList()
        buildGrid()
        buildPathBar()
        note.font = .systemFont(ofSize: TypeScale.label)
        note.textColor = .secondaryLabelColor
        note.alignment = .center
        note.maximumNumberOfLines = 0
        note.lineBreakMode = .byWordWrapping
        addSubview(note)
        applyMode()
        refresh()
        // Anything that changed while Mike was in another app, including
        // a file growing, which the folder's own watcher doesn't hear.
        activeObserver = NotificationCenter.default.addObserver(forName: NSApplication.didBecomeActiveNotification, object: nil, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated { self?.refresh() }
        }
        // Another Mac's folder can't be watched from here.
        if away != nil {
            poll = Task { [weak self] in
                while !Task.isCancelled {
                    try? await Task.sleep(for: .seconds(15))
                    guard let self else { return }
                    self.refresh()
                }
            }
        }
    }

    required init?(coder: NSCoder) { fatalError() }

    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }

    /// When the view leaves the pane: nothing goes on reading or watching.
    func close() {
        loads.values.forEach { $0.cancel() }
        loads = [:]
        watchers.values.forEach { $0.cancel() }
        watchers = [:]
        poll?.cancel()
        if let activeObserver { NotificationCenter.default.removeObserver(activeObserver) }
        activeObserver = nil
    }

    // MARK: Building

    private func buildList() {
        nameColumn.title = "Name"
        nameColumn.minWidth = zoomed(120)
        nameColumn.resizingMask = .autoresizingMask
        nameColumn.sortDescriptorPrototype = NSSortDescriptor(key: FolderSort.Key.name.rawValue, ascending: true)
        dateColumn.title = "Date Modified"
        dateColumn.width = zoomed(150)
        dateColumn.minWidth = zoomed(90)
        dateColumn.resizingMask = .userResizingMask
        // A column's first click means the most useful way round: newest
        // and biggest first.
        dateColumn.sortDescriptorPrototype = NSSortDescriptor(key: FolderSort.Key.modified.rawValue, ascending: false)
        sizeColumn.title = "Size"
        // Over its numbers, which line up on the right.
        sizeColumn.headerCell.alignment = .right
        sizeColumn.width = zoomed(72)
        sizeColumn.minWidth = zoomed(50)
        sizeColumn.resizingMask = .userResizingMask
        sizeColumn.sortDescriptorPrototype = NSSortDescriptor(key: FolderSort.Key.size.rawValue, ascending: false)
        outline.addTableColumn(nameColumn)
        outline.addTableColumn(dateColumn)
        outline.addTableColumn(sizeColumn)
        outline.outlineTableColumn = nameColumn
        outline.columnAutoresizingStyle = .firstColumnOnlyAutoresizingStyle
        outline.rowHeight = zoomed(24)
        outline.style = .fullWidth
        outline.backgroundColor = .clear
        outline.allowsMultipleSelection = true
        outline.allowsTypeSelect = true
        outline.autosaveExpandedItems = false
        outline.verticalMotionCanBeginDrag = true
        outline.setDraggingSourceOperationMask(.copy, forLocal: false)
        outline.dataSource = self
        outline.delegate = self
        outline.pane = self
        outline.sortDescriptors = [Self.descriptor(for: sort)]
        listScroll.documentView = outline
        listScroll.hasVerticalScroller = true
        listScroll.autohidesScrollers = true
        listScroll.drawsBackground = false
        addSubview(listScroll)
    }

    private func buildGrid() {
        let layout = NSCollectionViewFlowLayout()
        layout.minimumInteritemSpacing = 0
        layout.minimumLineSpacing = zoomed(4)
        layout.sectionInset = NSEdgeInsets(top: zoomed(8), left: zoomed(8), bottom: zoomed(8), right: zoomed(8))
        grid.collectionViewLayout = layout
        grid.isSelectable = true
        grid.allowsMultipleSelection = true
        grid.backgroundColors = [.clear]
        grid.dataSource = self
        grid.delegate = self
        grid.register(FolderGridItem.self, forItemWithIdentifier: FolderGridItem.identifier)
        grid.setDraggingSourceOperationMask(.copy, forLocal: false)
        grid.pane = self
        gridScroll.documentView = grid
        gridScroll.hasVerticalScroller = true
        gridScroll.autohidesScrollers = true
        gridScroll.drawsBackground = false
        addSubview(gridScroll)
    }

    private func buildPathBar() {
        pathRule.boxType = .separator
        addSubview(pathRule)
        pathBar.onPick = { [weak self] target, next in
            guard let self, target != self.path else { return }
            // Going up, what's picked there is the folder on the way back down.
            self.onBrowse?(target, self.memory, next)
        }
        pathBar.show(FolderListing.crumbs(to: path, home: away == nil ? NSHomeDirectory() : Self.home(of: path)))
        addSubview(pathBar)
    }

    /// Another Mac's home, for its path bar. Nothing to ask it: its folders
    /// under /Users say.
    private static func home(of path: String) -> String {
        let parts = path.split(separator: "/")
        return parts.count >= 2 && parts[0] == "Users" ? "/Users/\(parts[1])" : "/nowhere"
    }

    override func layout() {
        super.layout()
        let barHeight = zoomed(26)
        pathBar.frame = NSRect(x: zoomed(8), y: 0, width: max(0, bounds.width - zoomed(16)), height: barHeight)
        pathRule.frame = NSRect(x: 0, y: barHeight, width: bounds.width, height: 1)
        let content = NSRect(x: 0, y: barHeight + 1, width: bounds.width, height: max(0, bounds.height - barHeight - 1))
        listScroll.frame = content
        gridScroll.frame = content
        let noteSize = note.sizeThatFits(NSSize(width: max(0, bounds.width - zoomed(48)), height: .greatestFiniteMagnitude))
        note.frame = NSRect(x: zoomed(24), y: content.midY - noteSize.height / 2, width: max(0, bounds.width - zoomed(48)), height: noteSize.height)
        // The pane can be narrow: the name matters most, then the date.
        let hideDate = bounds.width < zoomed(380)
        let hideSize = bounds.width < zoomed(260)
        if dateColumn.isHidden != hideDate { dateColumn.isHidden = hideDate }
        if sizeColumn.isHidden != hideSize { sizeColumn.isHidden = hideSize }
        outline.sizeLastColumnToFit()
        grid.collectionViewLayout?.invalidateLayout()
    }

    // MARK: Reading

    /// Reads the folder and every open row again.
    func refresh() {
        load(path)
        for folder in listings.keys where folder != path { load(folder) }
    }

    private func load(_ folder: String) {
        loads[folder]?.cancel()
        let source = source
        loads[folder] = Task { [weak self] in
            let result: Result<FolderContents, Error>
            do { result = .success(try await source(folder)) } catch { result = .failure(error) }
            guard let self, !Task.isCancelled else { return }
            self.loads[folder] = nil
            switch result {
            case .success(let contents): self.apply(contents, for: folder)
            case .failure(let error): self.failed(folder, error)
            }
        }
    }

    private func failed(_ folder: String, _ error: Error) {
        // One that was spinning closes again and says so, rather than
        // sitting open and empty.
        if loadingFolders.remove(folder) != nil, let node = nodes[folder] {
            AppLog.write("rpc", "reading folder \(folder) failed: \(error.localizedDescription)")
            outline.collapseItem(node)
            outline.reloadItem(node)
            note.stringValue = "Couldn't read \(node.entry.name)\(away.map { " on \($0)" } ?? "")."
            note.isHidden = false
            note.setTip(error.localizedDescription)
            needsLayout = true
            return
        }
        // A row that's gone is dealt with when its parent is next read.
        guard folder == path else { return }
        AppLog.write("rpc", "reading folder \(folder) failed: \(error.localizedDescription)")
        listings[folder] = nil
        rootNodes = nil
        failure = error.localizedDescription
        // Its watcher is on what was deleted: one made afresh hears a new one.
        watchers.removeValue(forKey: folder)?.cancel()
        reloadViews()
        updateNote(error: error)
    }

    private func apply(_ contents: FolderContents, for folder: String) {
        let hadIt = listings[folder] != nil
        loadingFolders.remove(folder)
        if listings[folder] == contents, failure == nil { return }
        listings[folder] = contents
        failure = nil
        watch(folder)
        rebuild(folder)
        if !hadIt { restoreMemory() }
        updateNote(error: nil)
    }

    /// Makes the rows for one folder from what was read, in Mike's order.
    private func rebuild(_ folder: String) {
        guard let contents = listings[folder] else { return }
        let shown = sort.apply(showHidden ? contents.entries : contents.entries.filter { !$0.hidden })
        let rows = shown.map { entry -> FolderNode in
            if let node = nodes[entry.path], node.entry.isFolder == entry.isFolder {
                node.entry = entry
                return node
            }
            let node = FolderNode(entry)
            nodes[entry.path] = node
            return node
        }
        if folder == path {
            rootNodes = rows
            reloadViews()
        } else if let parent = nodes[folder] {
            parent.children = rows
            keepingSelection { outline.reloadItem(parent, reloadChildren: true) }
            restoreMemory()
        }
    }

    private func reloadViews() {
        keepingSelection {
            outline.reloadData()
            grid.reloadData()
        }
    }

    private func keepingSelection(_ change: () -> Void) {
        let selected = selectedPaths
        restoring = true
        change()
        select(paths: selected)
        restoring = false
    }

    /// Where Mike left the folder: its open rows as each is read, then what
    /// was selected, scrolled to, once the rows it names exist.
    private func restoreMemory() {
        for folder in pendingMemory.expanded {
            guard let node = nodes[folder], outline.row(forItem: node) >= 0 else { continue }
            pendingMemory.expanded.remove(folder)
            outline.expandItem(node)
        }
        if !pendingMemory.selected.isEmpty, pendingMemory.selected.allSatisfy({ nodes[$0] != nil && (mode == .icons || outline.row(forItem: nodes[$0]) >= 0) }) {
            let selected = pendingMemory.selected
            pendingMemory.selected = []
            restoring = true
            select(paths: selected)
            restoring = false
            revealSelection()
        }
    }

    private func updateNote(error: Error?) {
        if let error {
            note.stringValue = Self.words(for: error, path: path, away: away)
        } else {
            note.stringValue = rootNodes?.isEmpty == true ? "Nothing in this folder" : ""
        }
        note.isHidden = note.stringValue.isEmpty
        note.setTip(error?.localizedDescription ?? "")
        needsLayout = true
    }

    private static func words(for error: Error, path: String, away: String?) -> String {
        if case RPCError.server(let code, _) = error, code == RPCError.methodNotFound {
            return "\(away ?? "That Mac")'s runner needs updating to show folders."
        }
        if away == nil, !FileManager.default.fileExists(atPath: path) { return "This folder isn't there any more." }
        return "Couldn't read this folder\(away.map { " on \($0)" } ?? "")."
    }

    // MARK: Watching

    /// Hears files coming and going as an agent makes them. Only on this
    /// Mac, and only the folders being shown.
    private func watch(_ folder: String) {
        guard away == nil, watchers[folder] == nil else { return }
        let descriptor = Darwin.open(folder, O_EVTONLY)
        guard descriptor >= 0 else { return }
        let watcher = DispatchSource.makeFileSystemObjectSource(fileDescriptor: descriptor, eventMask: [.write, .delete, .rename], queue: .main)
        watcher.setEventHandler { [weak self] in
            MainActor.assumeIsolated { self?.changed(folder) }
        }
        watcher.setCancelHandler { Darwin.close(descriptor) }
        watcher.resume()
        watchers[folder] = watcher
    }

    /// A busy folder fires many times a second: one read after it settles,
    /// and longer for a huge one, which takes a while to sort and draw.
    private func changed(_ folder: String) {
        guard !pendingReads.contains(folder) else { return }
        pendingReads.insert(folder)
        Task { [weak self] in
            let huge = (self?.listings[folder]?.entries.count ?? 0) > 2000
            try? await Task.sleep(for: huge ? .seconds(3) : .milliseconds(300))
            guard let self else { return }
            self.pendingReads.remove(folder)
            if self.watchers[folder] != nil { self.load(folder) }
        }
    }

    // MARK: Modes and options

    func setMode(_ next: FolderViewMode) {
        guard next != mode else { return }
        let selected = selectedPaths
        mode = next
        applyMode()
        restoring = true
        select(paths: selected)
        restoring = false
        revealSelection()
    }

    private func applyMode() {
        listScroll.isHidden = mode != .list
        gridScroll.isHidden = mode != .icons
        // Keys and Quick Look follow the view that's showing, if Mike was
        // already working in the other.
        if window?.firstResponder === outline || window?.firstResponder === grid {
            window?.makeFirstResponder(mode == .list ? outline : grid)
        }
    }

    private static let sortKey = "folderBrowserSort"
    private static let sortAscendingKey = "folderBrowserSortAscending"
    private static let hiddenKey = "folderBrowserShowHidden"

    private static var savedSort: FolderSort {
        let defaults = UserDefaults.standard
        guard let key = defaults.string(forKey: sortKey).flatMap(FolderSort.Key.init(rawValue:)) else { return FolderSort() }
        return FolderSort(key: key, ascending: defaults.bool(forKey: sortAscendingKey))
    }

    private static func descriptor(for sort: FolderSort) -> NSSortDescriptor {
        NSSortDescriptor(key: sort.key.rawValue, ascending: sort.ascending)
    }

    func setSort(_ next: FolderSort) {
        guard next != sort else { return }
        sort = next
        UserDefaults.standard.set(next.key.rawValue, forKey: Self.sortKey)
        UserDefaults.standard.set(next.ascending, forKey: Self.sortAscendingKey)
        let descriptor = Self.descriptor(for: next)
        if outline.sortDescriptors.first != descriptor { outline.sortDescriptors = [descriptor] }
        listings.keys.forEach(rebuild)
    }

    func setShowHidden(_ next: Bool) {
        guard next != showHidden else { return }
        showHidden = next
        UserDefaults.standard.set(next, forKey: Self.hiddenKey)
        listings.keys.forEach(rebuild)
        updateNote(error: nil)
    }

    // MARK: Selection

    private var selectedNodes: [FolderNode] {
        switch mode {
        case .list:
            return outline.selectedRowIndexes.compactMap { outline.item(atRow: $0) as? FolderNode }
        case .icons:
            let rows = rootNodes ?? []
            return grid.selectionIndexPaths.sorted().compactMap { rows.indices.contains($0.item) ? rows[$0.item] : nil }
        }
    }

    private var selectedPaths: [String] { selectedNodes.map(\.entry.path) }

    private func select(paths: [String]) {
        let rowsInList = paths.compactMap { nodes[$0] }.map { outline.row(forItem: $0) }.filter { $0 >= 0 }
        outline.selectRowIndexes(IndexSet(rowsInList), byExtendingSelection: false)
        let root = rootNodes ?? []
        let inGrid = paths.compactMap { path in root.firstIndex { $0.entry.path == path } }
        grid.selectionIndexPaths = Set(inGrid.map { IndexPath(item: $0, section: 0) })
    }

    private func revealSelection() {
        switch mode {
        case .list:
            if let first = outline.selectedRowIndexes.first { outline.scrollRowToVisible(first) }
        case .icons:
            if let first = grid.selectionIndexPaths.min() { grid.scrollToItems(at: [first], scrollPosition: .nearestHorizontalEdge) }
        }
    }

    private var memory: FolderMemory {
        var expanded: Set<String> = []
        for row in 0..<outline.numberOfRows {
            if let node = outline.item(atRow: row) as? FolderNode, outline.isItemExpanded(node) { expanded.insert(node.entry.path) }
        }
        return FolderMemory(selected: selectedPaths, expanded: expanded)
    }

    // MARK: Going places

    fileprivate func openGridItem(at index: IndexPath) {
        guard let rows = rootNodes, rows.indices.contains(index.item) else { return }
        open(rows[index.item])
    }

    fileprivate func open(_ node: FolderNode) {
        // Leaving a folder for a file, a folder or an app, it's the row
        // opened that's picked when Mike comes back.
        var memory = memory
        memory.selected = [node.entry.path]
        onOpen?(node.entry, memory)
    }

    fileprivate func openSelection() {
        if let first = selectedNodes.first { open(first) }
    }

    func goUp() {
        guard let parent = FolderListing.parent(of: path) else { return }
        onBrowse?(parent, memory, path)
    }

    // MARK: Keys

    /// The keys the Finder has that the tables don't. True when it's used.
    fileprivate func handle(_ event: NSEvent) -> Bool {
        let mods = event.modifierFlags.intersection(.deviceIndependentFlagsMask)
        switch event.keyCode {
        case 49 where mods.isEmpty: // space
            toggleQuickLook()
            return true
        case 36 where mods.isEmpty, 76 where mods.isEmpty, 125 where mods == .command: // return, enter, ⌘↓
            openSelection()
            return true
        case 126 where mods == .command: // ⌘↑
            goUp()
            return true
        case 47 where mods == [.command, .shift]: // ⌘⇧.
            setShowHidden(!showHidden)
            return true
        default:
            return false
        }
    }

    // MARK: Quick Look

    /// What the space bar shows: the selected files on this Mac. Another
    /// Mac's aren't here, so there it opens the row instead.
    func quickLookPaths() -> [String] {
        away == nil ? selectedPaths : []
    }

    private func toggleQuickLook() {
        if QuickLookCoordinator.shared.isActive, let panel = QLPreviewPanel.shared(), panel.isVisible {
            panel.orderOut(nil)
            return
        }
        guard away == nil else { return openSelection() }
        let paths = quickLookPaths()
        guard !paths.isEmpty else { return }
        QuickLookCoordinator.shared.show(paths: paths, index: 0, from: mode == .list ? outline : grid)
    }

    /// Up and down through the rows with Quick Look up, as in the Finder.
    private func selectionMoved() {
        guard !restoring, QuickLookCoordinator.shared.isActive, let panel = QLPreviewPanel.shared(), panel.isVisible else { return }
        let paths = quickLookPaths()
        guard !paths.isEmpty else { return }
        QuickLookCoordinator.shared.show(paths: paths, index: 0, from: mode == .list ? outline : grid)
    }

    // MARK: Menu

    fileprivate func menu(for node: FolderNode?) -> NSMenu {
        let menu = NSMenu()
        if let node {
            let selection = selectedNodes.contains(node) ? selectedNodes : [node]
            contextNodes = selection
            menu.addItem(NSMenuItem(title: "Open", symbol: node.entry.isFolder ? "folder" : "sidebar.right", action: #selector(menuOpen), target: self))
            if away == nil {
                menu.addItem(NSMenuItem(title: node.entry.isFolder ? "Open in Finder" : "Open in its app", symbol: "arrow.up.forward.app", action: #selector(menuExternal), target: self))
                menu.addItem(NSMenuItem(title: "Reveal in Finder", symbol: "folder", action: #selector(menuReveal), target: self))
            }
            menu.addItem(NSMenuItem(title: selection.count > 1 ? "Copy paths" : "Copy path", symbol: "doc.on.doc", action: #selector(menuCopyPath), target: self))
            menu.addItem(.separator())
        }
        // The bar's button too, in the same words, where a right-click finds it.
        menu.addItem(NSMenuItem(title: mode == .list ? "Show as icons" : "Show as a list", symbol: mode == .list ? "square.grid.2x2" : "list.bullet", action: #selector(menuMode), target: self))
        let sortItem = NSMenuItem(title: "Sort by", symbol: "arrow.up.arrow.down", action: nil)
        let sorts = NSMenu()
        for (key, title, symbol) in [(FolderSort.Key.name, "Name", "textformat"), (.modified, "Date Modified", "calendar"), (.size, "Size", "scalemass")] {
            let item = NSMenuItem(title: title, symbol: symbol, action: #selector(menuSort), target: self)
            item.representedObject = key.rawValue
            item.state = sort.key == key ? .on : .off
            sorts.addItem(item)
        }
        sortItem.submenu = sorts
        menu.addItem(sortItem)
        menu.addItem(NSMenuItem(title: showHidden ? "Hide hidden files" : "Show hidden files", symbol: showHidden ? "eye.slash" : "eye", action: #selector(menuHidden), target: self))
        return menu
    }

    private var contextNodes: [FolderNode] = []

    @objc private func menuOpen() {
        if let first = contextNodes.first { open(first) }
    }

    @objc private func menuExternal() {
        contextNodes.forEach { onExternal?(URL(fileURLWithPath: $0.entry.path)) }
    }

    @objc private func menuReveal() {
        contextNodes.forEach { onReveal?($0.entry.path) }
    }

    @objc private func menuCopyPath() {
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(contextNodes.map(\.entry.path).joined(separator: "\n"), forType: .string)
    }

    @objc private func menuSort(_ item: NSMenuItem) {
        guard let raw = item.representedObject as? String, let key = FolderSort.Key(rawValue: raw) else { return }
        // Same column again turns it round; a new one starts its useful way.
        let ascending = sort.key == key ? !sort.ascending : key == .name
        setSort(FolderSort(key: key, ascending: ascending))
    }

    @objc private func menuMode() {
        let next: FolderViewMode = mode == .list ? .icons : .list
        // Saved for the bar's button and every other folder; shown here at once.
        FolderViewMode.current = next
        setMode(next)
    }

    @objc private func menuHidden() {
        setShowHidden(!showHidden)
    }

    /// ⌘C: the files themselves on this Mac, as the Finder copies them, and
    /// their paths as well for anything that wants text.
    @objc func copy(_ sender: Any?) {
        let nodes = selectedNodes
        guard !nodes.isEmpty else { return }
        let pasteboard = NSPasteboard.general
        pasteboard.clearContents()
        if away == nil {
            pasteboard.writeObjects(nodes.map { URL(fileURLWithPath: $0.entry.path) as NSURL })
        }
        pasteboard.setString(nodes.map(\.entry.path).joined(separator: "\n"), forType: .string)
    }

    // MARK: Icons

    fileprivate func icon(for entry: FolderEntry) -> NSImage {
        away == nil ? NSWorkspace.shared.icon(forFile: entry.path) : Self.icon(forRemote: entry)
    }

    private static func icon(forRemote entry: FolderEntry) -> NSImage {
        if entry.isFolder { return NSWorkspace.shared.icon(for: .folder) }
        let type = UTType(filenameExtension: (entry.name as NSString).pathExtension) ?? .data
        return NSWorkspace.shared.icon(for: type)
    }

    fileprivate var hasRealThumbnails: Bool { away == nil }

    // MARK: Outline data source

    func outlineView(_ outlineView: NSOutlineView, numberOfChildrenOfItem item: Any?) -> Int {
        guard let node = item as? FolderNode else { return rootNodes?.count ?? 0 }
        return node.children?.count ?? 0
    }

    func outlineView(_ outlineView: NSOutlineView, child index: Int, ofItem item: Any?) -> Any {
        guard let node = item as? FolderNode else { return rootNodes![index] }
        return node.children![index]
    }

    func outlineView(_ outlineView: NSOutlineView, isItemExpandable item: Any) -> Bool {
        (item as? FolderNode)?.entry.isFolder == true
    }

    func outlineView(_ outlineView: NSOutlineView, sortDescriptorsDidChange oldDescriptors: [NSSortDescriptor]) {
        guard let first = outlineView.sortDescriptors.first, let raw = first.key, let key = FolderSort.Key(rawValue: raw) else { return }
        setSort(FolderSort(key: key, ascending: first.ascending))
    }

    func outlineView(_ outlineView: NSOutlineView, pasteboardWriterForItem item: Any) -> (any NSPasteboardWriting)? {
        guard away == nil, let node = item as? FolderNode else { return nil }
        return FileDrag.writer(for: URL(fileURLWithPath: node.entry.path))
    }

    func outlineView(_ outlineView: NSOutlineView, typeSelectStringFor tableColumn: NSTableColumn?, item: Any) -> String? {
        tableColumn === nameColumn ? (item as? FolderNode)?.entry.name : nil
    }

    // MARK: Outline delegate

    func outlineViewItemDidExpand(_ notification: Notification) {
        guard let node = notification.userInfo?["NSObject"] as? FolderNode else { return }
        // Another Mac's folder takes a moment over the network, and would
        // open looking empty: its row spins until the listing comes.
        if away != nil, node.children == nil {
            loadingFolders.insert(node.entry.path)
            outline.reloadItem(node)
        }
        load(node.entry.path)
    }

    func outlineViewItemDidCollapse(_ notification: Notification) {
        guard let node = notification.userInfo?["NSObject"] as? FolderNode else { return }
        // It isn't showing, so it's not worth watching until it opens again.
        watchers.removeValue(forKey: node.entry.path)?.cancel()
        listings[node.entry.path] = nil
        if loadingFolders.remove(node.entry.path) != nil { outline.reloadItem(node) }
    }

    func outlineViewSelectionDidChange(_ notification: Notification) {
        selectionMoved()
    }

    func outlineView(_ outlineView: NSOutlineView, viewFor tableColumn: NSTableColumn?, item: Any) -> NSView? {
        guard let node = item as? FolderNode, let tableColumn else { return nil }
        let identifier = tableColumn.identifier
        let cell = (outlineView.makeView(withIdentifier: identifier, owner: nil) as? FolderRowCell) ?? FolderRowCell(withIcon: identifier == nameColumn.identifier, identifier: identifier)
        switch identifier {
        case nameColumn.identifier:
            cell.show(text: node.entry.name, icon: icon(for: node.entry), secondary: false, dimmed: node.entry.hidden, alignment: .left)
            // A picture or a video's own frame, as the Finder's list shows;
            // a code file's "thumbnail" would be a smudge of its text.
            if hasRealThumbnails, FolderThumbnails.isPicture(node.entry) { cell.loadThumbnail(of: node.entry) }
            if loadingFolders.contains(node.entry.path) { cell.showLoading() }
        case dateColumn.identifier:
            cell.show(text: node.entry.modifiedAt.map(Self.dateText) ?? "", icon: nil, secondary: true, dimmed: node.entry.hidden, alignment: .left)
        default:
            cell.show(text: node.entry.size.map(Self.sizeText) ?? "--", icon: nil, secondary: true, dimmed: node.entry.hidden, alignment: .right)
        }
        return cell
    }

    private static let dateFormatter: DateFormatter = {
        let formatter = DateFormatter()
        formatter.dateStyle = .medium
        formatter.timeStyle = .short
        formatter.doesRelativeDateFormatting = true
        return formatter
    }()

    private static func dateText(_ date: Date) -> String { dateFormatter.string(from: date) }

    private static func sizeText(_ size: Int) -> String {
        ByteCountFormatter.string(fromByteCount: Int64(size), countStyle: .file)
    }

    // MARK: Grid

    func collectionView(_ collectionView: NSCollectionView, numberOfItemsInSection section: Int) -> Int {
        rootNodes?.count ?? 0
    }

    func collectionView(_ collectionView: NSCollectionView, itemForRepresentedObjectAt indexPath: IndexPath) -> NSCollectionViewItem {
        let item = collectionView.makeItem(withIdentifier: FolderGridItem.identifier, for: indexPath)
        if let item = item as? FolderGridItem, let rows = rootNodes, rows.indices.contains(indexPath.item) {
            let entry = rows[indexPath.item].entry
            item.show(entry, icon: icon(for: entry), thumbnails: hasRealThumbnails)
        }
        return item
    }

    func collectionView(_ collectionView: NSCollectionView, layout collectionViewLayout: NSCollectionViewLayout, sizeForItemAt indexPath: IndexPath) -> NSSize {
        // As many tiles as fit, then shared out so the rows fill the pane.
        let room = max(zoomed(110), gridScroll.contentView.bounds.width - zoomed(16) - 1)
        let columns = max(1, floor(room / zoomed(116)))
        return NSSize(width: floor(room / columns), height: zoomed(128))
    }

    func collectionView(_ collectionView: NSCollectionView, canDragItemsAt indexPaths: Set<IndexPath>, with event: NSEvent) -> Bool { away == nil }

    func collectionView(_ collectionView: NSCollectionView, pasteboardWriterForItemAt indexPath: IndexPath) -> (any NSPasteboardWriting)? {
        guard away == nil, let rows = rootNodes, rows.indices.contains(indexPath.item) else { return nil }
        return FileDrag.writer(for: URL(fileURLWithPath: rows[indexPath.item].entry.path))
    }

    func collectionView(_ collectionView: NSCollectionView, didSelectItemsAt indexPaths: Set<IndexPath>) { selectionMoved() }

    fileprivate func node(atGridIndex index: IndexPath) -> FolderNode? {
        guard let rows = rootNodes, rows.indices.contains(index.item) else { return nil }
        return rows[index.item]
    }

    // MARK: Scripted

    var summary: String {
        let names = (rootNodes ?? []).prefix(40).map(\.entry.name).joined(separator: ", ")
        var words = "(\(mode.rawValue), \(rootNodes?.count ?? 0) rows, sort \(sort.key.rawValue) \(sort.ascending ? "up" : "down")"
        words += ", rows drawn \(mode == .list ? outline.numberOfRows : grid.numberOfItems(inSection: 0))"
        if !selectedPaths.isEmpty { words += ", selected " + selectedPaths.map { ($0 as NSString).lastPathComponent }.joined(separator: " + ") }
        if !note.stringValue.isEmpty { words += ", says \"\(note.stringValue)\"" }
        return words + "): " + names
    }

    private func row(named name: String) -> FolderNode? {
        nodes.values.first { $0.entry.name == name && (mode == .icons ? rootNodes?.contains($0) == true : outline.row(forItem: $0) >= 0) }
    }

    func select(name: String) -> Bool {
        guard let node = row(named: name) else { return false }
        select(paths: [node.entry.path])
        return true
    }

    func open(name: String) -> Bool {
        guard let node = row(named: name) else { return false }
        open(node)
        return true
    }

    func expand(name: String) -> Bool {
        guard let node = row(named: name), node.entry.isFolder else { return false }
        outline.expandItem(node)
        return true
    }

    /// A press and let-go on that row or tile through the window, `count`
    /// the click count, without moving Mike's pointer. It reaches the views'
    /// mouseDown as a real one does, though a table's own selecting ignores it
    /// (a click selects there, so "select" stands in for that).
    func debugClick(name: String, count: Int) -> Bool {
        guard let node = row(named: name), let window else { return false }
        let spot: NSPoint
        switch mode {
        case .list:
            let rect = outline.rect(ofRow: outline.row(forItem: node))
            spot = outline.convert(NSPoint(x: rect.minX + zoomed(40), y: rect.midY), to: nil)
        case .icons:
            guard let index = rootNodes?.firstIndex(of: node), let frame = grid.layoutAttributesForItem(at: IndexPath(item: index, section: 0))?.frame else { return false }
            spot = grid.convert(NSPoint(x: frame.midX, y: frame.midY), to: nil)
        }
        func mouse(_ type: NSEvent.EventType) -> NSEvent? {
            NSEvent.mouseEvent(with: type, location: spot, modifierFlags: [], timestamp: ProcessInfo.processInfo.systemUptime,
                               windowNumber: window.windowNumber, context: nil, eventNumber: 0, clickCount: count, pressure: 1)
        }
        guard let down = mouse(.leftMouseDown), let up = mouse(.leftMouseUp) else { return false }
        NSApp.postEvent(up, atStart: false)
        window.sendEvent(down)
        return true
    }

    /// A key on whichever view is showing, as the keyboard's would reach it.
    func debugKey(_ code: UInt16, characters: String, modifiers: NSEvent.ModifierFlags) {
        guard let window, let event = NSEvent.keyEvent(with: .keyDown, location: .zero, modifierFlags: modifiers, timestamp: ProcessInfo.processInfo.systemUptime, windowNumber: window.windowNumber, context: nil, characters: characters, charactersIgnoringModifiers: characters, isARepeat: false, keyCode: code) else { return }
        let target: NSView = mode == .list ? outline : grid
        window.makeFirstResponder(target)
        window.sendEvent(event)
    }

    /// The path bar's words, as they'd read now ("..." first if some are tucked).
    var debugPathBar: String { pathBar.debugWords }

    func debugPickCrumb(_ name: String) -> Bool { pathBar.debugPick(name) }

    /// Picks an item of the right-click menu of a row, or of the empty space.
    func debugChoose(_ title: String, name: String?) -> Bool {
        let menu = menu(for: name.flatMap { row(named: $0) })
        guard let index = menu.items.firstIndex(where: { $0.title == title }) else { return false }
        menu.performActionForItem(at: index)
        return true
    }

    /// The right-click menu of a row, or of the empty space.
    func debugMenu(name: String?) -> [String] {
        menu(for: name.flatMap { row(named: $0) }).items.map { $0.isSeparatorItem ? "---" : $0.title }
    }
}

/// The list. It hands the pane the keys the Finder has and a table doesn't,
/// and takes Quick Look's panel when it's first responder.
final class FolderOutlineView: NSOutlineView {
    weak var pane: FolderPaneView?

    override func mouseDown(with event: NSEvent) {
        super.mouseDown(with: event)
        guard event.clickCount == 2 else { return }
        let point = convert(event.locationInWindow, from: nil)
        let row = row(at: point)
        // A quick second click on a triangle is only folding it back.
        guard row >= 0, !frameOfOutlineCell(atRow: row).contains(point), let node = item(atRow: row) as? FolderNode else { return }
        pane?.open(node)
    }

    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }

    override func keyDown(with event: NSEvent) {
        if pane?.handle(event) != true { super.keyDown(with: event) }
    }

    override func menu(for event: NSEvent) -> NSMenu? {
        let row = row(at: convert(event.locationInWindow, from: nil))
        return pane?.menu(for: row >= 0 ? item(atRow: row) as? FolderNode : nil)
    }

    override func acceptsPreviewPanelControl(_ panel: QLPreviewPanel!) -> Bool { true }
    override func beginPreviewPanelControl(_ panel: QLPreviewPanel!) { QuickLookCoordinator.shared.begin(panel) }
    override func endPreviewPanelControl(_ panel: QLPreviewPanel!) { QuickLookCoordinator.shared.end(panel) }
}

/// The icons, likewise.
final class FolderCollectionView: NSCollectionView {
    weak var pane: FolderPaneView?

    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }

    override func keyDown(with event: NSEvent) {
        if pane?.handle(event) != true { super.keyDown(with: event) }
    }

    override func mouseDown(with event: NSEvent) {
        window?.makeFirstResponder(self)
        super.mouseDown(with: event)
        // NSCollectionView has no double-click of its own.
        if event.clickCount == 2, let index = indexPathForItem(at: convert(event.locationInWindow, from: nil)) {
            pane?.openGridItem(at: index)
        }
    }

    override func menu(for event: NSEvent) -> NSMenu? {
        let index = indexPathForItem(at: convert(event.locationInWindow, from: nil))
        return pane?.menu(for: index.flatMap { pane?.node(atGridIndex: $0) })
    }

    override func acceptsPreviewPanelControl(_ panel: QLPreviewPanel!) -> Bool { true }
    override func beginPreviewPanelControl(_ panel: QLPreviewPanel!) { QuickLookCoordinator.shared.begin(panel) }
    override func endPreviewPanelControl(_ panel: QLPreviewPanel!) { QuickLookCoordinator.shared.end(panel) }
}

/// The bar under the rows: each folder up to this one, to click. NSPathControl
/// squeezed a deep path down to a row of icons with no names in a narrow
/// pane, so this keeps the nearest folders' names and puts the rest behind
/// a "..." menu at the start.
final class FolderPathBar: NSView {
    /// A folder's path, and the one below it on the way here.
    var onPick: ((String, String?) -> Void)?

    private var crumbs: [FolderListing.Crumb] = []
    private var buttons: [NSButton] = []
    private var arrows: [NSImageView] = []
    private let more = NSButton()
    private let moreArrow = NSImageView()
    private var tucked = 0

    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }

    func show(_ crumbs: [FolderListing.Crumb]) {
        self.crumbs = crumbs
        (buttons + [more]).forEach { $0.removeFromSuperview() }
        (arrows + [moreArrow]).forEach { $0.removeFromSuperview() }
        buttons = crumbs.enumerated().map { index, crumb in
            let button = FolderPathButton(title: crumb.name, target: self, action: #selector(picked))
            button.tag = index
            style(button)
            // The folder it's in is the one thing here that isn't somewhere to go.
            button.contentTintColor = index == crumbs.count - 1 ? .labelColor : .secondaryLabelColor
            button.setTip(index == crumbs.count - 1 ? crumb.path : "Go to \(crumb.path)")
            addSubview(button)
            return button
        }
        arrows = crumbs.dropLast().map { _ in makeArrow() }
        arrows.forEach { addSubview($0) }
        more.title = "\u{2026}"
        more.target = self
        more.action = #selector(showTucked)
        style(more)
        more.contentTintColor = .secondaryLabelColor
        more.setTip("The folders above these")
        addSubview(more)
        moreArrow.image = makeArrow().image
        moreArrow.contentTintColor = .tertiaryLabelColor
        addSubview(moreArrow)
        needsLayout = true
    }

    private func style(_ button: NSButton) {
        button.isBordered = false
        button.font = .systemFont(ofSize: TypeScale.small)
        button.lineBreakMode = .byTruncatingMiddle
        button.alignment = .left
        button.imagePosition = .noImage
        button.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
    }

    private func makeArrow() -> NSImageView {
        let view = NSImageView()
        view.image = NSImage(systemSymbolName: "chevron.right", accessibilityDescription: nil)?
            .withSymbolConfiguration(.init(pointSize: TypeScale.small - 3, weight: .semibold))
        view.contentTintColor = .tertiaryLabelColor
        return view
    }

    override func layout() {
        super.layout()
        let arrowWidth = zoomed(14)
        let widths = buttons.map { ceil($0.intrinsicContentSize.width) }
        let moreWidth = ceil(more.intrinsicContentSize.width)
        tucked = FolderPathBar.tuckedCount(widths: widths, gap: arrowWidth, more: moreWidth + arrowWidth, room: bounds.width)
        var x: CGFloat = 0
        let height = ceil(buttons.first?.intrinsicContentSize.height ?? 16)
        let y = ((bounds.height - height) / 2).rounded()
        more.isHidden = tucked == 0
        moreArrow.isHidden = tucked == 0
        if tucked > 0 {
            more.frame = NSRect(x: x, y: y, width: moreWidth, height: height)
            x += moreWidth
            moreArrow.frame = NSRect(x: x, y: y, width: arrowWidth, height: height)
            x += arrowWidth
        }
        for (index, button) in buttons.enumerated() {
            let hidden = index < tucked
            button.isHidden = hidden
            if index < arrows.count { arrows[index].isHidden = hidden }
            guard !hidden else { continue }
            // Only the last can still be too long, on its own: it truncates.
            let width = min(widths[index], max(0, bounds.width - x))
            button.frame = NSRect(x: x, y: y, width: width, height: height)
            x += width
            if index < arrows.count {
                arrows[index].frame = NSRect(x: x, y: y, width: arrowWidth, height: height)
                x += arrowWidth
            }
        }
    }

    /// How many steps from the start go behind the menu for the rest to fit.
    /// The last one always stays.
    static func tuckedCount(widths: [CGFloat], gap: CGFloat, more: CGFloat, room: CGFloat) -> Int {
        guard !widths.isEmpty else { return 0 }
        func needed(from start: Int) -> CGFloat {
            widths[start...].reduce(0, +) + gap * CGFloat(widths.count - start - 1) + (start > 0 ? more : 0)
        }
        var start = 0
        while start < widths.count - 1, needed(from: start) > room { start += 1 }
        return start
    }

    @objc private func picked(_ sender: NSButton) {
        go(to: sender.tag)
    }

    private func go(to index: Int) {
        guard crumbs.indices.contains(index) else { return }
        onPick?(crumbs[index].path, crumbs.indices.contains(index + 1) ? crumbs[index + 1].path : nil)
    }

    @objc private func showTucked() {
        let menu = NSMenu()
        // Nearest first, as it reads going up from where the menu is.
        for index in (0..<tucked).reversed() {
            let item = NSMenuItem(title: crumbs[index].name, symbol: "folder", action: #selector(pickedTucked), target: self)
            item.tag = index
            menu.addItem(item)
        }
        menu.popUp(positioning: nil, at: NSPoint(x: more.frame.minX, y: more.frame.maxY), in: self)
    }

    @objc private func pickedTucked(_ item: NSMenuItem) {
        go(to: item.tag)
    }

    var debugWords: String {
        layoutSubtreeIfNeeded()
        let shown = buttons.filter { !$0.isHidden }.map(\.title)
        return (tucked > 0 ? ["\u{2026}"] : []).joined() + (tucked > 0 ? " > " : "") + shown.joined(separator: " > ")
    }

    func debugPick(_ name: String) -> Bool {
        guard let index = crumbs.firstIndex(where: { $0.name == name }) else { return false }
        go(to: index)
        return true
    }
}

/// Just its words, in the tint it was given.
private final class FolderPathButton: NSButton {
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }

    override var contentTintColor: NSColor? {
        didSet {
            attributedTitle = NSAttributedString(string: title, attributes: [
                .font: font ?? .systemFont(ofSize: TypeScale.small),
                .foregroundColor: contentTintColor ?? .secondaryLabelColor,
            ])
        }
    }

    convenience init(title: String, target: AnyObject?, action: Selector?) {
        self.init(frame: .zero)
        self.title = title
        self.target = target
        self.action = action
        setButtonType(.momentaryChange)
    }
}

/// A cell in the list: a name with its icon, or a grey date or size.
final class FolderRowCell: NSTableCellView {
    private let label = NSTextField(labelWithString: "")
    private let iconView = NSImageView()
    private let spinner = Spinner.make()
    private var thumbnail = FolderThumbnails.Loader()

    init(withIcon: Bool, identifier: NSUserInterfaceItemIdentifier) {
        super.init(frame: .zero)
        self.identifier = identifier
        label.translatesAutoresizingMaskIntoConstraints = false
        label.lineBreakMode = .byTruncatingMiddle
        label.cell?.truncatesLastVisibleLine = true
        addSubview(label)
        textField = label
        var constraints = [label.centerYAnchor.constraint(equalTo: centerYAnchor), label.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -zoomed(4))]
        if withIcon {
            iconView.translatesAutoresizingMaskIntoConstraints = false
            iconView.imageScaling = .scaleProportionallyUpOrDown
            addSubview(iconView)
            imageView = iconView
            spinner.translatesAutoresizingMaskIntoConstraints = false
            addSubview(spinner)
            constraints += [
                spinner.centerXAnchor.constraint(equalTo: iconView.centerXAnchor),
                spinner.centerYAnchor.constraint(equalTo: iconView.centerYAnchor),
                iconView.leadingAnchor.constraint(equalTo: leadingAnchor, constant: zoomed(2)),
                iconView.centerYAnchor.constraint(equalTo: centerYAnchor),
                iconView.widthAnchor.constraint(equalToConstant: zoomed(18)),
                iconView.heightAnchor.constraint(equalToConstant: zoomed(18)),
                label.leadingAnchor.constraint(equalTo: iconView.trailingAnchor, constant: zoomed(6)),
            ]
        } else {
            constraints.append(label.leadingAnchor.constraint(equalTo: leadingAnchor, constant: zoomed(4)))
        }
        NSLayoutConstraint.activate(constraints)
    }

    required init?(coder: NSCoder) { fatalError() }

    func show(text: String, icon: NSImage?, secondary: Bool, dimmed: Bool, alignment: NSTextAlignment) {
        thumbnail.cancel()
        label.stringValue = text
        label.alignment = alignment
        label.font = .systemFont(ofSize: secondary ? TypeScale.detail : TypeScale.label)
        label.textColor = secondary ? .secondaryLabelColor : .labelColor
        iconView.image = icon
        // Cells are reused: only a folder still being read shows the spinner.
        iconView.isHidden = false
        spinner.stopAnimation(nil)
        // Hidden files look it, as they do in the Finder.
        alphaValue = dimmed ? 0.55 : 1
    }

    /// A spinner for the icon, while this folder's listing is on its way.
    func showLoading() {
        iconView.isHidden = true
        spinner.startAnimation(nil)
    }

    func loadThumbnail(of entry: FolderEntry) {
        thumbnail.load(entry, side: zoomed(18), scale: window?.backingScaleFactor) { [weak self] image in
            self?.iconView.image = image
        }
    }
}

/// Quick Look's small pictures of files, kept once made. One loader per
/// view showing them: a view reused for another file drops what it asked for.
enum FolderThumbnails {
    private static let cache = NSCache<NSString, NSImage>()

    static func isPicture(_ entry: FolderEntry) -> Bool {
        guard !entry.isFolder, !entry.isPackage, let type = UTType(filenameExtension: (entry.name as NSString).pathExtension) else { return false }
        return type.conforms(to: .image) || type.conforms(to: .audiovisualContent)
    }

    struct Loader {
        private var request: QLThumbnailGenerator.Request?
        private var token = Token()

        final class Token {}

        mutating func cancel() {
            if let request { QLThumbnailGenerator.shared.cancel(request) }
            request = nil
            token = Token()
        }

        /// `show` is called on the main thread, right away for one already
        /// made, and not at all if Quick Look has none or it's cancelled.
        mutating func load(_ entry: FolderEntry, side: CGFloat, scale: CGFloat?, show: @escaping @MainActor (NSImage) -> Void) {
            cancel()
            let stamp = entry.modifiedAt?.timeIntervalSince1970 ?? 0
            let key = "\(entry.path)|\(stamp)|\(entry.size ?? 0)|\(side)" as NSString
            if let cached = cache.object(forKey: key) {
                MainActor.assumeIsolated { show(cached) }
                return
            }
            let scale = scale ?? MainActor.assumeIsolated { NSScreen.main?.backingScaleFactor } ?? 2
            let made = QLThumbnailGenerator.Request(fileAt: URL(fileURLWithPath: entry.path), size: CGSize(width: side, height: side), scale: scale, representationTypes: .thumbnail)
            request = made
            let asked = token
            QLThumbnailGenerator.shared.generateBestRepresentation(for: made) { [weak asked] representation, _ in
                guard let representation else { return }
                let image = representation.nsImage
                DispatchQueue.main.async {
                    cache.setObject(image, forKey: key)
                    // Gone if the view has moved on to another file.
                    if asked != nil { MainActor.assumeIsolated { show(image) } }
                }
            }
        }
    }
}

/// A tile in the icon view: a real thumbnail of the file where Quick Look
/// can make one (the frame of a video is the point of showing them this
/// way), or its icon, with the name under it.
final class FolderGridItem: NSCollectionViewItem {
    static let identifier = NSUserInterfaceItemIdentifier("folderGridItem")

    private let picture = NSImageView()
    private let label = NSTextField(wrappingLabelWithString: "")
    private let selection = NSView()
    private var thumbnail = FolderThumbnails.Loader()

    override func loadView() {
        let root = NSView()
        selection.wantsLayer = true
        selection.layer?.cornerRadius = zoomed(8)
        selection.layer?.cornerCurve = .continuous
        selection.isHidden = true
        picture.imageScaling = .scaleProportionallyUpOrDown
        picture.imageAlignment = .alignCenter
        label.alignment = .center
        label.maximumNumberOfLines = 2
        label.lineBreakMode = .byTruncatingMiddle
        label.cell?.truncatesLastVisibleLine = true
        label.isSelectable = false
        label.font = .systemFont(ofSize: TypeScale.small)
        for view in [selection, picture, label] {
            view.translatesAutoresizingMaskIntoConstraints = false
            root.addSubview(view)
        }
        let margin = zoomed(4)
        NSLayoutConstraint.activate([
            selection.leadingAnchor.constraint(equalTo: root.leadingAnchor, constant: margin),
            selection.trailingAnchor.constraint(equalTo: root.trailingAnchor, constant: -margin),
            selection.topAnchor.constraint(equalTo: root.topAnchor, constant: 0),
            selection.bottomAnchor.constraint(equalTo: root.bottomAnchor, constant: 0),
            picture.topAnchor.constraint(equalTo: root.topAnchor, constant: zoomed(6)),
            picture.centerXAnchor.constraint(equalTo: root.centerXAnchor),
            picture.widthAnchor.constraint(equalToConstant: zoomed(84)),
            picture.heightAnchor.constraint(equalToConstant: zoomed(84)),
            label.topAnchor.constraint(equalTo: picture.bottomAnchor, constant: zoomed(4)),
            label.leadingAnchor.constraint(equalTo: root.leadingAnchor, constant: margin * 2),
            label.trailingAnchor.constraint(equalTo: root.trailingAnchor, constant: -margin * 2),
        ])
        view = root
    }

    override var isSelected: Bool {
        didSet {
            selection.isHidden = !isSelected
            selection.layer?.backgroundColor = NSColor.selectedContentBackgroundColor.withAlphaComponent(0.45).cgColor
        }
    }

    override func prepareForReuse() {
        super.prepareForReuse()
        thumbnail.cancel()
        picture.image = nil
    }

    func show(_ entry: FolderEntry, icon: NSImage, thumbnails: Bool) {
        label.stringValue = entry.name
        view.alphaValue = entry.hidden ? 0.55 : 1
        picture.image = icon
        thumbnail.cancel()
        // A folder's icon is already its picture, and a package's its app's.
        guard thumbnails, !entry.isFolder, !entry.isPackage else { return }
        thumbnail.load(entry, side: zoomed(84), scale: view.window?.backingScaleFactor) { [weak self] image in
            self?.picture.image = image
        }
    }
}
