import AppKit
import XCTest
@testable import Threadbear
import ThreadbearCore

/// The folder browser in a window of its own, on a real folder or a made-up
/// one, with real key and mouse events through the window.
@MainActor
final class FolderBrowserTests: XCTestCase {
    private var root: URL!
    private var window: NSWindow!

    override func setUp() async throws {
        root = FileManager.default.temporaryDirectory.appendingPathComponent("folder-browser-\(UUID().uuidString)")
        let fm = FileManager.default
        try fm.createDirectory(at: root.appendingPathComponent("exports/deep"), withIntermediateDirectories: true)
        try fm.createDirectory(at: root.appendingPathComponent("Tool.app/Contents"), withIntermediateDirectories: true)
        try Data("a".utf8).write(to: root.appendingPathComponent("exports/clip.txt"))
        try Data("a".utf8).write(to: root.appendingPathComponent("notes.md"))
        try Data("a".utf8).write(to: root.appendingPathComponent(".env"))
        UserDefaults.standard.removeObject(forKey: "folderBrowserShowHidden")
        UserDefaults.standard.removeObject(forKey: "folderBrowserSort")
    }

    override func tearDown() async throws {
        FolderPaneView.current?.close()
        window?.orderOut(nil)
        try? FileManager.default.removeItem(at: root)
        UserDefaults.standard.removeObject(forKey: "folderBrowserShowHidden")
        UserDefaults.standard.removeObject(forKey: "folderBrowserSort")
    }

    private func pane(path: String? = nil, memory: FolderMemory = FolderMemory(), mode: FolderViewMode = .list, away: String? = nil,
                      source: FolderPaneView.Source? = nil) -> FolderPaneView {
        let source = source ?? { folder in try FolderListing.read(folder) }
        let view = FolderPaneView(path: path ?? root.path, away: away, memory: memory, mode: mode, source: source)
        window = NSWindow(contentRect: NSRect(x: -3000, y: 0, width: 600, height: 500), styleMask: [.titled], backing: .buffered, defer: false)
        window.contentView = view
        view.frame = window.contentView!.bounds
        view.layoutSubtreeIfNeeded()
        return view
    }

    private func settled(_ view: FolderPaneView, until check: () -> Bool) async throws {
        for _ in 0..<200 where !check() {
            try await Task.sleep(for: .milliseconds(20))
        }
        XCTAssertTrue(check(), "never settled: \(view.summary)")
    }

    private func key(_ code: UInt16, _ characters: String = "", _ flags: NSEvent.ModifierFlags = []) -> NSEvent {
        NSEvent.keyEvent(with: .keyDown, location: .zero, modifierFlags: flags, timestamp: 0, windowNumber: window.windowNumber, context: nil,
                         characters: characters, charactersIgnoringModifiers: characters, isARepeat: false, keyCode: code)!
    }

    private func outline(in view: NSView) -> FolderOutlineView {
        var pending: [NSView] = [view]
        while let next = pending.popLast() {
            if let found = next as? FolderOutlineView { return found }
            pending += next.subviews
        }
        fatalError("no list")
    }

    func testAFolderListsFoldersFirstAndHidesDotfiles() async throws {
        let view = pane()
        try await settled(view) { view.summary.contains("3 rows") }
        XCTAssertTrue(view.summary.hasSuffix("exports, notes.md, Tool.app"), view.summary)
    }

    func testHiddenFilesComeAndGoWithTheFindersKey() async throws {
        let view = pane()
        try await settled(view) { view.summary.contains("3 rows") }
        window.makeFirstResponder(outline(in: view))
        outline(in: view).keyDown(with: key(47, ".", [.command, .shift]))
        XCTAssertTrue(view.summary.contains(".env"), view.summary)
        outline(in: view).keyDown(with: key(47, ".", [.command, .shift]))
        XCTAssertFalse(view.summary.contains(".env"), view.summary)
    }

