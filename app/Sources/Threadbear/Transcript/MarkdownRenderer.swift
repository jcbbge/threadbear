import AppKit
import Markdown
import ThreadbearCore

/// Renders markdown into an `NSAttributedString` for TextKit 1 text views.
/// Text is split into top-level blocks (`MarkdownBlocks`) and each block is
/// rendered once and cached by its text, so a streaming message only
/// re-renders its last, still-open block. Safe to call off the main thread.
enum MarkdownRenderer {
    /// A bare absolute path parses as a URL without a scheme, which looks
    /// clickable but cannot be opened. Give the transcript's file opener a
    /// file URL, keeping URL escaping and HTML fragments intact.
    private static func linkURL(_ destination: String) -> URL? {
        // end_turn's links take ~ paths, so an ask's words linked to the
        // same place (needs.ts) may well use one too.
        if destination.hasPrefix("~/") {
            let path = destination.removingPercentEncoding ?? destination
            let whole = URL(fileURLWithPath: (path as NSString).expandingTildeInPath)
            // `~/a/grow.html?clean`: the file, and the query for its page,
            // unless the whole thing is a file's name.
            let parts = FilePathRefs.splitQuery(destination)
            guard parts.query != nil || parts.fragment != nil, !FileManager.default.fileExists(atPath: whole.path) else { return whole }
            let file = URL(fileURLWithPath: ((parts.path.removingPercentEncoding ?? parts.path) as NSString).expandingTildeInPath)
            return FilePathRefs.withQuery(file, query: parts.query, fragment: parts.fragment)
        }
        // A relative target (`[plan](shorts-plan/candidates.md)`) means a
        // file from the thread's folder, so it's found the way a path in
        // inline code is (FilePathRefs). Left as a scheme-less URL, AppKit
        // hands it to NSWorkspace and Finder says "can't be opened. -50".
        // A lone `#section` has nowhere to go in a transcript.
        if !destination.hasPrefix("/"), destination.range(of: #"^[A-Za-z][A-Za-z0-9+.-]*:"#, options: .regularExpression) == nil {
            guard !destination.hasPrefix("#") else { return nil }
            return FilePathRefs.url(for: destination.removingPercentEncoding ?? destination)
        }
        guard var components = URLComponents(string: destination) else { return nil }
        if components.scheme == nil, destination.hasPrefix("/") {
            components.scheme = "file"
            components.host = ""
        }
        return components.url
    }

    /// The button a `button:<id>` destination names.
    static func replyButtonId(_ destination: String) -> String? {
        URL(string: destination.trimmingCharacters(in: .whitespaces)).flatMap(ReplyButtons.id(of:))
    }

    /// A reply button pill's padding past its glyphs on each side, and the
    /// gap kept between it and the words around it.
    static var replyPad: CGFloat { zoomed(8) }
    static var replyGap: CGFloat { zoomed(3) }

    nonisolated(unsafe) static let urlDetector = try! NSDataDetector(types: NSTextCheckingResult.CheckingType.link.rawValue)

    struct Rendered {
        let string: NSAttributedString
        let blocks: [String]
        /// UTF-16 offset where each block starts in `string`.
        let starts: [Int]
        /// Room a code block's box needs below the last line when the
        /// message ends with one (paragraph spacing after the last paragraph
        /// doesn't count in TextKit's height).
        var trailingPad: CGFloat = 0
    }

    /// How far a code block's box reaches past its text.
    static var codePad: CGFloat { zoomed(12) }
    /// How far an inline code pill reaches past its glyphs on each side,
    /// and the space kerned in either side of the run to make room for it.
    static var pillPad: CGFloat { zoomed(2.5) }
    static var pillKern: CGFloat { zoomed(4) }

    nonisolated(unsafe) private static let cache: NSCache<NSString, NSAttributedString> = {
        let cache = NSCache<NSString, NSAttributedString>()
        // Mostly for streaming (finished blocks of the open message) and
        // re-rendering at a new width; finished rows live in RenderCache.
        cache.countLimit = 1500
        cache.totalCostLimit = 2_000_000 // UTF-16 code units
        return cache
    }()

    /// Whether a picture in the words (`![](/path/shot.png)`) may be read
    /// from this Mac and drawn: not for another Mac's thread, whose paths
    /// are that Mac's, as a runner could otherwise put any picture on this
    /// Mac into its reply (Codex review, 7 Nov). Set for one render on the
    /// thread doing it (RenderCache.render), so the cache keys on it too.
    static var localPictures: Bool {
        (Thread.current.threadDictionary[localPicturesKey] as? Bool) ?? true
    }

    private static let localPicturesKey = "com.mikerosoft.threadbear.localPictures"

    static func withLocalPictures<T>(_ allowed: Bool, _ body: () -> T) -> T {
        let dictionary = Thread.current.threadDictionary
        let saved = dictionary[localPicturesKey]
        dictionary[localPicturesKey] = allowed
        defer { dictionary[localPicturesKey] = saved }
        return body()
    }

