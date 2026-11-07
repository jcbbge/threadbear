import AppKit
import Highlightr
import SwiftUI
import ThreadbearCore
import UniformTypeIdentifiers

/// A text file in the pane: Markdown rendered as the transcript renders
/// it, code coloured (highlight.js through Highlightr, Xcode's colours),
/// plain text plain, all selectable. Quick Look showed these as text
/// nobody could select (Mike, 28 Oct). The bar's pencil switches to the
/// raw text, editable, with line numbers: what's typed is saved into the
/// file a moment after the typing stops, on ⌘S, and when Done. The file
/// is watched, so an agent's rewrite shows up by itself; if it lands
/// while there are unsaved edits, a bar asks which to keep rather than
/// losing either.
struct TextFileView: View {
    let url: URL
    /// Bumped by each open, so the same file opened again is read again.
    let opened: Int
    let editing: Bool
    /// The thread whose pane it's in: its links are followed in that thread
    /// (another Mac's copy names that Mac's files), not the selected one.
    var threadId: String? = nil
    /// Done didn't take (what's typed couldn't be saved): the pencil's
    /// state goes back to editing.
    var stayedEditing: () -> Void = {}
    /// Made on appear, once: SwiftUI runs a view's init on every update,
    /// and a controller a go would be a text view a go.
    @State private var controller: TextFileController?
    @Environment(\.colorScheme) private var colorScheme

    /// Whether the pane shows this file as text: by its name
    /// (PreviewRules), by the type macOS gives it, or, for a file it
    /// doesn't know, by its bytes (a `.ts` macOS takes for MPEG video).
    static func shows(_ path: String) -> Bool {
        if PreviewRules.viewer(forPath: path) == .text { return true }
        let url = URL(fileURLWithPath: path)
        let ext = url.pathExtension.lowercased()
        // Rich text is Quick Look's: its bytes aren't what Mike would edit.
        if ext == "rtf" || ext == "rtfd" { return false }
        if let type = try? url.resourceValues(forKeys: [.contentTypeKey]).contentType {
            if type.conforms(to: .text) { return true }
            if type.conforms(to: .image) || type.conforms(to: .audiovisualContent) || type.conforms(to: .pdf) { return false }
        }
        guard let handle = try? FileHandle(forReadingFrom: url) else { return false }
        defer { try? handle.close() }
        let sample = (try? handle.read(upToCount: 8192)) ?? Data()
        return !sample.isEmpty && PreviewRules.looksLikeText(sample)
    }

    /// Whether the bar offers Edit: a file too big to read whole can't be
    /// written back (TextFileDocument.limit).
    static func canEdit(_ path: String) -> Bool {
        let size = (try? FileManager.default.attributesOfItem(atPath: path)[.size] as? Int) ?? 0
        return size < TextFileDocument.limit
    }

    var body: some View {
        VStack(spacing: 0) {
            if let controller {
                if let conflict = controller.conflict {
                    ConflictBar(controller: controller, fileText: conflict)
                } else if let note = controller.note {
                    NoteBar(text: note)
                }
                TextFileHost(controller: controller)
            } else {
                Color.clear
            }
        }
        .onAppear {
            guard controller == nil else { return }
            let made = TextFileController(url: url)
            made.textView.threadId = threadId
            made.start(editing: editing, dark: colorScheme == .dark)
            controller = made
        }
        .onDisappear { controller?.stop() }
        .onChange(of: opened) { _, _ in controller?.check() }
        .onChange(of: editing) { _, editing in
            guard let controller else { return }
            controller.setEditing(editing)
            if controller.editing != editing { stayedEditing() }
        }
        .onChange(of: colorScheme) { _, scheme in controller?.setDark(scheme == .dark) }
    }
}

/// The file changed on disk while the editor holds unsaved edits: Mike
/// picks a side. Saving waits until he does, so neither is written over.
private struct ConflictBar: View {
    let controller: TextFileController
    let fileText: String

