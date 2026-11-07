import Foundation

/// The Highlights section's groups, top to bottom: pins, files, links and
/// pull requests, commits, then the files the thread edited. Built from
/// what `threads.highlights` answered.
public struct HighlightSections: Sendable, Hashable {
    public var brief: String?
    public var pinned: [Highlight] = []
    public var files: [Highlight] = []
    /// Links and pull requests.
    public var links: [Highlight] = []
    public var commits: [Highlight] = []
    /// Edited files not already listed as a pin or a file.
    public var edited: [String] = []

    /// How many of a long group show before "Show all": a long thread can
    /// have fifteen commits, which pushed Files and Links off screen.
    public static let commitLimit = 5
    public static let linkLimit = 10
    /// The runner keeps a thread's newest 20 sub-agents.
    public static let subagentLimit = 5
    /// Cards shown in a column of a project's board before "N more".
    public static let taskLimit = 4

    /// The first `limit` of a group (they come newest first), and how many
    /// more "Show all" would add. All of them once Mike has asked.
    public static func capped<T>(_ items: [T], limit: Int, showAll: Bool) -> (shown: [T], more: Int) {
        guard !showAll, items.count > limit else { return (items, 0) }
        return (Array(items.prefix(limit)), items.count - limit)
    }

    /// The brief's bullets: the librarian writes "- " lines (Mike found a
    /// paragraph too long to glance at, 28 Oct). An older paragraph brief
    /// comes back as one point.
    public static func points(_ brief: String) -> [String] {
        brief.split(whereSeparator: \.isNewline)
            .map { line in
                var text = line.trimmingCharacters(in: .whitespaces)
                if let first = text.first, "-•*".contains(first) { text = String(text.dropFirst()).trimmingCharacters(in: .whitespaces) }
                return text
            }
            .filter { !$0.isEmpty }
    }

    /// Nothing to show but the empty line.
    public var isEmpty: Bool {
        brief == nil && pinned.isEmpty && files.isEmpty && links.isEmpty && commits.isEmpty && edited.isEmpty
    }

    public static func build(_ highlights: ThreadHighlights) -> HighlightSections {
        var sections = HighlightSections()
        let brief = highlights.brief?.text.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        sections.brief = brief.isEmpty ? nil : brief
        for item in highlights.highlights {
            if item.isPinned {
                sections.pinned.append(item)
                continue
            }
            switch item.kind {
            case .file: sections.files.append(item)
            case .link, .pr: sections.links.append(item)
            case .commit: sections.commits.append(item)
            case .other:
                // A kind from a newer runner: as a file or a link if it's
                // one, else nothing this app knows how to open.
                if item.path != nil { sections.files.append(item) } else if item.url != nil { sections.links.append(item) }
            }
        }
        let listed = Set((sections.pinned + sections.files).compactMap(\.path))
        var seen = Set<String>()
        sections.edited = highlights.edited.filter { !listed.contains($0) && seen.insert($0).inserted }
        return sections
    }
}

/// What each folding heading in Highlights is remembered as. A fold holds
/// for every thread, so Sub-agents stays out of the way once Mike has put
/// it away (asked 3 Nov); a project's is its own, as only its threads show it.
public enum HighlightFold {
    public static let needsYou = "needsYou"
    public static let scheduled = "scheduled"
    public static let subagents = "subagents"
    public static let startedThreads = "startedThreads"
    public static let pinned = "pinned"
    public static let files = "files"
    public static let links = "links"
    public static let changes = "changes"
    public static func project(_ id: String) -> String { "project:\(id)" }
}

/// The links of the projects a thread is in, for the top of its
/// Highlights: in the thread's order, leaving out archived projects and
/// ones with no links.
/// The thread's projects at the top of Highlights: each one's icon and
/// name with why it's there behind an ⓘ, then its links. Every project the
/// thread is in, links or not, so a wrong guess of the librarian's shows
/// (Mike asked 30 Oct, after a photo thread sat in the components
/// directory).
public enum HighlightProjects {
    public struct Row: Sendable, Equatable, Identifiable {
        public var project: Project
        public var membership: ThreadProject
        public var id: String { project.id }
    }

    public static func build(thread: ThreadSummary, project: (String) -> Project?) -> [Row] {
        var seen = Set<String>()
        return thread.projects.compactMap { member in
            guard seen.insert(member.id).inserted, let p = project(member.id), !p.archived else { return nil }
            return Row(project: p, membership: member)
        }
    }

    /// Who put it there, then its reason when it has one.
    public static func why(_ m: ThreadProject) -> (who: String, reason: String?) {
        let who = switch m.by {
        case .mike: "You put it here."
        case .agent: "Its agent put it here."
        case .librarian: m.pinned ? "The librarian put it here, and you kept it." : "The librarian put it here."
        }
        return (who, m.why)
    }

    /// A guess of the librarian's nobody has kept yet: it can be kept.
    public static func canKeep(_ m: ThreadProject) -> Bool {
        m.by == .librarian && !m.pinned
    }
}