    static func render(_ text: String) -> Rendered {
        let blocks = MarkdownBlocks.split(text)
        let output = NSMutableAttributedString()
        var starts: [Int] = []
        starts.reserveCapacity(blocks.count)
        // TextKit ignores spacing before the first paragraph, so a message
        // that opens with a code block gets a tiny spacer line for its box's
        // top padding to sit in. The first block's kind never changes as a
        // message streams, so block offsets stay stable.
        if let first = blocks.first, isCodeBlock(first) { output.append(leadingSpacer) }
        for (index, block) in blocks.enumerated() {
            if index > 0 { output.append(separator) }
            starts.append(output.length)
            output.append(renderBlock(block))
        }
        let pad = blocks.last.map(isCodeBlock) == true ? codePad : 0
        return Rendered(string: output, blocks: blocks, starts: starts, trailingPad: pad)
    }

    static func isCodeBlock(_ block: String) -> Bool {
        let trimmed = block.drop(while: { $0 == " " })
        return trimmed.hasPrefix("```") || trimmed.hasPrefix("~~~")
    }

    private static let leadingSpacer: NSAttributedString = {
        let (style, _) = Theme.lines(1, font: .systemFont(ofSize: 1))
        return NSAttributedString(string: "\u{200B}\n", attributes: [.font: NSFont.systemFont(ofSize: 1), .paragraphStyle: style])
    }()

    /// How deep quotes and lists may nest before a block is drawn as words.
    static let maxNesting = 32
    /// Emphasis, links and pictures nest too (`*a *b … b* a*`, `![![x](u)](u)`),
    /// a level for each of these marks at most. A block with more than a
    /// few is parsed on a thread with room for every level; past the most
    /// it's words.
    static let inlineMarksOnWorkerStack = 48
    static let maxInlineMarks = 4_000
    /// Short rows are padded to a table's header, so 9 KB can ask for 1.6
    /// million cells (cross-lab review, 7 Nov 2026). Past this it's words.
    static let maxTableCells = 20_000

    static func renderBlock(_ block: String) -> NSAttributedString {
        // Counted in what the parser gets: escaping work: links decodes
        // `%2A` into `*` (cross-lab review, 7 Nov 2026).
        let marks = MarkdownNesting.inlineMarks(WorkLinks.escapeDestinations(block))
        guard marks > inlineMarksOnWorkerStack, marks <= maxInlineMarks else { return renderBlockHere(block) }
        // 256 MB holds 4,000 levels with room to spare (each takes a few KB
        // between swift-markdown and the Builder); a worker's is 512 KB.
        let done = DispatchSemaphore(value: 0)
        nonisolated(unsafe) var result: NSAttributedString?
        let thread = Thread {
            result = renderBlockHere(block)
            done.signal()
        }
        thread.stackSize = 256 << 20
        thread.start()
        done.wait()
        return result ?? NSAttributedString(string: block)
    }

    private static func renderBlockHere(_ block: String) -> NSAttributedString {
        // The zoom is in the key: a block's layout is all sizes. A block
        // that may hold a ```mermaid or ```html box also keys on whether
        // those have been drawn, or flipped to their source (RichBlocks).
        let rich = RichBlocks.mayHoldRich(block)
        // One that links a reply button keys on the buttons' states.
        let buttons = ReplyButtons.mayHold(block) ? ReplyButtons.shared.generation : -1
        let key = "\(TypeScale.percent)|\(rich ? RichBlocks.shared.generation : -1)|\(buttons)|\(localPictures ? 1 : 0)|\(block)" as NSString
        if let cached = cache.object(forKey: key) { return cached }
        // `[tests pass](work:npm test)`: a space ends a link's destination
        // for the parser, so work: and thread: links are escaped first.
        var builder = Builder()
        // Quotes or lists nested past this are plain words: parsing and
        // drawing them recurse once a level, on worker threads with small
        // stacks, and 8,000 `>`s from a reply ran one out (Daybreak, 7 Nov
        // 2026). Nothing anyone writes nests this deep.
        let source = WorkLinks.escapeDestinations(block)
        if MarkdownNesting.bound(source) > maxNesting || MarkdownNesting.inlineMarks(source) > maxInlineMarks || MarkdownNesting.tableCells(source) > maxTableCells {
            let start = builder.output.length
            builder.append(block, Context())
            builder.finishParagraph(from: start, style: builder.paragraphStyle(Context()))
            builder.trimTrailingNewline()
            let result = NSAttributedString(attributedString: builder.output)
            cache.setObject(result, forKey: key, cost: block.utf16.count)
            return result
        }
        let document = Document(parsing: source, options: [.disableSmartOpts])
        // Split where cmark ends lines: "\n", "\r" and "\r\n" (one
        // Character), not U+2028 and the other separators Swift counts.
        if rich || DraftBlock.mayHold(block) {
            builder.sourceLines = block.split(omittingEmptySubsequences: false, whereSeparator: { $0 == "\n" || $0 == "\r\n" || $0 == "\r" })
        }
        for child in document.children {
            builder.block(child, Context())
        }
        builder.trimTrailingNewline()
        builder.linkBareURLs()
        builder.freeLinesWithPictures()
        let result = NSAttributedString(attributedString: builder.output)
        cache.setObject(result, forKey: key, cost: block.utf16.count)
        return result
    }