    var body: some View {
        // Two lines: the pane is narrow, and a row with the buttons on it
        // cut the words and the buttons both short.
        VStack(alignment: .leading, spacing: zoomed(8)) {
            HStack(spacing: zoomed(8)) {
                Image(systemName: "arrow.triangle.2.circlepath").foregroundStyle(.secondary)
                Text("Changed on disk while you were editing.")
                    .fixedSize(horizontal: false, vertical: true)
            }
            HStack(spacing: zoomed(8)) {
                Button("Take the file's") { controller.useFile(fileText) }
                    .tip("Show what's in the file now. What you typed since your last save goes.")
                Button("Keep mine") { controller.keepMine() }
                    .tip("Save what's here over the file.")
            }
        }
        .font(.system(size: TypeScale.label))
        .padding(.horizontal, zoomed(14))
        .padding(.vertical, zoomed(9))
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(.yellow.opacity(0.12))
    }
}

/// A grey line over the text: the file is cut off, or can't be edited.
private struct NoteBar: View {
    let text: String

    var body: some View {
        HStack(spacing: zoomed(8)) {
            Image(systemName: "info.circle").foregroundStyle(.secondary)
            Text(text).foregroundStyle(.secondary).lineLimit(2)
            Spacer(minLength: 0)
        }
        .font(.system(size: TypeScale.label))
        .padding(.horizontal, zoomed(14))
        .padding(.vertical, zoomed(7))
        .overlay(alignment: .bottom) { Rectangle().fill(Color(nsColor: Theme.hairline)).frame(height: 0.5) }
    }
}

/// Hosts the controller's scroll view. The controller outlives updates
/// (it's the view's state), so this only hands it over.
private struct TextFileHost: NSViewRepresentable {
    let controller: TextFileController

    func makeNSView(context: Context) -> NSScrollView { controller.scroll }
    func updateNSView(_ view: NSScrollView, context: Context) {}
}

/// The text view's and document's owner: what's shown, how (rendered,
/// coloured, editable), the saves and the watch. One per file open in
/// the pane (TextFileView is keyed by path).
@MainActor
@Observable
final class TextFileController: NSObject, NSTextViewDelegate {
    let url: URL
    let scroll: NSScrollView
    let textView: FileTextView
    @ObservationIgnored let document: TextFileDocument
    /// The file's text, while it's changed under unsaved edits.
    var conflict: String?
    var note: String?
    private(set) var editing = false
    @ObservationIgnored private var dark = false
    @ObservationIgnored private var saveTimer: DispatchWorkItem?
    @ObservationIgnored private var colourTimer: DispatchWorkItem?
    @ObservationIgnored private var terminating: Any?
    @ObservationIgnored private var started = false
    /// Which text was sent off to be rendered or coloured; a result for an
    /// older one is dropped.
    @ObservationIgnored private var generation = 0
    /// Typed since the last save or load: the view holds text the file
    /// doesn't. (Not just the view differing from the file: a cut-off
    /// file's view has a line saying so at the end.)
    @ObservationIgnored private var drafted = false

    /// The newest one, for the automation's `preview` command.
    nonisolated(unsafe) static weak var current: TextFileController?

    /// highlight.js gets slow on big files; past this, code is plain.
    static let highlightLimit = 400_000
    /// Rendering Markdown bigger than this happens off the main thread,
    /// with the plain text up meanwhile.
    static let renderInline = 64_000
    static let font = NSFont.monospacedSystemFont(ofSize: 12, weight: .regular)
    /// How long after the last keystroke the file is written.
    static let saveDelay: DispatchTimeInterval = .milliseconds(800)

    var isMarkdown: Bool { PreviewRules.isMarkdown(url.path) }
    /// A copy of another Mac's file draws no pictures from this Mac: its
    /// `![](/path)` are that Mac's paths (MarkdownRenderer.localPictures).
    var localPictures: Bool { !AppModel.shared.isRemoteCopy(url) }
    var language: String? { PreviewRules.codeLanguage(forPath: url.path) }