/// Where a click on a highlight, a list panel's row or a transcript link
/// opens it: in the pane beside the transcript, or out in the default app.
public enum PreviewRules {
    public enum Viewer: Equatable, Sendable {
        /// A web view: a page, or an `.html` file with what it links to.
        case web
        /// The pane's own text view (TextFileView): Markdown rendered,
        /// code coloured, plain text plain, all of it selectable and
        /// editable. Quick Look showed these as text nobody could select.
        case text
        /// Quick Look: images, PDFs, video and the rest.
        case quickLook
    }

    /// An http(s) page, which can open in the browser or the panel
    /// (mailto: and the like only go to their app).
    public static func isWebPage(_ url: URL) -> Bool {
        guard let scheme = url.scheme?.lowercased() else { return false }
        return scheme == "http" || scheme == "https"
    }

    public static func viewer(forPath path: String) -> Viewer {
        let ext = (path as NSString).pathExtension.lowercased()
        if ext == "html" || ext == "htm" { return .web }
        if isMarkdown(path) || textExtensions.contains(ext) || codeLanguage(forPath: path) != nil { return .text }
        // A dotfile's name is all it has (`.env`, `.gitignore`).
        if textExtensions.contains(String((path as NSString).lastPathComponent.lowercased().drop(while: { $0 == "." }))) { return .text }
        return .quickLook
    }

    public static func isMarkdown(_ path: String) -> Bool {
        ["md", "markdown", "mdx"].contains((path as NSString).pathExtension.lowercased())
    }

    /// Text with no highlight.js language worth having: shown plain.
    static let textExtensions: Set<String> = ["txt", "text", "csv", "tsv", "log", "env", "gitignore", "editorconfig", "ndjson", "jsonl"]

    /// The highlight.js language for a code file, by its extension or
    /// name, or nil. Markdown, CSV and plain text aren't here: they're
    /// shown as they are (Markdown rendered).
    public static func codeLanguage(forPath path: String) -> String? {
        let name = (path as NSString).lastPathComponent
        switch name {
        case "Makefile", "GNUmakefile": return "makefile"
        case "Dockerfile": return "dockerfile"
        case "Podfile", "Gemfile", "Fastfile": return "ruby"
        default: break
        }
        return codeLanguages[(name as NSString).pathExtension.lowercased()]
    }

    static let codeLanguages: [String: String] = [
        "ts": "typescript", "tsx": "typescript", "mts": "typescript", "cts": "typescript",
        "js": "javascript", "jsx": "javascript", "mjs": "javascript", "cjs": "javascript",
        "swift": "swift", "py": "python", "rb": "ruby", "go": "go", "rs": "rust",
        "java": "java", "kt": "kotlin", "kts": "kotlin", "c": "c", "h": "c", "m": "objectivec",
        "cc": "cpp", "cpp": "cpp", "hpp": "cpp", "cs": "csharp", "php": "php",
        "sh": "bash", "bash": "bash", "zsh": "bash", "json": "json", "jsonc": "json",
        "yml": "yaml", "yaml": "yaml", "toml": "ini", "ini": "ini", "xml": "xml", "plist": "xml",
        "svg": "xml", "css": "css", "scss": "scss", "sql": "sql", "graphql": "graphql",
        "lua": "lua", "diff": "diff", "patch": "diff",
    ]

    /// Whether the start of a file reads as text: no NUL bytes, and UTF-8
    /// (a character cut off at the end of the sample is fine). Quick Look
    /// goes by the file's type, and macOS types `.ts` as MPEG video, so a
    /// TypeScript file showed a VLC icon; text it doesn't know is shown
    /// as text instead.
    public static func looksLikeText(_ sample: Data) -> Bool {
        if sample.contains(0) { return false }
        if String(data: sample, encoding: .utf8) != nil { return true }
        // Up to three bytes short of a whole character at the end.
        for cut in 1...3 where sample.count > cut {
            if String(data: sample.dropLast(cut), encoding: .utf8) != nil { return true }
        }
        return false
    }

    /// The kinds of file Mike reviews rather than edits: a transcript link
    /// to one of these opens in the pane, not in its app (⌘-click still
    /// does that).
    public static let reviewExtensions: Set<String> = [
        "md", "html", "htm", "pdf", "png", "jpg", "jpeg", "gif", "webp", "svg", "mp4", "mov", "csv", "txt",
    ]

    public static func previewsInPane(transcriptLink url: URL) -> Bool {
        url.isFileURL && reviewExtensions.contains(url.pathExtension.lowercased())
    }

    /// Project files that mean nothing outside their app: the pane could
    /// only show a Tandem project as JSON, so a click takes it to Tandem
    /// whatever "Default" says (Mike asked 5 Nov). "Preview here" and
    /// "Open in Panel" still show it in the pane if that's really wanted.
    static let appProjectExtensions: Set<String> = ["tandem"]