    /// How big an inline picture is drawn at most, in points before zoom.
    static var pictureMaxWidth: CGFloat { zoomed(420) }
    static var pictureMaxHeight: CGFloat { zoomed(320) }

    /// A picture the agent wrote as `![alt](/path/to/file.png)`, drawn at
    /// most pictureMaxWidth by pictureMaxHeight. Nil for a file that isn't
    /// there or isn't a picture. Decoded here, off the main thread, at the
    /// size it's drawn (twice, for Retina); the block's cache keeps it.
    static func picture(path: String, alt: String) -> NSTextAttachment? {
        guard FileManager.default.fileExists(atPath: path) else { return nil }
        let scale: CGFloat = 2
        guard let image = ThumbnailLoader.decode(path: path, maxPixels: Int(max(pictureMaxWidth, pictureMaxHeight) * scale)) else { return nil }
        var size = CGSize(width: CGFloat(image.width) / scale, height: CGFloat(image.height) / scale)
        let fit = min(1, pictureMaxWidth / max(size.width, 1), pictureMaxHeight / max(size.height, 1))
        size = CGSize(width: (size.width * fit).rounded(), height: (size.height * fit).rounded())
        let attachment = NSTextAttachment()
        attachment.image = NSImage(cgImage: image, size: size)
        attachment.bounds = CGRect(origin: .zero, size: size)
        return attachment
    }

    private static var separator: NSAttributedString { NSAttributedString(string: "\n", attributes: Theme.bodyAttributes) }

    struct Context {
        var bold = false
        var italic = false
        var code = false
        var strike = false
        var link: URL?
        var color: NSColor = .labelColor
        var indent: CGFloat = 0
        var headingLevel = 0
        var listSpacing: CGFloat?
    }

    struct Builder {
        let output = NSMutableAttributedString()
        /// The block's lines, when it may hold a rich block: a fence still
        /// open (a reply streaming in) stays code until it's closed.
        var sourceLines: [Substring] = []

        /// Body lines have a fixed height, which would cut a picture down to
        /// one line: a paragraph with one gets a style that lets it grow,
        /// and the picture sits on the baseline.
        mutating func freeLinesWithPictures() {
            let text = output.string as NSString
            output.enumerateAttribute(.attachment, in: NSRange(location: 0, length: output.length)) { value, range, _ in
                guard value is NSTextAttachment else { return }
                let paragraph = text.paragraphRange(for: range)
                let old = output.attribute(.paragraphStyle, at: range.location, effectiveRange: nil) as? NSParagraphStyle ?? NSParagraphStyle.default
                let style = (old.mutableCopy() as? NSMutableParagraphStyle) ?? NSMutableParagraphStyle()
                style.minimumLineHeight = 0
                style.maximumLineHeight = 0
                output.addAttribute(.paragraphStyle, value: style, range: paragraph)
                output.addAttribute(.baselineOffset, value: 0, range: range)
            }
        }

        mutating func trimTrailingNewline() {
            while output.length > 0, output.string.utf16.last == 10 {
                output.deleteCharacters(in: NSRange(location: output.length - 1, length: 1))
            }
        }

        func font(_ context: Context) -> NSFont {
            if context.code { return context.bold ? Theme.codeBoldFont : Theme.codeFont }
            var font: NSFont
            switch context.headingLevel {
            case 1...3: font = Self.headingFont(context.headingLevel)
            case 4...: font = Theme.boldFont
            default: font = context.bold ? Theme.boldFont : Theme.bodyFont
            }
            if context.italic {
                font = NSFontManager.shared.convert(font, toHaveTrait: .italicFontMask)
            }
            return font
        }

        func attributes(_ context: Context) -> [NSAttributedString.Key: Any] {
            var attributes: [NSAttributedString.Key: Any] = [.font: font(context), .foregroundColor: context.color]
            // Drawn by BackgroundLayoutManager as a rounded pill with a little
            // padding, which `.backgroundColor` (a tight glyph box) can't do.
            if context.code && context.headingLevel == 0 { attributes[.tbInlineBackground] = Theme.inlineCodeBackground }
            if context.strike { attributes[.strikethroughStyle] = NSUnderlineStyle.single.rawValue }
            if let link = context.link {
                attributes[.link] = link
                attributes[.foregroundColor] = NSColor.linkColor
                // Otherwise the tip is the raw link, `tbpath:?p=…` for a path.
                if link.isFileURL || FilePathRefs.text(of: link) != nil {
                    attributes[.toolTip] = "Click to open, right-click for more"
                }
            }
            return attributes
        }

        func append(_ text: String, _ context: Context) {
            output.append(NSAttributedString(string: text, attributes: attributes(context)))
        }

        /// Gap after a paragraph, and between list items.
        static var paragraphGap: CGFloat { zoomed(10) }
        static var itemGap: CGFloat { zoomed(6) }

