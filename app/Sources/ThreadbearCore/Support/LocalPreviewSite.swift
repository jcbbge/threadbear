import CryptoKit
import Foundation
import UniformTypeIdentifiers

/// What a local HTML file in the pane's preview may read: itself, and the
/// styles, scripts, pictures, fonts and media it names, in its own folder
/// or below. Nothing else beside it, so a page from a project (or one an
/// agent was talked into writing) can't read a `.env`, a key or a database
/// kept in the same folder. It was loaded with read access to its whole
/// folder until Daybreak finding 6 (Nov 2026).
///
/// The Mac app serves the page through a WKURLSchemeHandler
/// (LocalPreviewSchemeHandler) that asks `serve` for every request. A file
/// is served only when all of these hold:
/// - its path has no `..`, no empty part and no part starting with a dot;
/// - it's the page itself, or a passive asset, one of `assetExtensions`:
///   styles, pictures, fonts, sound and video. Never another page, a script,
///   SVG (which can carry script), `.json`, `.txt`, `.env`, keys...;
/// - a page or stylesheet served before names it in markup or CSS (the page
///   itself always): `src`, `href`, `srcset`, `poster`, a style's `url()`,
///   a stylesheet's `url()` and `@import`. Never a string in a script.
///
/// The page can still name a file beside it in its markup and read it, so
/// the preview's web view lets nothing out either (WebPanelPool and
/// LocalPreviewSchemeHandler: no network, no navigating away, no windows,
/// no downloads), and what it reads stays on screen.
/// - it's reached from the folder without following a symlink anywhere on
///   the way, and is a regular file with one link, checked on the open file
///   it's then read from, so swapping it for a link after the check reads
///   nothing (Codex review).
public final class LocalPreviewSite: @unchecked Sendable {
    /// The page's folder, symlinks resolved.
    public let root: URL
    /// The page's path from `root`: its file name.
    public let page: String
    private let lock = NSLock()
    private var allowed: Set<String>

    /// What a page can pull in besides itself: passive files only. A
    /// sibling page or script named by the page (an iframe, a script src)
    /// would let it read whatever that names in turn (verify-fix, Nov 2026),
    /// so a preview of a several-file HTML or JS project shows its main page
    /// alone. The page's own scripts don't run at all (WebPanelPool).
    public static let assetExtensions: Set<String> = [
        "css",
        "png", "jpg", "jpeg", "gif", "webp", "avif", "ico", "bmp", "heic",
        "woff", "woff2", "ttf", "otf",
        "mp4", "webm", "m4v", "mov", "mp3", "m4a", "wav", "ogg",
    ]
    /// What can be the page.
    public static let pageExtensions: Set<String> = ["html", "htm"]
    /// Files read for links: the page and stylesheets. Not scripts, which can
    /// build any name they like at run time anyway.
    static let scannedExtensions: Set<String> = ["html", "htm", "css"]
    /// Bigger than any page or picture a preview needs.
    public static let maxBytes = 64 * 1024 * 1024
    /// How much of a page or stylesheet is read for what it names, and how
    /// many names are kept from one file and in all: a 64 MB page of short
    /// `src=` attributes made millions of strings and a set of them before
    /// the page was shown (Daybreak, 7 Nov 2026). A real page names its
    /// files near the top and far fewer than this; an asset named past the
    /// limits just isn't served.
    public static let scanBytes = 4 * 1024 * 1024
    public static let maxReferencesPerFile = 2_000
    public static let maxAllowed = 10_000

    /// The folder is the file's own (its symlinks followed); the page itself
    /// is held to the same rules as everything else when it's served.
    /// `pageDigest`: the page's bytes Mike allowed to run scripts (SHA-256,
    /// hex). Its view runs JavaScript, so the page is served only while its
    /// bytes still match: an agent rewriting it after the click, or the
    /// page reloading itself after a rewrite, gets nothing (6 Nov 2026).
    public init?(file: URL, pageDigest: String? = nil) {
        self.pageDigest = pageDigest
        let file = file.standardizedFileURL
        let page = file.lastPathComponent
        guard Self.pageExtensions.contains((page as NSString).pathExtension.lowercased()), !page.hasPrefix(".") else { return nil }
        root = file.deletingLastPathComponent().resolvingSymlinksInPath()
        // Held open for the site's life: every read starts here, so the
        // folder being moved or swapped for a link later changes nothing.
        rootFD = open(root.path, O_RDONLY | O_DIRECTORY | O_CLOEXEC)
        guard rootFD >= 0 else { return nil }
        self.page = page
        allowed = [page]
    }