    public static func isAppProject(_ path: String) -> Bool {
        appProjectExtensions.contains((path as NSString).pathExtension.lowercased())
    }
}

/// An SF Symbol for a file, by its extension.
public enum FileIcon {
    public static func symbol(forPath path: String) -> String {
        if path.hasSuffix("/") { return "folder" }
        switch (path as NSString).pathExtension.lowercased() {
        case "md", "markdown", "txt", "rtf": return "doc.text"
        case "html", "htm": return "safari"
        case "pdf": return "doc.richtext"
        case "png", "jpg", "jpeg", "gif", "webp", "svg", "heic", "tiff": return "photo"
        case "mp4", "mov", "m4v", "webm": return "film"
        case "mp3", "wav", "m4a", "aiff": return "waveform"
        case "csv", "tsv", "xlsx", "numbers": return "tablecells"
        case "json", "yaml", "yml", "toml", "plist": return "curlybraces.square"
        case "zip", "gz", "tar", "dmg": return "archivebox"
        case "": return "doc"
        default: return "chevron.left.forwardslash.chevron.right"
        }
    }

    /// A highlight's: a file's by its extension, the rest by kind.
    public static func symbol(for highlight: Highlight) -> String {
        switch highlight.kind {
        case .pr: return "arrow.triangle.pull"
        case .commit: return "smallcircle.filled.circle"
        case .link: return "link"
        case .file: return symbol(forPath: highlight.path ?? highlight.title)
        case .other: return highlight.path.map(symbol(forPath:)) ?? "link"
        }
    }
}

/// Short words for a highlight row.
public enum HighlightText {
    /// The folder a file is in, as a row's second line: inside the
    /// thread's folder, relative to it ("docs/mockups"), or the folder's
    /// own name for a file at its top; elsewhere the full path with `~`.
    public static func folder(of path: String, cwd: String?, home: String = NSHomeDirectory()) -> String {
        let parent = (path as NSString).deletingLastPathComponent
        if let cwd, !cwd.isEmpty {
            let root = cwd.hasSuffix("/") ? String(cwd.dropLast()) : cwd
            if parent == root { return (root as NSString).lastPathComponent }
            if parent.hasPrefix(root + "/") { return String(parent.dropFirst(root.count + 1)) }
        }
        if !home.isEmpty, parent == home || parent.hasPrefix(home + "/") { return "~" + parent.dropFirst(home.count) }
        return parent
    }

    /// A link's second line: its host and path, without the scheme.
    public static func address(_ url: String) -> String {
        var text = url
        for scheme in ["https://", "http://"] where text.hasPrefix(scheme) {
            text.removeFirst(scheme.count)
        }
        if text.hasPrefix("www.") { text.removeFirst(4) }
        if text.hasSuffix("/") { text.removeLast() }
        return text
    }

    /// "pushed" or "not pushed yet", after the branch.
    public static func commitLine(_ commit: Highlight) -> String {
        let state = commit.pushed ? "pushed" : "not pushed yet"
        guard let branch = commit.branch, !branch.isEmpty else { return state }
        return "\(branch) · \(state)"
    }

    public static func editedCount(_ count: Int) -> String {
        count == 1 ? "1 file edited" : "\(count) files edited"
    }
}

/// Decides when a fetch should open a pin in the pane by itself: a pin the
/// agent asked to have shown (`show`) that wasn't there, shown, last time.
/// Never on a thread's first fetch this session, so opening an old thread
/// doesn't throw its old mockups at Mike.
public struct HighlightAutoShow: Sendable {
    /// Per thread, the ids that had `show` in the last fetch. An item that
    /// goes away (unpinned) leaves it, so pinning it again shows it again.
    private var shown: [String: Set<String>] = [:]

    public init() {}

    public mutating func receive(_ highlights: ThreadHighlights, threadId: String) -> Highlight? {
        let showing = highlights.highlights.filter(\.show)
        let previous = shown[threadId]
        shown[threadId] = Set(showing.map(\.id))
        guard let previous else { return nil }
        return showing.filter { !previous.contains($0.id) }.max { max($0.seq, $0.lastSeq) < max($1.seq, $1.lastSeq) }
    }

    /// Forgets a thread (it was deleted), so a thread with the same id
    /// later counts as new.
    public mutating func forget(_ threadId: String) { shown[threadId] = nil }
}

/// The SF Symbol for a panel's button on the rail: its own, else one for
/// the built-in panels, else one by kind.
public enum PanelIcon {
    public static func symbol(for panel: Panel) -> String {
        if let icon = panel.icon, !icon.isEmpty { return icon }
        switch panel.id {
        case "convex.dashboard": return "cylinder.split.1x2"
        case "xcode.simulator": return "iphone"
        default: break
        }
        switch panel.kind {
        case .url: return "globe"
        case .image: return "photo"
        case .list: return "list.bullet"
        }
    }
}