        func paragraphStyle(_ context: Context, spacing: CGFloat? = nil, before: CGFloat = 0, first: CGFloat? = nil, tabs: [CGFloat] = [],
                            line: CGFloat = Theme.bodyLine, font: NSFont = Theme.bodyFont) -> (style: NSParagraphStyle, offset: CGFloat) {
            let (style, offset) = Theme.lines(line, font: font, spacing: spacing ?? context.listSpacing ?? Self.paragraphGap,
                                              before: before, head: context.indent, first: first)
            if !tabs.isEmpty {
                style.tabStops = tabs.map { NSTextTab(textAlignment: .left, location: $0) }
                style.defaultTabInterval = zoomed(28)
            }
            return (style, offset)
        }

        mutating func finishParagraph(from start: Int, style: (style: NSParagraphStyle, offset: CGFloat)) {
            append("\n", Context())
            let range = NSRange(location: start, length: output.length - start)
            output.addAttribute(.paragraphStyle, value: style.style, range: range)
            // One offset for the whole line, so smaller runs (inline code)
            // share the body text's baseline.
            output.addAttribute(.baselineOffset, value: style.offset, range: range)
        }

        /// swift-markdown leaves a bare URL like http://localhost:5176 as
        /// plain text (it doesn't run GFM's autolink extension), and agents
        /// write them that way all the time. Done over the whole block, not
        /// per Text node, because cmark splits text at characters like `_`.
        /// Only http(s) with the scheme written out: the detector also
        /// guesses at words like CLAUDE.md, which aren't links. Code blocks
        /// stay as they are; inline code that's a URL gets linked.
        mutating func linkBareURLs() {
            let text = output.string
            guard text.contains("://") else { return }
            for match in MarkdownRenderer.urlDetector.matches(in: text, range: NSRange(location: 0, length: output.length)) {
                let range = match.range
                let word = output.mutableString.substring(with: range).lowercased()
                guard word.hasPrefix("http://") || word.hasPrefix("https://"), let url = match.url else { continue }
                var taken = false
                output.enumerateAttributes(in: range) { attributes, _, stop in
                    if attributes[.link] != nil || attributes[.tbBlockBackground] != nil { taken = true; stop.pointee = true }
                }
                guard !taken else { continue }
                output.addAttribute(.link, value: url, range: range)
                output.addAttribute(.foregroundColor, value: NSColor.linkColor, range: range)
                // A link keeps its own destination, not a thread chip.
                output.removeAttribute(.tbThreadRef, range: range)
            }
        }

        // MARK: Blocks

        mutating func block(_ markup: Markup, _ context: Context, listPrefix: String? = nil) {
            switch markup {
            case let paragraph as Paragraph:
                let start = output.length
                var first: CGFloat?
                var tabs: [CGFloat] = []
                if let listPrefix {
                    appendMarker(listPrefix, context)
                    first = Self.markerStart(listPrefix, indent: context.indent)
                    tabs = [context.indent]
                }
                inlines(paragraph.children, context)
                finishParagraph(from: start, style: paragraphStyle(context, first: first, tabs: tabs))

            case let heading as Heading:
                var inner = context
                inner.headingLevel = heading.level
                let start = output.length
                inlines(heading.children, inner)
                // 16 above in all (the paragraph before leaves 10), 6 below.
                let font = Self.headingFont(heading.level)
                finishParagraph(from: start, style: paragraphStyle(context, spacing: zoomed(6), before: zoomed(6), line: ceil(font.pointSize * 1.4), font: font))

            case let code as CodeBlock:
                if let rich = richBlock(code) {
                    richBlock(rich, context)
                } else if let draft = draftBlock(code) {
                    draftBlock(draft, context)
                } else {
                    codeBlock(code.code, context)
                }

            case let quote as BlockQuote:
                var inner = context
                inner.indent += zoomed(14)
                inner.color = .secondaryLabelColor
                for child in quote.children { block(child, inner) }

            case let list as UnorderedList:
                listItems(Array(list.listItems), context) { _, item in
                    switch item.checkbox {
                    case .checked?: return "☑"
                    case .unchecked?: return "☐"
                    case nil: return "•"
                    }
                }

            case let list as OrderedList:
                let startIndex = Int(list.startIndex)
                listItems(Array(list.listItems), context) { index, _ in "\(startIndex + index)." }

            case is ThematicBreak:
                let start = output.length
                var inner = context
                inner.color = .tertiaryLabelColor
                append(String(repeating: "─", count: 24), inner)
                finishParagraph(from: start, style: paragraphStyle(context))

            case let table as Markdown.Table:
                renderTable(table, context)

            case let html as HTMLBlock:
                var inner = context
                inner.color = .secondaryLabelColor
                inner.code = true
                let start = output.length
                append(html.rawHTML.trimmingCharacters(in: .newlines), inner)
                finishParagraph(from: start, style: paragraphStyle(context))

            default:
                if markup.childCount > 0, markup is BlockContainer {
                    for child in markup.children { block(child, context) }
                } else {
                    let start = output.length
                    append(markup.format().trimmingCharacters(in: .newlines), context)
                    finishParagraph(from: start, style: paragraphStyle(context))
                }
            }
        }