    private let rootFD: Int32
    public let pageDigest: String?

    /// How many paths the page may read now (for tests).
    var allowedCount: Int { lock.withLock { allowed.count } }

    /// Whether `relative` is one the page may read now (for tests).
    func allows(_ relative: String) -> Bool { lock.withLock { allowed.contains(relative) } }

    deinit { close(rootFD) }

    /// The bytes and MIME type for `path` (from the folder, as in the URL
    /// the page asked for), or nil when it isn't one the page may read.
    public func serve(_ path: String) -> (data: Data, mimeType: String)? {
        let path = path.hasPrefix("/") ? String(path.dropFirst()) : path
        guard let parts = Self.safeParts(path) else { return nil }
        let relative = parts.joined(separator: "/")
        let ext = (relative as NSString).pathExtension.lowercased()
        // The page itself, or a passive asset something served has named.
        guard relative == page || Self.assetExtensions.contains(ext) && lock.withLock({ allowed.contains(relative) }) else { return nil }
        guard let data = Self.read(parts, under: rootFD, maxBytes: Self.maxBytes) else { return nil }
        if relative == page, let pageDigest, Self.digest(data) != pageDigest { return nil }
        let utf8 = Self.scannedExtensions.contains(ext) && String(data: data, encoding: .utf8) != nil
        if Self.scannedExtensions.contains(ext) {
            // Only the start is read for names (scanBytes); a character cut
            // in two at the end reads as U+FFFD, which names nothing.
            let head = data.prefix(Self.scanBytes)
            let text = utf8 ? String(decoding: head, as: UTF8.self) : String(data: Data(head), encoding: .isoLatin1) ?? ""
            let dir = (relative as NSString).deletingLastPathComponent
            let limit = Self.maxReferencesPerFile
            let found = (ext == "css" ? Self.cssReferences(in: text, limit: limit) : Self.htmlReferences(in: text, limit: limit)).compactMap { Self.resolve($0, from: dir) }
            lock.withLock {
                for ref in found where allowed.count < Self.maxAllowed { allowed.insert(ref) }
            }
        }
        var mime = UTType(filenameExtension: ext)?.preferredMIMEType ?? "application/octet-stream"
        // With no charset in the response or the page, WebKit reads it as
        // Latin-1 and a UTF-8 page's ✓ shows as "âœ“" (Mike, 7 Nov). A page
        // or stylesheet that is valid UTF-8 is served as that.
        if utf8 { mime += "; charset=utf-8" }
        return (data, mime)
    }