    init(url: URL) {
        self.url = url
        document = TextFileDocument(url: url)
        // The transcript's layout manager, for the boxes behind rendered
        // Markdown's code blocks and the pills behind inline code.
        let storage = NSTextStorage()
        let layoutManager = BackgroundLayoutManager()
        layoutManager.allowsNonContiguousLayout = false
        storage.addLayoutManager(layoutManager)
        let container = NSTextContainer(size: NSSize(width: 0, height: CGFloat.greatestFiniteMagnitude))
        container.widthTracksTextView = true
        container.lineFragmentPadding = 0
        layoutManager.addTextContainer(container)
        textView = FileTextView(frame: .zero, textContainer: container)
        scroll = NSScrollView()
        super.init()
        textView.base = url.deletingLastPathComponent()
        textView.minSize = .zero
        textView.maxSize = NSSize(width: CGFloat.greatestFiniteMagnitude, height: CGFloat.greatestFiniteMagnitude)
        textView.isVerticallyResizable = true
        textView.isHorizontallyResizable = false
        textView.autoresizingMask = [.width]
        textView.isEditable = false
        textView.isSelectable = true
        textView.drawsBackground = false
        textView.isRichText = false
        textView.allowsUndo = true
        textView.usesFindBar = true
        textView.isAutomaticQuoteSubstitutionEnabled = false
        textView.isAutomaticDashSubstitutionEnabled = false
        textView.isAutomaticTextReplacementEnabled = false
        textView.isAutomaticSpellingCorrectionEnabled = false
        textView.isContinuousSpellCheckingEnabled = false
        textView.isAutomaticLinkDetectionEnabled = false
        textView.smartInsertDeleteEnabled = false
        textView.linkTextAttributes = [.foregroundColor: NSColor.linkColor, .cursor: NSCursor.pointingHand]
        textView.delegate = self
        scroll.documentView = textView
        scroll.hasVerticalScroller = true
        scroll.drawsBackground = false
        // Line numbers, for the raw text while editing (not rendered Markdown).
        scroll.verticalRulerView = LineNumberRuler(textView: textView)
        scroll.hasVerticalRuler = true
        scroll.rulersVisible = false
        textView.onSave = { [weak self] in _ = self?.saveNow() }
    }

    // MARK: Lifecycle

    func start(editing: Bool, dark: Bool) {
        guard !started else { return }
        started = true
        Self.current = self
        self.dark = dark
        self.editing = editing
        if (try? document.load()) == nil {
            note = "This file couldn't be read."
            return
        }
        show(document.saved, keepPlace: false)
        // Opened again while it was being edited (Back to it, another
        // thread and back): it takes typing again.
        if editing { applyEditing() }
        document.watch(shown: { [weak self] in self?.shownText ?? "" }) { [weak self] change in
            self?.fileChanged(change)
        }
        // Quitting mid-edit: write what's typed before the app goes.
        terminating = NotificationCenter.default.addObserver(forName: NSApplication.willTerminateNotification, object: nil, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated { _ = self?.saveNow() }
        }
    }

    func stop() {
        saveNow()
        document.stopWatching()
        if let terminating { NotificationCenter.default.removeObserver(terminating) }
        terminating = nil
    }

    /// Reads the file again (the same file opened again).
    func check() {
        document.check()
    }

    func setDark(_ dark: Bool) {
        guard self.dark != dark else { return }
        self.dark = dark
        colour()
    }

    // MARK: Showing

    /// What the view holds now, as the file's text: what's typed while
    /// there's any, else what was loaded (a rendered view can't be typed in).
    private var shownText: String {
        editing && drafted ? textView.string : document.saved
    }