        static func headingFont(_ level: Int) -> NSFont {
            switch level {
            case 1: return .systemFont(ofSize: TypeScale.headings.0, weight: .semibold)
            case 2: return .systemFont(ofSize: TypeScale.headings.1, weight: .semibold)
            default: return .systemFont(ofSize: TypeScale.headings.2, weight: .semibold)
            }
        }

        /// How far a list's text sits in from its parent's. At 22, with the
        /// marker 2 pt from the column edge, lists looked cramped against
        /// the paragraphs around them; Claude's sit clearly in.
        static var listIndent: CGFloat { zoomed(30) }

        /// Where an item's marker starts: a bullet 18 pt before the text, a
        /// number a little further out so "10." still fits before it.
        static func markerStart(_ marker: String, indent: CGFloat) -> CGFloat {
            max(0, indent - zoomed(marker == "•" ? 18 : 22))
        }

        /// A list marker and the tab to the item's text. The bullet is drawn
        /// semibold: at the body weight it read small beside 15 pt text.
        func appendMarker(_ marker: String, _ context: Context) {
            var markerContext = context
            markerContext.link = nil
            markerContext.strike = false
            if marker == "•" { markerContext.bold = true }
            append(marker, markerContext)
            append("\t", context)
        }

        mutating func listItems(_ items: [ListItem], _ context: Context, marker: (Int, ListItem) -> String) {
            var inner = context
            inner.indent += Self.listIndent
            for (index, item) in items.enumerated() {
                var itemContext = inner
                itemContext.listSpacing = index == items.count - 1 && context.listSpacing == nil ? Self.paragraphGap : Self.itemGap
                var first = true
                for child in item.children {
                    if first, child is Paragraph {
                        block(child, itemContext, listPrefix: marker(index, item))
                    } else {
                        if first {
                            // A list item that starts with something other than text still gets its marker.
                            let start = output.length
                            let mark = marker(index, item)
                            append(mark, itemContext)
                            finishParagraph(from: start, style: paragraphStyle(itemContext, spacing: zoomed(2), first: Self.markerStart(mark, indent: itemContext.indent)))
                        }
                        block(child, itemContext)
                    }
                    first = false
                }
            }
        }

        /// A closed ```mermaid or ```html fence, to draw as what it shows.
        func richBlock(_ code: CodeBlock) -> RichBlock? {
            guard let rich = RichBlock.from(language: code.language, code: code.code), isClosed(code) else { return nil }
            return rich
        }

        /// A closed ```slack, ```email or ```draft fence (DraftBlock). One
        /// still streaming in stays code until it's closed, as above.
        func draftBlock(_ code: CodeBlock) -> DraftBlock? {
            guard let draft = DraftBlock.from(language: code.language, code: code.code), isClosed(code) else { return nil }
            return draft
        }

        /// Whether the fence has its closing line. cmark ends an unclosed
        /// fence's range on its last line of code, so the range's last line
        /// is checked: the same character the fence opened with, at least
        /// as many, behind as many quote markers as the opening line. Its
        /// indent isn't checked: list indents are cmark's to work out
        /// (three tries at it each broke a nested case, 6 Nov), and the
        /// worst a line of code indented like a fence can do is show a
        /// box a moment early while it streams in.
        private func isClosed(_ code: CodeBlock) -> Bool {
            guard !sourceLines.isEmpty, let range = code.range, range.lowerBound.line >= 1,
                  range.upperBound.line > range.lowerBound.line, range.upperBound.line <= sourceLines.count else { return false }
            let openingLine = sourceLines[range.lowerBound.line - 1].utf8
            // cmark's columns count UTF-8 bytes, from 1.
            let container = range.lowerBound.column - 1
            guard container >= 0, container <= openingLine.count else { return false }
            let opening = Substring(openingLine.dropFirst(container))
            guard let mark = opening.first, mark == "`" || mark == "~" else { return false }
            let width = opening.prefix(while: { $0 == mark }).count
            guard width >= 3 else { return false }
            let quotes = openingLine.prefix(container).filter { $0 == UInt8(ascii: ">") }.count
            var closing = Substring(sourceLines[range.upperBound.line - 1])
            for _ in 0..<quotes {
                closing = closing.drop(while: { $0 == " " || $0 == "\t" })
                guard closing.first == ">" else { return false }
                closing = closing.dropFirst()
            }
            let fence = closing.trimmingCharacters(in: .whitespaces)
            return fence.count >= width && fence.allSatisfy({ $0 == mark })
        }