    func testFilesAppearAsTheyAreMade() async throws {
        let view = pane()
        try await settled(view) { view.summary.contains("3 rows") }
        try Data("a".utf8).write(to: root.appendingPathComponent("rendered.mp4"))
        try await settled(view) { view.summary.contains("rendered.mp4") }
        try FileManager.default.removeItem(at: root.appendingPathComponent("notes.md"))
        try await settled(view) { !view.summary.contains("notes.md") }
    }

    private func press(_ view: NSView, at point: NSPoint, count: Int) {
        let spot = view.convert(point, to: nil)
        func mouse(_ type: NSEvent.EventType) -> NSEvent {
            NSEvent.mouseEvent(with: type, location: spot, modifierFlags: [], timestamp: ProcessInfo.processInfo.systemUptime, windowNumber: window.windowNumber,
                               context: nil, eventNumber: 0, clickCount: count, pressure: 1)!
        }
        NSApp.postEvent(mouse(.leftMouseUp), atStart: false)
        view.mouseDown(with: mouse(.leftMouseDown))
    }

    func testADoubleClickOnARowOpensItAndAClickDoesnt() async throws {
        let view = pane()
        try await settled(view) { view.summary.contains("3 rows") }
        var opened: [String] = []
        view.onOpen = { entry, _ in opened.append(entry.name) }
        let list = outline(in: view)
        let row = list.rect(ofRow: 1) // notes.md
        press(list, at: NSPoint(x: row.minX + 60, y: row.midY), count: 1)
        XCTAssertEqual(opened, [])
        press(list, at: NSPoint(x: row.minX + 60, y: row.midY), count: 2)
        XCTAssertEqual(opened, ["notes.md"])
    }

    /// Folding a folder quickly open and shut isn't going into it.
    func testADoubleClickOnATriangleDoesntOpen() async throws {
        let view = pane()
        try await settled(view) { view.summary.contains("3 rows") }
        var opened: [String] = []
        view.onOpen = { entry, _ in opened.append(entry.name) }
        let list = outline(in: view)
        let triangle = list.frameOfOutlineCell(atRow: 0) // exports
        XCTAssertFalse(triangle.isEmpty)
        press(list, at: NSPoint(x: triangle.midX, y: triangle.midY), count: 2)
        XCTAssertEqual(opened, [])
    }

    func testADoubleClickOnATileOpensIt() async throws {
        let view = pane(mode: .icons)
        try await settled(view) { view.summary.contains("rows drawn 3") }
        var opened: [String] = []
        view.onOpen = { entry, _ in opened.append(entry.name) }
        var pending: [NSView] = [view]
        var grid: FolderCollectionView?
        while let next = pending.popLast() {
            if let found = next as? FolderCollectionView { grid = found }
            pending += next.subviews
        }
        let tiles = try XCTUnwrap(grid)
        tiles.layoutSubtreeIfNeeded()
        let frame = try XCTUnwrap(tiles.layoutAttributesForItem(at: IndexPath(item: 1, section: 0))?.frame) // notes.md
        press(tiles, at: NSPoint(x: frame.midX, y: frame.midY), count: 1)
        XCTAssertEqual(opened, [])
        press(tiles, at: NSPoint(x: frame.midX, y: frame.midY), count: 2)
        XCTAssertEqual(opened, ["notes.md"])
    }

    func testReturnOpensTheSelectionAndCommandUpGoesToTheParent() async throws {
        let inner = root.appendingPathComponent("exports").path
        let view = pane(path: inner)
        try await settled(view) { view.summary.contains("2 rows") }
        var opened: [String] = []
        var browsed: [(String, String?)] = []
        view.onOpen = { entry, _ in opened.append(entry.name) }
        view.onBrowse = { folder, _, selecting in browsed.append((folder, selecting)) }
        XCTAssertTrue(view.select(name: "clip.txt"))
        let list = outline(in: view)
        list.keyDown(with: key(36, "\r"))
        XCTAssertEqual(opened, ["clip.txt"])
        list.keyDown(with: key(126, "\u{F700}", [.command]))
        XCTAssertEqual(browsed.first?.0, root.path)
        XCTAssertEqual(browsed.first?.1, inner, "the folder come up out of is picked there")
    }