    /// Puts `text` in the view the way the mode wants it, keeping the
    /// scroll position (and the selection, when editing) for a reload.
    private func show(_ text: String, keepPlace: Bool) {
        generation += 1
        let place = scroll.contentView.bounds.origin
        let selection = textView.selectedRange()
        var text = text
        if document.truncated {
            text += "\n\n… the rest is cut off here. Open it in its app to see it all."
            note = "Only the start of this file is shown."
        }
        let storage = textView.textStorage!
        if !editing && isMarkdown {
            if text.utf8.count <= Self.renderInline {
                storage.setAttributedString(MarkdownRenderer.withLocalPictures(localPictures) { MarkdownRenderer.render(text).string })
                textView.textContainerInset = NSSize(width: 14, height: 12)
            } else {
                setPlain(text)
                let mine = generation
                let localPictures = localPictures
                DispatchQueue.global(qos: .userInitiated).async {
                    let rendered = MarkdownRenderer.withLocalPictures(localPictures) { MarkdownRenderer.render(text).string }
                    DispatchQueue.main.async {
                        MainActor.assumeIsolated {
                            guard mine == self.generation else { return }
                            let place = self.scroll.contentView.bounds.origin
                            self.textView.textStorage?.setAttributedString(rendered)
                            self.textView.textContainerInset = NSSize(width: 14, height: 12)
                            self.restore(place: place)
                        }
                    }
                }
            }
        } else {
            setPlain(text)
            colour()
        }
        if keepPlace {
            if editing { textView.setSelectedRange(NSRange(location: min(selection.location, storage.length), length: 0)) }
            restore(place: place)
        } else {
            textView.scrollToBeginningOfDocument(nil)
        }
    }

    private func setPlain(_ text: String) {
        textView.textStorage?.setAttributedString(NSAttributedString(string: text, attributes: Self.plainAttributes))
        textView.textContainerInset = NSSize(width: 10, height: 10)
        textView.typingAttributes = Self.plainAttributes
    }

    static var plainAttributes: [NSAttributedString.Key: Any] { [.font: font, .foregroundColor: NSColor.labelColor] }

    private func restore(place: NSPoint) {
        textView.layoutManager?.ensureLayout(for: textView.textContainer!)
        textView.sizeToFit()
        // Within the new text: a file rewritten shorter would have shown
        // nothing at the old offset.
        let clip = scroll.contentView
        let wanted = NSRect(origin: place, size: clip.bounds.size)
        clip.scroll(to: clip.constrainBoundsRect(wanted).origin)
        scroll.reflectScrolledClipView(clip)
    }

    /// Colours code in place: the attributes change, the characters and
    /// so the selection and undo stay. Plain text and rendered Markdown
    /// have nothing to colour.
    private func colour() {
        guard let language, !(isMarkdown && !editing) else { return }
        let text = textView.string
        guard text.utf8.count <= Self.highlightLimit else { return }
        let mine = generation
        CodeHighlighter.highlight(text, as: language, dark: dark) { [weak self] coloured in
            guard let self, let coloured, mine == self.generation, let storage = self.textView.textStorage,
                  coloured.string == storage.string else { return }
            storage.beginEditing()
            coloured.enumerateAttributes(in: NSRange(location: 0, length: coloured.length)) { attributes, range, _ in
                var attributes = attributes
                attributes[.font] = Self.font
                storage.setAttributes(attributes, range: range)
            }
            storage.endEditing()
        }
    }

    // MARK: Editing

    /// Done while what's typed can't be saved (a conflict waiting, the
    /// file unreadable) stays in editing, so the typed text is still there
    /// for the conflict bar or another try; TextFileView puts the pencil's
    /// state back to match.
    func setEditing(_ editing: Bool) {
        guard self.editing != editing else { return }
        if !editing, !saveNow() { return }
        // Leaving: nothing typed is waiting any more (saved, or a file that
        // never took typing).
        if !editing { drafted = false }
        self.editing = editing
        applyEditing()
        // Markdown changes shape; code and text only change whether they
        // take typing.
        if isMarkdown { show(document.saved, keepPlace: true) }
        if editing { textView.window?.makeFirstResponder(textView) }
    }

    /// The view's side of `editing`: whether it takes typing, the line
    /// numbers, and why a file that can't be written back can't.
    private func applyEditing() {
        if editing && !document.isEditable {
            // Shown, but never written back: it would change what's there.
            note = document.truncated ? "Only the start of this file is shown, so it can't be edited here."
                : "This file isn't UTF-8 text, so it can't be edited here."
        }
        textView.isEditable = editing && document.isEditable
        scroll.rulersVisible = editing
    }