        /// A draft's box: the header (DraftBlockCell) and then each of the
        /// draft's lines as a paragraph of its own, kept as the agent wrote
        /// them, in one rounded box like a code block's.
        mutating func draftBlock(_ draft: DraftBlock, _ context: Context) {
            let pad = MarkdownRenderer.codePad
            // One colour object for the whole box, so it's drawn as one.
            let fill = Theme.codeBackground
            let head = context.indent + pad
            let start = output.length

            let attachment = NSTextAttachment()
            attachment.attachmentCell = DraftBlockCell(draft: draft)
            let header = NSMutableAttributedString(attachment: attachment)
            // A copy of a selection across it gives the draft's words, not
            // a stray box character.
            header.addAttribute(.tbCopyText, value: "", range: NSRange(location: 0, length: header.length))
            output.append(header)
            append("\n", Context())
            let (headerStyle, _) = Theme.lines(DraftBlockCell.height, font: Theme.bodyFont, spacing: zoomed(6), before: pad, head: head, tail: -pad)
            output.addAttribute(.paragraphStyle, value: headerStyle, range: NSRange(location: start, length: output.length - start))

            let lines = draft.lines
            for (index, line) in lines.enumerated() {
                let lineStart = output.length
                var inner = context
                inner.indent = 0
                if line.quote {
                    inner.color = .secondaryLabelColor
                    var bar = inner
                    bar.color = .tertiaryLabelColor
                    append("\u{2502} ", bar)
                }
                for span in line.spans {
                    var look = inner
                    look.bold = span.bold
                    look.italic = span.italic
                    look.strike = span.strike
                    look.code = span.code
                    look.link = span.link
                    append(span.text, look)
                }
                if draft.kind != .slack { linkBareURLs(from: lineStart) }
                let last = index == lines.count - 1
                let (style, offset) = Theme.lines(Theme.bodyLine, font: Theme.bodyFont, spacing: last ? Self.paragraphGap + pad : 0,
                                                  before: index == 0 ? zoomed(8) : 0, head: head, tail: -pad)
                append("\n", Context())
                let range = NSRange(location: lineStart, length: output.length - lineStart)
                output.addAttribute(.paragraphStyle, value: style, range: range)
                output.addAttribute(.baselineOffset, value: offset, range: range)
                // The line under the header, across the box.
                if index == 0 { output.addAttribute(.tbRowRule, value: true, range: NSRange(location: lineStart, length: 1)) }
            }
            output.addAttribute(.tbBlockBackground, value: fill, range: NSRange(location: start, length: output.length - start))
        }

        /// Links an email or plain draft's bare web addresses (the reply's
        /// own pass skips anything in a box).
        mutating func linkBareURLs(from start: Int) {
            let range = NSRange(location: start, length: output.length - start)
            guard range.length > 0, output.mutableString.substring(with: range).contains("://") else { return }
            for match in MarkdownRenderer.urlDetector.matches(in: output.string, range: range) {
                let word = output.mutableString.substring(with: match.range).lowercased()
                guard word.hasPrefix("http://") || word.hasPrefix("https://"), let url = match.url else { continue }
                output.addAttribute(.link, value: url, range: match.range)
                output.addAttribute(.foregroundColor, value: NSColor.linkColor, range: match.range)
            }
        }

        /// The box (RichBlockCell): one attachment on a line of its own.
        mutating func richBlock(_ block: RichBlock, _ context: Context) {
            let cell = RichBlockCell(block: block, state: RichBlocks.shared.state(block), showsSource: RichBlocks.shared.showsSource(block.id))
            let attachment = NSTextAttachment()
            attachment.attachmentCell = cell
            let start = output.length
            let fence = block.source.contains("```") ? "~~~~" : "```"
            let box = NSMutableAttributedString(attachment: attachment)
            box.addAttribute(.tbCopyText, value: "\(fence)\(block.kind.rawValue)\n\(block.source)\n\(fence)", range: NSRange(location: 0, length: box.length))
            output.append(box)
            finishParagraph(from: start, style: paragraphStyle(context))
        }

        mutating func codeBlock(_ code: String, _ context: Context) {
            var text = code
            while text.hasSuffix("\n") { text.removeLast() }
            if text.isEmpty { text = " " }
            // U+2028 keeps the block one paragraph, so spacing before and
            // after applies once around the whole box. The box reaches
            // `codePad` past the text on every side (BackgroundLayoutManager),
            // so the spacing leaves the usual paragraph gap outside it.
            let body = text.replacingOccurrences(of: "\r\n", with: "\n").replacingOccurrences(of: "\n", with: "\u{2028}")
            let pad = MarkdownRenderer.codePad
            let (style, offset) = Theme.lines(Theme.codeLine, font: Theme.codeFont, spacing: Self.paragraphGap + pad, before: pad,
                                              head: context.indent + pad, tail: -pad)
            style.lineBreakMode = .byCharWrapping
            let start = output.length
            output.append(NSAttributedString(string: body, attributes: [
                .font: Theme.codeFont,
                .foregroundColor: NSColor.labelColor,
                .tbBlockBackground: Theme.codeBackground,
            ]))
            append("\n", Context())
            let range = NSRange(location: start, length: output.length - start)
            output.addAttribute(.paragraphStyle, value: style, range: range)
            output.addAttribute(.baselineOffset, value: offset, range: range)
        }

        /// Space either side of a column boundary, and above and below a
        /// row's text (its rule sits in the middle of the gap).
        static var cellPadH: CGFloat { zoomed(12) }
        static var cellPadV: CGFloat { zoomed(4) }

