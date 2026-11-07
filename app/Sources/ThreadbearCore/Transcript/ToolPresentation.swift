import Foundation

/// How a tool row reads when collapsed: an SF Symbol and a one-line title.
public enum ToolPresentation {
    public static func symbol(for kind: ToolKind, name: String) -> String {
        switch kind {
        // An action from a patch (ActionRun) gets the patch glyph.
        case .command: return name == "action" ? "square.dashed" : "terminal"
        // Codex's view_image is looking at a picture, not reading a file.
        case .read: return name == "view_image" ? "photo" : "doc.text"
        // At 12 pt the bare `pencil` drew as one diagonal stroke and read
        // as a stray "/" before the title.
        case .edit: return "pencil.line"
        case .write: return "square.and.pencil"
        case .search: return "magnifyingglass"
        case .web: return "globe"
        case .mcp: return "puzzlepiece.extension"
        case .task: return "person.2"
        case .todo: return "checklist"
        case .image: return "photo"
        case .other:
            if name.hasPrefix("mcp__") { return "puzzlepiece.extension" }
            return "wrench.and.screwdriver"
        }
    }

    /// The title on one line, home folder shortened to ~, capped in length.
    public static func shortTitle(_ title: String, limit: Int = 160) -> String {
        var line = title.split(separator: "\n", maxSplits: 1, omittingEmptySubsequences: true).first.map(String.init) ?? title
        let home = NSHomeDirectory()
        if line.contains(home) { line = line.replacingOccurrences(of: home, with: "~") }
        if line.count > limit { line = String(line.prefix(limit - 1)) + "…" }
        return line
    }

    /// A file tool's title in parts: "Read" "UploadTask.swift" and its
    /// folder, which the row dims after the name (as the changes card and
    /// Claude do) rather than a long grey run of the whole path.
    public struct FileTitle: Sendable, Hashable {
        public var verb: String
        public var name: String
        /// The folder inside the thread's folder ("Sources/Upload"), empty
        /// for a file at its top; short for a file outside it.
        public var folder: String
        /// The whole path with the home folder as ~, for the tooltip.
        public var path: String
    }

    /// For Read, Edit and Write calls with a file path; nil for anything else.
    public static func fileTitle(_ tool: ToolItem) -> FileTitle? {
        let verb: String
        switch tool.toolKind {
        case .read: verb = tool.name == "view_image" ? "View" : "Read"
        case .edit: verb = "Edit"
        case .write: verb = "Write"
        default: return nil
        }
        let input = tool.call?.input
        guard let path = input?["file_path"]?.stringValue ?? input?["notebook_path"]?.stringValue ?? input?["path"]?.stringValue,
              !path.isEmpty else { return nil }
        let name = (path as NSString).lastPathComponent
        guard !name.isEmpty else { return nil }
        return FileTitle(verb: verb, name: name, folder: PathDisplay.folder(of: path, relativeTo: tool.root), path: shortTitle(path, limit: 400))
    }

    /// The tool output preview shown when a tool row is expanded.
    public static func outputPreview(_ tool: ToolItem, maxLines: Int = 400) -> String {
        let text = tool.result?.text ?? tool.liveOutput
        var lines = 0
        var end = text.startIndex
        for index in text.indices where text[index] == "\n" {
            lines += 1
            if lines >= maxLines { end = index; break }
        }
        if lines >= maxLines {
            return String(text[..<end]) + "\n…"
        }
        return text
    }

    /// The title for a tool that's running now, for a live group's line: a
    /// bare command reads "Running npm test"; a described one keeps its
    /// description ("Run the upload tests").
    public static func activeTitle(_ tool: ToolItem) -> String {
        let title = shortTitle(tool.title, limit: 80)
        if tool.toolKind == .command, let command = tool.call?.input["command"]?.stringValue,
           shortTitle(command, limit: 80) == title {
            return "Running " + title
        }
        return title
    }

    /// What an expanded tool row shows, by kind of tool. The view lays each
    /// one out as content (a command and its output, a file with line
    /// numbers) rather than the raw input object.
    public enum Detail: Sendable, Hashable {
        case command(command: String, output: String)
        case file(path: String, lines: [NumberedLine])
        case search(query: String, scope: String?, output: String)
        case fields(fields: [Field], output: String)
    }

    public struct Field: Sendable, Hashable {
        public var key: String
        public var value: String

        public init(key: String, value: String) {
            self.key = key
            self.value = value
        }
    }

    public struct NumberedLine: Sendable, Hashable {
        public var number: Int?
        public var text: String

        public init(number: Int?, text: String) {
            self.number = number
            self.text = text
        }
    }

    public static func detail(_ tool: ToolItem, maxLines: Int = 400) -> Detail {
        let output = outputPreview(tool, maxLines: maxLines).trimmingCharacters(in: .newlines)
        let input = tool.call?.input ?? .object([:])
        switch tool.toolKind {
        case .command:
            if let command = input["command"]?.stringValue {
                return .command(command: command, output: output)
            }
        case .read:
            if let path = input["file_path"]?.stringValue ?? input["path"]?.stringValue, tool.result.map({ $0.ok }) ?? true {
                // The model writes the offset: Int(_:) of 1e300 would stop the app,
                // and the line numbers are added to it.
                let offset = input["offset"]?.doubleValue.flatMap { Int(checked: $0) }.map { min(max(1, $0), 1_000_000_000) } ?? 1
                return .file(path: shortTitle(path, limit: 400), lines: numberedLines(output, from: offset))
            }
        case .search:
            if let query = input["pattern"]?.stringValue ?? input["query"]?.stringValue {
                let scope = (input["path"]?.stringValue ?? input["glob"]?.stringValue).map { shortTitle($0, limit: 200) }
                return .search(query: query, scope: scope, output: output)
            }
        default:
            break
        }
        return .fields(fields: fields(input), output: output)
    }