    func textDidChange(_ notification: Notification) {
        guard editing else { return }
        drafted = true
        generation += 1
        scheduleSave()
        scroll.verticalRulerView?.needsDisplay = true
        colourTimer?.cancel()
        let item = DispatchWorkItem { [weak self] in self?.colour() }
        colourTimer = item
        DispatchQueue.main.asyncAfter(deadline: .now() + .milliseconds(250), execute: item)
    }

    private func scheduleSave() {
        saveTimer?.cancel()
        let item = DispatchWorkItem { [weak self] in _ = self?.saveNow() }
        saveTimer = item
        DispatchQueue.main.asyncAfter(deadline: .now() + Self.saveDelay, execute: item)
    }

    /// Writes what's typed, unless a conflict is waiting on Mike. If the
    /// file changed on disk since it was read (an agent's edit the watch
    /// hasn't reported yet), it isn't written over: the conflict bar asks.
    /// False when what's typed is still unsaved and could be lost.
    @discardableResult
    func saveNow() -> Bool {
        saveTimer?.cancel()
        saveTimer = nil
        guard editing, drafted else { return true }
        if let fileText = conflict {
            // Undone back to what was saved: nothing of Mike's left to keep,
            // so the file's side wins without asking.
            guard textView.string == document.saved else { return false }
            useFile(fileText)
            return true
        }
        // Typed, but the file can't take it now (too big, not UTF-8): it
        // stays on screen, read only, rather than go.
        guard document.isEditable else {
            applyEditing()
            note = cantSave
            return false
        }
        let typed = textView.string
        guard typed != document.saved else {
            drafted = false
            return true
        }
        do {
            let onDisk = try document.changedOnDisk()
            // It turned too big or not UTF-8: never written back. What's
            // typed stays on screen, read only, to copy out.
            guard document.isEditable else {
                applyEditing()
                note = cantSave
                return false
            }
            if let onDisk, onDisk != typed {
                conflict = onDisk
                return false
            }
        } catch {
            note = "Couldn't read the file to check it before saving: \(error.localizedDescription)"
            return false
        }
        do {
            try document.save(typed)
            drafted = false
            return true
        } catch {
            note = "Couldn't save: \(error.localizedDescription)"
            return false
        }
    }

    // MARK: The file changing under the view

    private func fileChanged(_ change: TextFileDocument.Change) {
        switch change {
        case .same:
            break
        case .reload(let text):
            conflict = nil
            drafted = false
            // It may have turned read only, or back.
            applyEditing()
            show(text, keepPlace: true)
        case .conflict(let text):
            conflict = text
            // It may have turned read only: no more typing it can't take.
            applyEditing()
        case .gone:
            conflict = nil
            note = "This file isn't there any more."
        }
    }

    /// The conflict bar's "Use the file's": the file wins.
    func useFile(_ text: String) {
        conflict = nil
        drafted = false
        document.adopt(text)
        // It may have become read only (too big, not UTF-8).
        applyEditing()
        show(text, keepPlace: true)
    }

    /// Its "Keep mine": what's typed is written over the file. The file's
    /// text is taken as read first, so the save doesn't find it changed
    /// and ask again. A file that's turned too big or not UTF-8 isn't
    /// written: what's typed stays on screen, read only.
    func keepMine() {
        if let onDisk = conflict { document.adopt(onDisk) }
        conflict = nil
        guard document.isEditable else {
            applyEditing()
            note = cantSave
            return
        }
        saveNow()
    }

    private var cantSave: String {
        (document.truncated ? "The file is now too big to edit here" : "The file is no longer UTF-8 text")
            + ", so what you typed can't be saved into it. Copy it out, or go Back to leave it."
    }

    /// For the automation: types `text` at the end, as a keystroke would.
    func insertAtEnd(_ text: String) {
        textView.setSelectedRange(NSRange(location: textView.string.utf16.count, length: 0))
        textView.insertText(text, replacementRange: textView.selectedRange())
    }
}