    func testTheSpaceBarLooksAtWhatsSelected() async throws {
        let view = pane()
        try await settled(view) { view.summary.contains("3 rows") }
        var looked: ([String], Int)?
        QuickLookCoordinator.shared.debugOpened = { looked = ($0, $1) }
        defer { QuickLookCoordinator.shared.debugOpened = nil }
        outline(in: view).keyDown(with: key(49, " "))
        XCTAssertNil(looked, "nothing selected, nothing to look at")
        XCTAssertTrue(view.select(name: "notes.md"))
        outline(in: view).keyDown(with: key(49, " "))
        XCTAssertEqual(looked?.0, [root.appendingPathComponent("notes.md").path])
    }

    /// Back finds the folder as it was left: its open rows and what was picked.
    func testMemoryComesBack() async throws {
        let view = pane()
        try await settled(view) { view.summary.contains("3 rows") }
        XCTAssertTrue(view.expand(name: "exports"))
        try await settled(view) { view.summary.contains("rows drawn 5") }
        XCTAssertTrue(view.select(name: "clip.txt"))
        var kept: FolderMemory?
        view.onOpen = { _, memory in kept = memory }
        XCTAssertTrue(view.open(name: "clip.txt"))
        let memory = try XCTUnwrap(kept)
        XCTAssertEqual(memory.expanded, [root.appendingPathComponent("exports").path])
        XCTAssertEqual(memory.selected, [root.appendingPathComponent("exports/clip.txt").path])
        view.close()

        let again = pane(memory: memory)
        try await settled(again) { again.summary.contains("rows drawn 5") && again.summary.contains("selected clip.txt") }
    }

    /// An icon-view double-click goes through the same way.
    func testIconsShowTheSameRows() async throws {
        let view = pane(mode: .icons)
        try await settled(view) { view.summary.contains("3 rows") && view.summary.contains("rows drawn 3") }
        XCTAssertTrue(view.select(name: "notes.md"))
        view.setMode(.list)
        XCTAssertTrue(view.summary.contains("selected notes.md"), "the selection carries across: \(view.summary)")
    }

    func testAMissingFolderSaysSo() async throws {
        let view = pane(path: root.appendingPathComponent("never-there").path)
        try await settled(view) { view.summary.contains("isn't there any more") }
    }

    func testAnEmptyFolderSaysSo() async throws {
        let empty = root.appendingPathComponent("nothing").path
        try FileManager.default.createDirectory(atPath: empty, withIntermediateDirectories: true)
        let view = pane(path: empty)
        try await settled(view) { view.summary.contains("Nothing in this folder") }
    }

    /// Another Mac's runner from before files.list.
    func testAnOldRunnerSaysItNeedsUpdating() async throws {
        let view = pane(path: "/Users/bruce/clips", away: "bruce") { _ in throw RPCError.server(code: RPCError.methodNotFound, message: "Method not found") }
        try await settled(view) { view.summary.contains("bruce's runner needs updating") }
    }

    /// Another Mac's rows open, but nothing here can look at or touch them.
    func testAnotherMacsFilesHaveNoLocalActions() async throws {
        let view = pane(path: "/Users/bruce/clips", away: "bruce") { path in
            FolderContents(path: path, entries: [FolderEntry(name: "a.mp4", path: path + "/a.mp4", isFolder: false)])
        }
        try await settled(view) { view.summary.contains("1 rows") }
        XCTAssertTrue(view.select(name: "a.mp4"))
        XCTAssertEqual(view.quickLookPaths(), [])
        var opened: [String] = []
        view.onOpen = { entry, _ in opened.append(entry.name) }
        outline(in: view).keyDown(with: key(49, " "))
        XCTAssertEqual(opened, ["a.mp4"], "the space bar opens it in the pane instead")
    }