        /// A grid like the references draw: a rule under the header and
        /// hairlines between rows. Each cell is its own paragraph in an
        /// NSTextTable, so a long cell wraps inside its own column (tab stops
        /// wrapped it back under the first one, and a cell wider than its
        /// stop pushed the rest of the row along).
        mutating func renderTable(_ table: Markdown.Table, _ context: Context) {
            var rows: [[NSAttributedString]] = []
            func cells(_ cells: some Sequence<Markdown.Table.Cell>, header: Bool) -> [NSAttributedString] {
                cells.map { cell in
                    var inner = Builder()
                    var cellContext = context
                    cellContext.indent = 0
                    if header { cellContext.color = .secondaryLabelColor }
                    inner.inlines(cell.children, cellContext)
                    let text = NSMutableAttributedString(attributedString: inner.output)
                    if header {
                        // Smaller and semibold, like a column label; code
                        // stays in its own font.
                        text.enumerateAttribute(.font, in: NSRange(location: 0, length: text.length)) { value, range, _ in
                            guard (value as? NSFont)?.isFixedPitch != true else { return }
                            text.addAttribute(.font, value: Self.tableHeaderFont, range: range)
                        }
                    }
                    return text
                }
            }
            rows.append(cells(table.head.cells, header: true))
            for row in table.body.rows { rows.append(cells(row.cells, header: false)) }
            let columns = rows.map(\.count).max() ?? 0
            guard columns > 0 else { return }

            // Natural widths, fitted to the widest reading column. A
            // narrower column scales the whole table down to fit.
            var natural = Array(repeating: 0.0, count: columns)
            for row in rows {
                for (index, cell) in row.enumerated() {
                    natural[index] = max(natural[index], Double(ceil(cell.size().width) + 1))
                }
            }
            let budget = Double(Theme.maxContentWidth - context.indent - CGFloat(columns - 1) * Self.cellPadH * 2)
            let widths = TableColumns.fit(natural, into: budget)

            let grid = NSTextTable()
            grid.numberOfColumns = columns
            grid.collapsesBorders = true
            grid.hidesEmptyCells = false
            let (lineStyle, offset) = Theme.lines(Theme.bodyLine, font: Theme.bodyFont)
            for (rowIndex, row) in rows.enumerated() {
                let isLast = rowIndex == rows.count - 1
                for column in 0..<columns {
                    let block = NSTextTableBlock(table: grid, startingRow: rowIndex, rowSpan: 1, startingColumn: column, columnSpan: 1)
                    block.setValue(CGFloat(widths[column]), type: .absoluteValueType, for: .width)
                    block.setWidth(Self.cellPadV, type: .absoluteValueType, for: .padding, edge: .minY)
                    // The paragraph gap after the table goes inside the last
                    // row (it has no rule): a margin there was ignored.
                    block.setWidth(Self.cellPadV + (isLast ? Self.paragraphGap : 0), type: .absoluteValueType, for: .padding, edge: .maxY)
                    // The first column's text lines up with the paragraphs
                    // around the table, and the last one ends at its text.
                    block.setWidth(column == 0 ? 0 : Self.cellPadH, type: .absoluteValueType, for: .padding, edge: .minX)
                    block.setWidth(column == columns - 1 ? 0 : Self.cellPadH, type: .absoluteValueType, for: .padding, edge: .maxX)
                    if column == 0, context.indent > 0 {
                        block.setWidth(context.indent, type: .absoluteValueType, for: .margin, edge: .minX)
                    }
                    if !isLast {
                        block.setWidth(rowIndex == 0 ? 1 : 0.5, type: .absoluteValueType, for: .border, edge: .maxY)
                        block.setBorderColor(rowIndex == 0 ? Theme.cardBorder : Theme.hairline, for: .maxY)
                    }
                    let style = lineStyle.mutableCopy() as! NSMutableParagraphStyle
                    style.paragraphSpacing = 0
                    style.textBlocks = [block]
                    let start = output.length
                    // An empty cell still needs a character: the message's
                    // trailing newlines are trimmed, and an empty last cell
                    // would lose its paragraph (and its column).
                    let cell = column < row.count ? row[column] : NSAttributedString()
                    if cell.length > 0 { output.append(cell) } else { append("\u{200B}", context) }
                    append("\n", Context())
                    let range = NSRange(location: start, length: output.length - start)
                    output.addAttribute(.paragraphStyle, value: style, range: range)
                    output.addAttribute(.baselineOffset, value: offset, range: range)
                }
            }
        }

        static var tableHeaderFont: NSFont { .systemFont(ofSize: TypeScale.label, weight: .semibold) }

        // MARK: Inlines

        /// Marks thread-id-shaped words appended since `start`. Whether one
        /// is a real thread is only known when it's drawn (the thread list
        /// changes; renders are cached by their text), so this is just the
        /// shape. A link keeps its own destination.
        func markThreadRefs(from start: Int, _ context: Context) {
            guard context.link == nil, output.length > start else { return }
            let text = output.mutableString.substring(from: start)
            for found in ThreadRefs.candidates(in: text) {
                let range = NSRange(location: start + found.location, length: found.length)
                output.addAttribute(.tbThreadRef, value: output.mutableString.substring(with: range), range: range)
            }
        }