/// The pane's text view: a link in a rendered Markdown file to another
/// file opens that in the pane too (a `docs/protocol.md` beside it, or a
/// full path), as the transcript's links do; a web link goes to the
/// browser.
final class FileTextView: NSTextView {
    // Clicks count while Threadbear isn't the app in front (FirstClick.swift).
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }

    /// The file's folder, which relative links are from.
    var base: URL?
    /// ⌘S while it's being edited: save now rather than after the pause.
    var onSave: (() -> Void)?

    override func performKeyEquivalent(with event: NSEvent) -> Bool {
        let flags = event.modifierFlags.intersection(.deviceIndependentFlagsMask)
        if isEditable, window?.firstResponder === self, flags == .command, event.charactersIgnoringModifiers == "s", let onSave {
            onSave()
            return true
        }
        return super.performKeyEquivalent(with: event)
    }
    /// The thread whose pane this is in (TextFileView.threadId).
    var threadId: String?

    override func clicked(onLink link: Any, at charIndex: Int) {
        let app = AppModel.shared
        let saved = app.linkThreadId
        app.linkThreadId = threadId ?? saved
        defer { app.linkThreadId = saved }
        follow(link, at: charIndex)
    }

    private func follow(_ link: Any, at charIndex: Int) {
        let commandKey = NSApp.currentEvent?.modifierFlags.contains(.command) ?? false
        let url = (link as? URL) ?? (link as? String).flatMap(URL.init(string:))
        if let url, url.isFileURL {
            if MainActor.assumeIsolated({ AppModel.shared.openTranscriptFileLink(url, commandKey: commandKey) }) { return }
        } else if let url, url.scheme == nil, let base, !url.path.isEmpty {
            let target = URL(fileURLWithPath: url.path, relativeTo: base).standardizedFileURL
            if FileManager.default.fileExists(atPath: target.path),
               MainActor.assumeIsolated({ AppModel.shared.openTranscriptFileLink(FilePathRefs.withQuery(target, query: url.query, fragment: url.fragment), commandKey: commandKey) }) { return }
        }
        // A web page goes to the browser as AppKit does; any other scheme
        // (a file's `[Continue](x-apple.systempreferences:...)`) through
        // OpenGate, which asks first (Codex review, 7 Nov).
        guard let url, LinkPolicy.web(url) != nil else {
            if let url, url.scheme != nil { MainActor.assumeIsolated { _ = OpenGate.openLink(url) } } else { NSSound.beep() }
            return
        }
        super.clicked(onLink: link, at: charIndex)
    }
}

/// One Highlightr, used only on its own queue: highlight.js runs in a
/// JavaScriptCore context, which isn't for sharing across threads.
enum CodeHighlighter {
    private static let queue = DispatchQueue(label: "threadbear.code-highlighter", qos: .userInitiated)
    nonisolated(unsafe) private static var highlighter: Highlightr?
    nonisolated(unsafe) private static var theme: String?

    /// SwiftPM's Bundle.module stops the app if Highlightr's resource
    /// bundle isn't there, so look first (build-app.sh copies it into
    /// Contents/Resources; `swift test` and `swift run` have it beside
    /// the binary). Without it, code shows plain.
    private static let available: Bool = {
        let name = "Highlightr_Highlightr.bundle"
        return [Bundle.main.resourceURL, Bundle.main.bundleURL, Bundle.main.executableURL?.deletingLastPathComponent()]
            .compactMap { $0?.appendingPathComponent(name).path }
            .contains { FileManager.default.fileExists(atPath: $0) }
    }()

    static func highlight(_ code: String, as language: String, dark: Bool, done: @escaping @MainActor (NSAttributedString?) -> Void) {
        guard available else { return }
        queue.async {
            if highlighter == nil { highlighter = Highlightr() }
            let wanted = dark ? "xcode-dark" : "xcode"
            if theme != wanted, let highlighter {
                highlighter.setTheme(to: wanted)
                highlighter.theme.setCodeFont(TextFileController.font)
                theme = wanted
            }
            let coloured = highlighter?.highlight(code, as: language, fastRender: true)
            DispatchQueue.main.async { MainActor.assumeIsolated { done(coloured) } }
        }
    }
}