    /// The bar's button is in the right-click menu too, on a row and on the
    /// empty space, in whichever view is showing.
    func testTheRightClickMenuSwapsTheView() async throws {
        FolderViewMode.current = .list
        defer { UserDefaults.standard.removeObject(forKey: FolderViewMode.key) }
        let view = pane()
        try await settled(view) { view.summary.contains("3 rows") }
        XCTAssertTrue(view.debugMenu(name: "notes.md").contains("Show as icons"))
        XCTAssertTrue(view.debugMenu(name: nil).contains("Show as icons"))

        XCTAssertTrue(view.debugChoose("Show as icons", name: "notes.md"))
        XCTAssertTrue(view.summary.hasPrefix("(icons"), view.summary)
        XCTAssertEqual(FolderViewMode.current, .icons, "kept for the bar's button and the next folder")

        XCTAssertTrue(view.debugMenu(name: nil).contains("Show as a list"))
        XCTAssertTrue(view.debugChoose("Show as a list", name: nil))
        XCTAssertTrue(view.summary.hasPrefix("(list"), view.summary)
        XCTAssertEqual(FolderViewMode.current, .list)
    }

    // MARK: The path bar

    func testThePathBarKeepsTheNearestNames() {
        let widths: [CGFloat] = [40, 40, 40, 40]
        XCTAssertEqual(FolderPathBar.tuckedCount(widths: widths, gap: 10, more: 20, room: 500), 0)
        XCTAssertEqual(FolderPathBar.tuckedCount(widths: widths, gap: 10, more: 20, room: 190), 0, "exactly fits")
        XCTAssertEqual(FolderPathBar.tuckedCount(widths: widths, gap: 10, more: 20, room: 189), 1)
        XCTAssertEqual(FolderPathBar.tuckedCount(widths: widths, gap: 10, more: 20, room: 100), 3, "the last always stays")
        XCTAssertEqual(FolderPathBar.tuckedCount(widths: widths, gap: 10, more: 20, room: 10), 3)
        XCTAssertEqual(FolderPathBar.tuckedCount(widths: [], gap: 10, more: 20, room: 10), 0)
    }

    // MARK: Back

    private func thread(_ id: String = "t1") -> ThreadSummary {
        ThreadSummary(id: id, title: "", cwd: "/tmp", status: .idle, createdAt: .distantPast, updatedAt: .distantPast)
    }

    func testBackGoesThroughTheFoldersThenOutToTheSection() {
        let app = AppModel()
        let thread = thread()
        app.preview(path: root.path, in: thread)
        XCTAssertEqual(app.panePreview[thread.id]?.folderPath, root.path)

        let exports = root.appendingPathComponent("exports").path
        let leaving = FolderMemory(selected: [exports], expanded: [])
        app.browseFolder(exports, from: leaving, showing: app.panePreview[thread.id]!, in: thread)
        XCTAssertEqual(app.panePreview[thread.id]?.folderPath, exports)
        XCTAssertEqual(app.panePreview[thread.id]?.title, "exports")

        let clip = FolderEntry(name: "clip.txt", path: exports + "/clip.txt", isFolder: false)
        app.openFromFolder(clip, from: FolderMemory(selected: [clip.path]), showing: app.panePreview[thread.id]!, in: thread)
        XCTAssertEqual(app.panePreview[thread.id]?.fileURL?.path, clip.path)

        app.previewBack(in: thread.id)
        XCTAssertEqual(app.panePreview[thread.id]?.folderPath, exports)
        XCTAssertEqual(app.panePreview[thread.id]?.folderMemory.selected, [clip.path], "back on the file it came from")

        app.previewBack(in: thread.id)
        XCTAssertEqual(app.panePreview[thread.id]?.folderPath, root.path)
        XCTAssertEqual(app.panePreview[thread.id]?.folderMemory, leaving)

        app.previewBack(in: thread.id)
        XCTAssertNil(app.panePreview[thread.id], "and then out to the section")
    }