    /// The input as `key: value` lines: strings as they are, other values as
    /// compact JSON, long values cut to a few lines unless `whole` (an
    /// approval card, which shows all of what Allow allows).
    public static func fields(_ input: JSONValue, whole: Bool = false) -> [Field] {
        guard let object = input.objectValue else {
            let text = input.compactText
            return text.isEmpty || text == "null" ? [] : [Field(key: "input", value: text)]
        }
        return object.keys.sorted().compactMap { key in
            guard let value = object[key] else { return nil }
            var text: String
            switch value {
            case .string(let string): text = string
            case .null: return nil
            default: text = value.compactText
            }
            guard !whole else { return Field(key: key, value: text) }
            let lines = text.split(separator: "\n", omittingEmptySubsequences: false)
            if lines.count > 6 { text = lines.prefix(6).joined(separator: "\n") + "\n…" }
            if text.count > 600 { text = String(text.prefix(599)) + "…" }
            return Field(key: key, value: text)
        }
    }

    /// The widest "key:" in `fields`, in characters, capped at `cap`. Tool
    /// input is shown in a monospaced font, so values line up in one
    /// column a fixed number of characters in; a key longer than the cap
    /// just runs on into its value rather than pushing every value right.
    public static func keyWidth(_ fields: [Field], cap: Int = 16) -> Int {
        min(cap, fields.map { $0.key.count + 1 }.max() ?? 0)
    }

    /// A line of a failed tool's output that says what went wrong
    /// ("error: ...", "fatal: ..."). Only those are marked red; the rest of
    /// the output is ordinary text, not something that was removed.
    public static func isErrorLine(_ line: Substring) -> Bool {
        let trimmed = line.drop(while: { $0 == " " || $0 == "\t" })
        for word in ["error", "fatal"] {
            guard trimmed.count > word.count, trimmed.prefix(word.count).lowercased() == word else { continue }
            let next = trimmed[trimmed.index(trimmed.startIndex, offsetBy: word.count)]
            if next == ":" || next == " " || next == "[" { return true }
        }
        return false
    }

    /// File content with line numbers. Claude's Read results already number
    /// their lines ("    12→text" or "12<tab>text"); those numbers are used.
    /// Otherwise lines are numbered from `start`.
    public static func numberedLines(_ text: String, from start: Int = 1) -> [NumberedLine] {
        guard !text.isEmpty else { return [] }
        let raw = text.split(separator: "\n", omittingEmptySubsequences: false)
        var parsed: [NumberedLine] = []
        parsed.reserveCapacity(raw.count)
        var allNumbered = true
        for line in raw {
            if let numbered = parseNumbered(line) {
                parsed.append(numbered)
            } else if line.hasPrefix("…") || line.isEmpty {
                parsed.append(NumberedLine(number: nil, text: String(line)))
            } else {
                allNumbered = false
                break
            }
        }
        if allNumbered, parsed.contains(where: { $0.number != nil }) { return parsed }
        return raw.enumerated().map { index, line in
            line == "…" ? NumberedLine(number: nil, text: "…") : NumberedLine(number: start + index, text: String(line))
        }
    }

    static func parseNumbered(_ line: Substring) -> NumberedLine? {
        let trimmed = line.drop(while: { $0 == " " })
        let digits = trimmed.prefix(while: { $0.isASCII && $0.isNumber })
        guard !digits.isEmpty, digits.count <= 7, let number = Int(digits) else { return nil }
        let rest = trimmed.dropFirst(digits.count)
        guard let separator = rest.first, separator == "→" || separator == "\t" else { return nil }
        return NumberedLine(number: number, text: String(rest.dropFirst()))
    }
}

/// Short forms of paths for the transcript.
public enum PathDisplay {
    /// A file's folder as seen from the thread's folder `root`:
    /// "Sources/Upload" for a file in there, empty for one at its top.
    /// Outside it (or with no root), as `folder(of:)`. The project's name
    /// is already in the header, so "photo-sync/scripts" said it twice and
    /// a file at the top read "dev/photo-sync".
    public static func folder(of path: String, relativeTo root: String?) -> String {
        if let root, let relative = relativePath(path, to: root) {
            return (relative as NSString).deletingLastPathComponent
        }
        return folder(of: path)
    }

    /// `path` inside `root` without the root ("scripts/release.sh"), or
    /// nil when it isn't inside it.
    public static func relativePath(_ path: String, to root: String) -> String? {
        var base = (root as NSString).expandingTildeInPath
        while base.count > 1, base.hasSuffix("/") { base.removeLast() }
        guard !base.isEmpty, base != "/" else { return nil }
        let full = (path as NSString).expandingTildeInPath
        guard full.hasPrefix(base + "/"), full.count > base.count + 1 else { return nil }
        return String(full.dropFirst(base.count + 1))
    }

    /// A file's folder, short: its last two components ("Sources/Upload"),
    /// "~" for something right in the home folder, empty at the root.
    public static func folder(of path: String) -> String {
        let parent = (path as NSString).deletingLastPathComponent
        guard !parent.isEmpty, parent != "/" else { return "" }
        if parent == NSHomeDirectory() || parent == "~" { return "~" }
        return parent.split(separator: "/").suffix(2).joined(separator: "/")
    }
}