    /// The file at `parts` under the folder open as `rootFD`: each folder on
    /// the way and the file itself opened with O_NOFOLLOW, so a symlink
    /// anywhere refuses it (`logo.png` linked to the `.env` beside it, a
    /// folder linked elsewhere), then checked and read on that one open file.
    static func read(_ parts: [String], under rootFD: Int32, maxBytes: Int) -> Data? {
        guard let name = parts.last else { return nil }
        var dir = rootFD
        var opened: [Int32] = []
        defer { opened.forEach { close($0) } }
        for part in parts.dropLast() {
            let fd = openat(dir, part, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
            guard fd >= 0 else { return nil }
            opened.append(fd)
            dir = fd
        }
        // O_NONBLOCK, so a FIFO named like a picture can't hang the open.
        let fd = openat(dir, name, O_RDONLY | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC)
        guard fd >= 0 else { return nil }
        defer { close(fd) }
        var info = stat()
        guard fstat(fd, &info) == 0, info.st_mode & S_IFMT == S_IFREG,
              // A hard link is the same file as one somewhere else.
              info.st_nlink == 1,
              info.st_size <= maxBytes else { return nil }
        var out = Data()
        var buffer = [UInt8](repeating: 0, count: 64 * 1024)
        while true {
            let n = buffer.withUnsafeMutableBytes { Darwin.read(fd, $0.baseAddress, $0.count) }
            if n < 0 { if errno == EINTR { continue } else { return nil } }
            if n == 0 { break }
            out.append(buffer, count: n)
            // It grew after the check.
            if out.count > maxBytes { return nil }
        }
        return out
    }

    /// The path's parts, or nil for one with `..`, `.`, an empty part or a dotfile.
    /// Also nil for one with a control character, a backslash or a `%`:
    /// `openat` stops at a NUL, so `credentials.json\0.html` passed the
    /// extension check as a page and opened `credentials.json` (Codex's
    /// second review), and a `%` left after decoding means it was encoded
    /// twice, which no real asset name needs.
    static func safeParts(_ path: String) -> [String]? {
        guard !path.unicodeScalars.contains(where: { $0.properties.generalCategory == .control || $0 == "\\" || $0 == "%" }) else { return nil }
        let parts = path.split(separator: "/", omittingEmptySubsequences: false).map(String.init)
        guard !parts.isEmpty, parts.allSatisfy({ !$0.isEmpty && !$0.hasPrefix(".") }) else { return nil }
        return parts
    }

    /// What a page's markup names: `src`, `href`, `poster` and `data`
    /// attributes, each part of a `srcset`, and `url()` and `@import` in its
    /// style attributes and `<style>` blocks. Scripts' contents are taken
    /// out first, so nothing a script says counts.
    /// At most `limit` of them, stopping each read once it has them all.
    static func htmlReferences(in text: String, limit: Int = .max) -> [String] {
        let markup = withoutScriptContents(text)
        var out = matches(#"\b(?:src|href|poster|data)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))"#, in: markup, limit: limit)
        srcsets: for srcset in matches(#"\bsrcset\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))"#, in: markup, limit: limit - out.count) {
            for piece in srcset.split(separator: ",") {
                guard out.count < limit else { break srcsets }
                if let first = piece.split(separator: " ").first { out.append(String(first)) }
            }
        }
        return out + cssReferences(in: markup, limit: limit - out.count)
    }

    /// What a stylesheet names: `url()` and `@import`, at most `limit`.
    static func cssReferences(in text: String, limit: Int = .max) -> [String] {
        let urls = cssURLs(in: text, limit: limit)
        return urls + matches(#"@import\s+(?:"([^"]*)"|'([^']*)')"#, in: text, limit: limit - urls.count)
    }

    // These ran on the main thread, as the preview's web view asks for each
    // file (LocalPreviewSchemeHandler, which now serves off it), on whatever
    // a page or stylesheet says. Two of the regexes they used backtracked: `url(` and 16 KB of
    // spaces took 15 seconds, and `<script>` over and over with no
    // `</script>` was quadratic (6 Nov 2026). Both are read in one pass
    // now, giving what the regexes gave: ICU finds where each starts (its
    // case folding included), and the rest walks the UTF-16 units the
    // regexes' ranges count, each looked at a bounded number of times.

    /// `text` with what's between each `<script ...>` and the
    /// `</script>` after it taken out, as `(<script\b[^>]*>)[\s\S]*?(</script\s*>)`
    /// replaced with `$1$2` did: the tag runs to the first `>`, and a
    /// script with no `</script>` after its tag keeps its contents.
    static func withoutScriptContents(_ text: String) -> String {
        let units = Array(text.utf16)
        var tagEnd = Seek { $0 == UInt16(UInt8(ascii: ">")) }
        var out: [UInt16] = []
        var copied = 0
        // Where the open tag being matched ends, while looking for its `</script>`.
        var gt: Int?
        // One pass over both kinds of tag in order, never a list of them: a
        // 64 MB page of `<script` would make millions (Codex's review). Neither
        // kind can start inside the other, so this sees every one.
        scriptTagRegex.enumerateMatches(in: text, range: NSRange(location: 0, length: units.count)) { match, _, stop in
            guard let match else { return }
            if let open = gt {
                // A `</script>` inside the open tag doesn't close it.
                guard match.range(at: 2).location != NSNotFound, match.range.location > open else { return }
                out += units[copied...open]
                copied = match.range.location
                gt = nil
            } else if match.range(at: 1).location != NSNotFound {
                let end = tagEnd.first(in: units, from: NSMaxRange(match.range))
                // No `>`: none for a later tag either.
                if end < units.count { gt = end } else { stop.pointee = true }
            }
        }
        // Nothing taken out (a script with no `</script>` keeps its contents).
        guard copied > 0 else { return text }
        out += units[copied...]
        return String(decoding: out, as: UTF16.self)
    }

    /// The first group of each match of
    /// `url\(\s*(?:"([^"]*)"|'([^']*)'|([^)"'\s]*))\s*\)`, trimmed, as
    /// `matches` gave it: a quoted value, or a bare one up to a space,
    /// quote or `)`, then `)` after any spaces.
    static func cssURLs(in text: String, limit: Int = .max) -> [String] {
        guard limit > 0 else { return [] }
        let units = Array(text.utf16)
        let n = units.count
        let dq = UInt16(UInt8(ascii: "\"")), sq = UInt16(UInt8(ascii: "'")), paren = UInt16(UInt8(ascii: ")"))
        // One Seek for each place a search starts, as each one's starts only
        // move forward.
        var afterOpen = Seek { !isSpace($0) }, afterBare = Seek { !isSpace($0) }
        var afterDQ = Seek { !isSpace($0) }, afterSQ = Seek { !isSpace($0) }
        var bareEnd = Seek { $0 == paren || $0 == dq || $0 == sq || isSpace($0) }
        var nextDQ = Seek { $0 == dq }, nextSQ = Seek { $0 == sq }
        var out: [String] = []
        var resume = 0
        // Enumerated, not listed: a 64 MB stylesheet of `url(` would make
        // millions of matches at once (Codex's review).
        urlOpenRegex.enumerateMatches(in: text, range: NSRange(location: 0, length: n)) { open, _, stop in
            guard let open, open.range.location >= resume else { return }
            let p = afterOpen.first(in: units, from: NSMaxRange(open.range))
            var value: Range<Int>?, close = 0
            if p < n, units[p] == dq || units[p] == sq {
                // A quoted value that isn't followed by `)` matches nothing:
                // a bare value can't start at a quote.
                let q = units[p] == dq ? nextDQ.first(in: units, from: p + 1) : nextSQ.first(in: units, from: p + 1)
                if q < n {
                    let r = units[p] == dq ? afterDQ.first(in: units, from: q + 1) : afterSQ.first(in: units, from: q + 1)
                    if r < n, units[r] == paren { value = p + 1..<q; close = r }
                }
            } else {
                let e = bareEnd.first(in: units, from: p)
                let r = afterBare.first(in: units, from: e)
                if r < n, units[r] == paren { value = p..<e; close = r }
            }
            guard let value else { return }
            out.append(String(decoding: units[value], as: UTF16.self).trimmingCharacters(in: .whitespaces))
            resume = close + 1
            if out.count >= limit { stop.pointee = true }
        }
        return out
    }

    private static let scriptTagRegex = try! NSRegularExpression(pattern: #"(<script\b)|(</script\s*>)"#, options: [.caseInsensitive])
    private static let urlOpenRegex = try! NSRegularExpression(pattern: #"url\("#, options: [.caseInsensitive])

    /// ICU's `\s` for one UTF-16 unit: the White_Space property, all of
    /// whose characters are in the BMP (a test checks it against ICU).
    static func isSpace(_ unit: UInt16) -> Bool {
        Unicode.Scalar(unit)?.properties.isWhitespace ?? false
    }

    /// The first index at or after `from` whose unit passes `test`, else
    /// the count, for searches whose `from` only moves forward: an answer
    /// holds for any `from` up to it, so a run is walked once however many
    /// searches start in it (thousands of `url(` before one long run of
    /// spaces each started a walk of it).
    struct Seek {
        let test: (UInt16) -> Bool
        private var from = 0, found = -1

        init(_ test: @escaping (UInt16) -> Bool) { self.test = test }

        mutating func first(in units: [UInt16], from start: Int) -> Int {
            if start >= from && start <= found { return found }
            var i = start
            while i < units.count && !test(units[i]) { i += 1 }
            (from, found) = (start, i)
            return i
        }
    }

    /// The first group that matched in each match of `pattern`.
    private static func matches(_ pattern: String, in text: String, limit: Int = .max) -> [String] {
        guard limit > 0, let regex = try? NSRegularExpression(pattern: pattern, options: [.caseInsensitive]) else { return [] }
        // Enumerated, so a page of millions of `src=x` holds the strings, not
        // a match object for each as well (Codex's review).
        var out: [String] = []
        regex.enumerateMatches(in: text, range: NSRange(text.startIndex..., in: text)) { match, _, stop in
            guard let match else { return }
            if let first = (1..<match.numberOfRanges).lazy.compactMap({ Range(match.range(at: $0), in: text) }).first {
                out.append(String(text[first]).trimmingCharacters(in: .whitespaces))
                if out.count >= limit { stop.pointee = true }
            }
        }
        return out
    }

    /// `ref`, named in a file in `dir`, as a path from the folder: nil for
    /// anything with a scheme (`https:`, `data:`), a `//host`, or a path
    /// that climbs out of the folder or isn't an asset.
    static func resolve(_ ref: String, from dir: String) -> String? {
        var ref = ref
        if let cut = ref.firstIndex(where: { $0 == "?" || $0 == "#" }) { ref = String(ref[..<cut]) }
        guard !ref.isEmpty, !ref.hasPrefix("//"), ref.range(of: #"^[A-Za-z][A-Za-z0-9+.\-]*:"#, options: .regularExpression) == nil,
              let decoded = ref.removingPercentEncoding,
              Self.assetExtensions.contains((decoded as NSString).pathExtension.lowercased()) else { return nil }
        var stack: [String] = decoded.hasPrefix("/") ? [] : dir.split(separator: "/").map(String.init)
        for part in decoded.split(separator: "/", omittingEmptySubsequences: true) {
            switch part {
            case ".": continue
            case "..":
                // Above the folder: never.
                guard !stack.isEmpty else { return nil }
                stack.removeLast()
            default: stack.append(String(part))
            }
        }
        // Where a decoded NUL, control character or leftover `%` is refused.
        guard !stack.isEmpty, safeParts(stack.joined(separator: "/")) != nil else { return nil }
        return stack.joined(separator: "/")
    }

    /// Whether a page has scripts of its own, which the preview runs only
    /// once Mike says so for those exact bytes (PreviewScriptConsent): the
    /// pane asks rather than showing a page that draws itself as blank
    /// boxes (6 Nov 2026). The runner's `pin` tool tells the agent the same
    /// (runner/src/runner/highlights.ts). A `<script`, an `on...=` handler
    /// in a tag or a `javascript:` link anywhere counts, even in a comment:
    /// asking wrongly costs a bar, missing one looks broken. The runner's
    /// test is the same (`hasScriptMarks` there).
    ///
    /// The test is `<script|<[^>]*\son[a-z]+\s*=|javascript:`, read in one
    /// pass: as one regex, a page of 4 MB of `<` with no `>` started a scan
    /// to its end at every `<`, which pinned a core for hours (6 Nov 2026).
    /// The two regexes left have no overlapping runs, and a handler counts
    /// when the last `<` before it comes after the last `>`, which is what
    /// `<[^>]*` before it allowed. `String.range(of:options:)` ran that
    /// regex as a Swift Regex, which reads characters (a letter with its
    /// accents is one) and folds case without `ſ` for `s` (ICU folds it), so
    /// these are Swift Regexes too, and the walk goes by characters.
    public static func hasScripts(_ html: Data) -> Bool {
        let text = String(decoding: html.prefix(scriptScanBytes), as: UTF8.self)
        if text.firstMatch(of: try! Regex(#"<script|javascript:"#).ignoresCase()) != nil { return true }
        let handlerRegex = try! Regex(#"\son[a-z]+\s*="#).ignoresCase()
        var lastOpen: String.Index?, lastClose: String.Index?, read = text.startIndex, from = text.startIndex
        // One match at a time, not `matches(of:)`, which lists them all first.
        while let handler = text[from...].firstMatch(of: handlerRegex) {
            from = handler.range.upperBound
            while read < handler.range.lowerBound {
                if text[read] == "<" { lastOpen = read } else if text[read] == ">" { lastClose = read }
                read = text.index(after: read)
            }
            if let lastOpen, lastClose.map({ lastOpen > $0 }) ?? true { return true }
        }
        return false
    }

    /// How much of a page `hasScripts` reads.
    public static let scriptScanBytes = 4 * 1024 * 1024

    /// SHA-256 of a page's bytes, hex: what a consent to run scripts is for.
    public static func digest(_ data: Data) -> String {
        SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
    }

    /// A page file read for the pane's bar: whether it has scripts, and the
    /// digest of what was read. Nil for anything but a regular file up to
    /// `maxBytes`. Opened without blocking and checked on the open file, so
    /// a FIFO named `.html` (or one swapped in) can't hang the caller.
    public static func scan(atPath path: String) -> (scripts: Bool, digest: String)? {
        let fd = open(path, O_RDONLY | O_NONBLOCK | O_CLOEXEC)
        guard fd >= 0 else { return nil }
        let handle = FileHandle(fileDescriptor: fd, closeOnDealloc: true)
        var info = stat()
        guard fstat(fd, &info) == 0, (info.st_mode & S_IFMT) == S_IFREG, info.st_size <= maxBytes,
              let data = try? handle.readToEnd() ?? Data(), data.count <= maxBytes else { return nil }
        return (hasScripts(data), digest(data))
    }
}