    /// The bug Wayne hit (6 Nov): the rail's Files panel shows the thread's
    /// folder without storing a preview, so a click there found none and
    /// did nothing. A file opened from it shows over it, in the Files
    /// section, with Back to the folder; so does a folder, and it works
    /// with another section's file already stored too.
    func testAClickInTheFilesPanelOpensTheFile() {
        let app = AppModel()
        let thread = thread()
        let files = PaneSection.panel(BuiltinPanels.files)
        let shown = PanePreview(target: .folder(root.path), title: "Files", from: files)
        XCTAssertNil(app.panePreview[thread.id])

        let notes = FolderEntry(name: "notes.md", path: root.appendingPathComponent("notes.md").path, isFolder: false)
        app.openFromFolder(notes, from: FolderMemory(selected: [notes.path]), showing: shown, in: thread)
        XCTAssertEqual(app.panePreview[thread.id]?.fileURL?.path, notes.path)
        XCTAssertEqual(app.panePreview[thread.id]?.from, files)
        app.previewBack(in: thread.id)
        XCTAssertEqual(app.panePreview[thread.id]?.folderPath, root.path, "Back is the folder")
        XCTAssertEqual(app.panePreview[thread.id]?.folderMemory.selected, [notes.path])

        // Something from Highlights already open: the Files click still goes to Files.
        app.closePreview(in: thread.id)
        app.preview(path: notes.path, in: thread)
        let exports = FolderEntry(name: "exports", path: root.appendingPathComponent("exports").path, isFolder: true)
        app.openFromFolder(exports, from: FolderMemory(), showing: shown, in: thread)
        XCTAssertEqual(app.panePreview[thread.id]?.folderPath, exports.path)
        XCTAssertEqual(app.panePreview[thread.id]?.from, files)
    }

    /// Another Mac's thread: its Files panel says whose folder it is, and a
    /// file opened from it is fetched over Files too, not over whichever
    /// section the thread would pick.
    func testTheFilesPanelOnAnotherMac() {
        let app = AppModel()
        var thread = thread()
        thread.runnerId = "bruce"
        let shown = app.filesPanelPreview(for: thread)
        XCTAssertEqual(shown.folderPath, "/tmp")
        XCTAssertNotNil(shown.away)
        XCTAssertNil(app.filesPanelPreview(for: self.thread()).away, "this Mac's own")

        let notes = FolderEntry(name: "notes.md", path: "/tmp/notes.md", isFolder: false)
        app.openFromFolder(notes, from: FolderMemory(selected: [notes.path]), showing: shown, in: thread)
        XCTAssertEqual(app.panePreview[thread.id]?.from, .panel(BuiltinPanels.files))
        XCTAssertEqual(app.panePreview[thread.id]?.back.last?.folderPath, "/tmp", "Back is the folder")
    }

    /// A file opened from outside the browser has only the section behind it.
    func testALinkFromOutsideStartsAfresh() {
        let app = AppModel()
        let thread = thread()
        app.preview(path: root.path, in: thread)
        app.browseFolder(root.appendingPathComponent("exports").path, from: FolderMemory(), showing: app.panePreview[thread.id]!, in: thread)
        app.preview(path: root.appendingPathComponent("notes.md").path, in: thread)
        XCTAssertEqual(app.panePreview[thread.id]?.back, [])
    }

    /// The bug Mike hit: a folder went to Quick Look, which drew its icon.
    func testAFolderLinkOpensTheBrowserNotQuickLook() {
        let app = AppModel()
        let thread = thread()
        app.preview(path: root.path, in: thread)
        XCTAssertEqual(app.panePreview[thread.id]?.target, .folder(root.path))
        XCTAssertEqual(app.panePreview[thread.id]?.externalURL?.path, root.path, "Open is the Finder")
        app.preview(path: root.appendingPathComponent("notes.md").path, in: thread)
        XCTAssertEqual(app.panePreview[thread.id]?.target, .file(root.appendingPathComponent("notes.md").path))
    }

    func testAnotherMacsFolderHasNothingToOpenHere() {
        var preview = PanePreview(target: .folder("/Users/bruce/clips"), title: "clips", from: .highlights)
        XCTAssertNotNil(preview.externalURL)
        preview.away = "bruce"
        XCTAssertNil(preview.externalURL)
    }

    func testARemoteFolderErrorIsRecognised() {
        XCTAssertTrue(AppModel.isFolderError(RPCError.server(code: -32602, message: "Not a file: /a")))
        XCTAssertFalse(AppModel.isFolderError(RPCError.server(code: -32602, message: "No such file: /a")))
        XCTAssertFalse(AppModel.isFolderError(RPCError.disconnected(nil)))
    }
}