        /// `[title](button:<id>)`: the button the agent made with add_button,
        /// as a pill in the colours of its state (Theme.replyButton). Its
        /// words alone, not clickable, for a button this app doesn't know
        /// (another runner's, or one the list hasn't brought yet). The
        /// render depends on the button's state, so a block that may hold
        /// one keys its cache on `ReplyButtons.generation`.
        mutating func replyButton(_ id: String, words: String, _ context: Context) {
            var plain = context
            plain.link = nil
            guard let known = ReplyButtons.shared.known(id) else {
                append(words, plain)
                return
            }
            let button = known.button
            let look = ReplyButtons.look(button, pressing: ReplyButtons.shared.isPressing(id))
            let room = MarkdownRenderer.replyPad + MarkdownRenderer.replyGap
            let start = output.length
            // Room for the pill's padding and a gap, kerned into the
            // character before it as for inline code.
            if start > 0, ![9, 10, 0x2028].contains(output.mutableString.character(at: start - 1)) {
                output.addAttribute(.kern, value: room, range: NSRange(location: start - 1, length: 1))
            }
            // No-break spaces, so a pill doesn't wrap apart.
            let label = ReplyButtons.label(button, look: look).replacingOccurrences(of: " ", with: "\u{00A0}")
            output.append(NSAttributedString(string: label, attributes: [
                .font: NSFont.systemFont(ofSize: TypeScale.label, weight: .medium),
                .foregroundColor: Theme.replyButton(look).text,
                .tbReplyButton: id, .tbReplyLook: look.rawValue,
                .toolTip: ReplyButtons.tip(button, look: look),
            ]))
            output.addAttribute(.kern, value: room, range: NSRange(location: output.length - 1, length: 1))
        }

        mutating func inlines(_ children: MarkupChildren, _ context: Context) {
            for child in children { inline(child, context) }
        }

        mutating func inline(_ markup: Markup, _ context: Context) {
            switch markup {
            case let text as Markdown.Text:
                let start = output.length
                append(text.string, context)
                markThreadRefs(from: start, context)
            case let emphasis as Emphasis:
                var inner = context
                inner.italic = true
                inlines(emphasis.children, inner)
            case let strong as Strong:
                var inner = context
                inner.bold = true
                inlines(strong.children, inner)
            case let strike as Strikethrough:
                var inner = context
                inner.strike = true
                inlines(strike.children, inner)
            case let code as InlineCode:
                var inner = context
                inner.code = true
                if inner.link == nil, FilePathRefs.looksLikePath(code.code) { inner.link = FilePathRefs.url(for: code.code) }
                // A web address in code (`github.com/owner/repo`) is a link too, kept looking like code.
                else if inner.link == nil, let web = CodeWebAddress.url(code.code) { inner.link = web }
                // BackgroundLayoutManager draws the pill `pillPad` past the
                // glyphs on each side, which ate most of the word space
                // around it. Kerning the characters either side reserves
                // that room (and a little more) without changing the text.
                let start = output.length
                if start > 0, ![9, 10, 0x2028].contains(output.mutableString.character(at: start - 1)) {
                    output.addAttribute(.kern, value: MarkdownRenderer.pillKern, range: NSRange(location: start - 1, length: 1))
                }
                append(code.code, inner)
                markThreadRefs(from: start, context)
                if output.length > start {
                    output.addAttribute(.kern, value: MarkdownRenderer.pillKern, range: NSRange(location: output.length - 1, length: 1))
                }
            case let link as Markdown.Link where link.destination.flatMap(MarkdownRenderer.replyButtonId) != nil:
                replyButton(MarkdownRenderer.replyButtonId(link.destination!)!, words: link.plainText, context)
            case let link as Markdown.Link:
                var inner = context
                inner.link = link.destination.flatMap(MarkdownRenderer.linkURL)
                inlines(link.children, inner)
                // A link into the turn's own working says it goes up the
                // thread, not out of it (docs/end-turn-design).
                if let url = inner.link, WorkLinks.quote(of: url) != nil { append("\u{2009}↑", inner) }
            case let image as Markdown.Image:
                var inner = context
                inner.link = image.source.flatMap(MarkdownRenderer.linkURL)
                let alt = image.plainText.isEmpty ? (image.source ?? "image") : image.plainText
                // A picture on this Mac is drawn in the text; a web address,
                // or a file that's gone, stays a link with its alt text.
                if let url = inner.link, url.isFileURL, MarkdownRenderer.localPictures, let attachment = MarkdownRenderer.picture(path: url.path, alt: alt) {
                    let run = NSMutableAttributedString(attachment: attachment)
                    run.addAttributes([.link: url, .toolTip: alt], range: NSRange(location: 0, length: run.length))
                    output.append(run)
                } else {
                    append("[\(alt)]", inner)
                }
            case is SoftBreak:
                append(" ", context)
            case is LineBreak:
                append("\u{2028}", context)
            case let html as InlineHTML:
                var inner = context
                inner.color = .secondaryLabelColor
                append(html.rawHTML, inner)
            case let symbol as SymbolLink:
                var inner = context
                inner.code = true
                append(symbol.destination ?? "", inner)
            default:
                if markup.childCount > 0 {
                    for child in markup.children { inline(child, context) }
                } else {
                    append(markup.format(), context)
                }
            }
        }
    }
}
