import AppKit
import Observation
import Synchronization
import ThreadbearCore

/// The window's zoom: ⌘= and ⌘- in the View menu step it through `steps`
/// (percentages of the design sizes in `TypeScale` and every `zoomed`
/// layout size), ⌘0 puts it back, and it's remembered across launches.
/// Like a browser's or VS Code's zoom, everything grows together: text,
/// icons, paddings, row heights and the reading column's width. It used to
/// be text only, which left the icons and the room around them small
/// beside big text.
@Observable @MainActor
final class TextZoom {
    static let shared = TextZoom()
    nonisolated static let steps = [80, 90, 100, 110, 125, 140, 160, 180, 200]
    nonisolated static let defaultPercent = 100
    nonisolated static let defaultsKey = "textZoomPercent"
    /// Posted after the percent changes, for the AppKit side (the
    /// transcript, the composer) to re-lay itself out; SwiftUI views follow
    /// the observable `percent` on their own.
    nonisolated static let didChange = Notification.Name("TextZoom.didChange")
    /// The percent for any thread: rows render and measure off the main
    /// thread, and a render must not block on the main actor.
    nonisolated static let current = Atomic<Int>(defaultPercent)

    private(set) var percent: Int
    private let defaults: UserDefaults

    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
        let saved = defaults.integer(forKey: Self.defaultsKey)
        percent = Self.steps.contains(saved) ? saved : Self.defaultPercent
        Self.current.store(percent, ordering: .relaxed)
    }

    var canZoomIn: Bool { percent < Self.steps.last! }
    var canZoomOut: Bool { percent > Self.steps.first! }
    var isDefault: Bool { percent == Self.defaultPercent }

    func zoomIn() {
        if let next = Self.steps.first(where: { $0 > percent }) { set(next) }
    }

    func zoomOut() {
        if let next = Self.steps.last(where: { $0 < percent }) { set(next) }
    }

    func reset() { set(Self.defaultPercent) }

    func set(_ newPercent: Int) {
        guard Self.steps.contains(newPercent), newPercent != percent else { return }
        percent = newPercent
        Self.current.store(newPercent, ordering: .relaxed)
        if newPercent == Self.defaultPercent {
            defaults.removeObject(forKey: Self.defaultsKey)
        } else {
            defaults.set(newPercent, forKey: Self.defaultsKey)
        }
        NotificationCenter.default.post(name: Self.didChange, object: self)
    }
}

/// Every text size in the window, in one place. One step up from the
/// system's 13 pt default: at 14 pt body text Threadbear read about 2 pt
/// smaller than Codex and Claude beside it. Theme, the sidebar, the header
/// and the composer all take their sizes from here, each the design size
/// below scaled by `TextZoom`.
enum TypeScale {
    /// The zoom as a percent. On the main thread it reads the observable,
    /// so a SwiftUI body that asks for any size here re-renders when the
    /// zoom changes without each view having to watch it; renderers on
    /// other threads read the atomic copy.
    static var percent: Int {
        if Thread.isMainThread { return MainActor.assumeIsolated { TextZoom.shared.percent } }
        return TextZoom.current.load(ordering: .relaxed)
    }

    /// `size` at the current zoom, to a whole point (except at 100%, where
    /// the design sizes stand as written, half points and all): half-point
    /// steps made neighbouring text almost, but not quite, the same size.
    static func scaled(_ size: CGFloat) -> CGFloat {
        let percent = percent
        return percent == 100 ? size : (size * CGFloat(percent) / 100).rounded()
    }

    // Transcript
    static var body: CGFloat { scaled(15) }
    /// Fixed line heights, with the glyphs centred in them (see
    /// `Theme.lines`): about 1.5 times the text size, like the apps Mike
    /// compares this with.
    static var bodyLine: CGFloat { scaled(23) }
    /// Work lines: group summaries, tool and thinking rows, the working line.
    static var work: CGFloat { scaled(14) }
    static var workLine: CGFloat { scaled(20) }
    /// One monospaced size and leading for code blocks, tool output and
    /// diffs: at 12.5 and 13 a file read in a tool and the code block under
    /// it visibly differed in size and line spacing.
    static var code: CGFloat { scaled(13) }
    static var codeLine: CGFloat { scaled(19.5) }
    /// Tool output and file contents in an expanded tool.
    static var output: CGFloat { code }
    static var outputLine: CGFloat { codeLine }
    static var diff: CGFloat { code }
    static var diffLine: CGFloat { codeLine }
    static var headings: (CGFloat, CGFloat, CGFloat) { (scaled(18), scaled(16), scaled(15)) }
    static var cardTitle: CGFloat { scaled(14) }
    /// Card labels, notes and table headers.
    static var label: CGFloat { scaled(13) }
    /// Folders after file names, "Show 12 more lines", line counts. Whole
    /// points throughout, see `scaled`.
    static var detail: CGFloat { scaled(12) }
    /// The turn footer and centred system notes.
    static var small: CGFloat { scaled(11) }

    // Sidebar
    static var sidebarTitle: CGFloat { scaled(14) }
    static var sidebarPreview: CGFloat { scaled(13) }
    /// Times, statuses and account names on a row.
    static var sidebarMeta: CGFloat { scaled(11) }
    /// "Needs you", "Running", "Inbox": semibold at the previews' size, so a
    /// heading isn't weaker than the rows it groups.
    static var sidebarHeading: CGFloat { scaled(13) }
    static var sidebarButton: CGFloat { scaled(14) }
    static var sidebarFooter: CGFloat { scaled(13) }

    // Header and composer
    /// At 14 the title was smaller than the 15 pt text under it; Codex and
    /// Claude set theirs at about 15.
    static var header: CGFloat { scaled(15) }
    static var composer: CGFloat { scaled(15) }
    static var chip: CGFloat { scaled(13) }
}

/// A layout size (a padding, spacing, icon, frame or corner radius) at the
/// current zoom, like a CSS pixel under a browser's zoom, rounded the same
/// way as the text sizes. Hairline widths and half-point nudges that line
/// things up on pixels stay as written.
func zoomed(_ size: CGFloat) -> CGFloat { TypeScale.scaled(size) }

/// Fonts, colours and spacing for the transcript. Colours are dynamic so
/// cached attributed strings follow light and dark mode. The fonts are
/// computed, not stored, so they follow `TextZoom` (AppKit caches system
/// fonts by size, so asking is cheap).
enum Theme {
    static var bodySize: CGFloat { TypeScale.body }
    static var bodyLine: CGFloat { TypeScale.bodyLine }
    static var codeSize: CGFloat { TypeScale.code }
    static var codeLine: CGFloat { TypeScale.codeLine }
    static var diffSize: CGFloat { TypeScale.diff }
    static var diffLine: CGFloat { TypeScale.diffLine }
    static var bodyFont: NSFont { .systemFont(ofSize: bodySize) }
    static var boldFont: NSFont { .systemFont(ofSize: bodySize, weight: .semibold) }
    /// Made through the font manager, which isn't cached like the system
    /// fonts, so one per size is kept here (renders ask from any thread).
    static var italicFont: NSFont {
        let size = bodySize
        return italics.withLock { fonts in
            if let font = fonts[size] { return font }
            let font = NSFontManager.shared.convert(NSFont.systemFont(ofSize: size), toHaveTrait: .italicFontMask)
            fonts[size] = font
            return font
        }
    }
    private static let italics = Mutex<[CGFloat: NSFont]>([:])
    static var codeFont: NSFont { .monospacedSystemFont(ofSize: codeSize, weight: .regular) }
    static var codeBoldFont: NSFont { .monospacedSystemFont(ofSize: codeSize, weight: .semibold) }
    static var diffFont: NSFont { .monospacedSystemFont(ofSize: diffSize, weight: .regular) }
    static var outputFont: NSFont { .monospacedSystemFont(ofSize: TypeScale.output, weight: .regular) }
    static var smallFont: NSFont { .systemFont(ofSize: TypeScale.small) }
    static var labelFont: NSFont { .systemFont(ofSize: TypeScale.label) }
    static var detailFont: NSFont { .systemFont(ofSize: TypeScale.detail) }
    static var workFont: NSFont { .systemFont(ofSize: TypeScale.work) }
    static var workLine: CGFloat { TypeScale.workLine }
    /// A one-line label's height for `workFont`, so work lines centre their
    /// text the same way whatever the scale.
    static var workLabelHeight: CGFloat {
        let font = workFont
        return ceil(font.ascender - font.descender + font.leading)
    }
    static var cardTitleFont: NSFont { .systemFont(ofSize: TypeScale.cardTitle, weight: .semibold) }
    /// "Edited 3 files": quieter than a card that asks something.
    static var changesTitleFont: NSFont { .systemFont(ofSize: TypeScale.cardTitle, weight: .medium) }
    static var statsFont: NSFont { .monospacedDigitSystemFont(ofSize: TypeScale.detail, weight: .regular) }

    /// One digit's advance in a monospaced font, for line number gutters.
    static func digitWidth(_ font: NSFont) -> CGFloat {
        ceil(("0" as NSString).size(withAttributes: [.font: font]).width * 4) / 4
    }

    /// Widest the reading column gets; wider windows centre it.
    static var maxContentWidth: CGFloat { zoomed(780) }
    static var sideInset: CGFloat { zoomed(28) }

    private static func dynamic(dark: NSColor, light: NSColor) -> NSColor {
        NSColor(name: nil) { appearance in
            appearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua ? dark : light
        }
    }

    /// Faint fills for code blocks, tool output and cards.
    static let codeBackground = dynamic(dark: NSColor(white: 1, alpha: 0.045), light: NSColor(white: 0, alpha: 0.03))
    static let inlineCodeBackground = dynamic(dark: NSColor(white: 1, alpha: 0.085), light: NSColor(white: 0, alpha: 0.055))
    static let cardBackground = dynamic(dark: NSColor(white: 1, alpha: 0.035), light: NSColor(white: 0, alpha: 0.02))
    static let cardBorder = dynamic(dark: NSColor(white: 1, alpha: 0.12), light: NSColor(white: 0, alpha: 0.12))
    /// Behind a work line the pointer is over (it opens on a click).
    static let hoverFill = dynamic(dark: NSColor(white: 1, alpha: 0.05), light: NSColor(white: 0, alpha: 0.04))
    /// Behind an ask's answer rows (one reply): barely there, as the box's
    /// border does the work.
    static let answerRowsFill = dynamic(dark: NSColor(white: 1, alpha: 0.02), light: NSColor(white: 0, alpha: 0.015))
    /// A ```mermaid or ```html box's Diagram / Source switch (RichBlockCell).
    static let switchTrack = dynamic(dark: NSColor(white: 1, alpha: 0.06), light: NSColor(white: 0, alpha: 0.05))
    static let switchThumb = dynamic(dark: NSColor(white: 1, alpha: 0.16), light: NSColor(white: 1, alpha: 1))
    /// codeBackground over the transcript, as one solid colour, for a fade
    /// that has to end in it (RichPalette's bg is the same).
    static let codeBackgroundOpaque = dynamic(dark: NSColor(srgbRed: 0x28 / 255, green: 0x28 / 255, blue: 0x28 / 255, alpha: 1),
                                              light: NSColor(srgbRed: 0xf7 / 255, green: 0xf7 / 255, blue: 0xf7 / 255, alpha: 1))
    static let hairline = dynamic(dark: NSColor(white: 1, alpha: 0.1), light: NSColor(white: 0, alpha: 0.1))

    /// Text tiers that read the same in both looks. The system's tertiary
    /// label is about 1.8:1 on white (2.4:1 on the dark pane), so times,
    /// footers, folder names and line numbers were near invisible in light
    /// mode and dim in dark. These are about 3.3:1 in both, and still
    /// clearly quieter than secondary text. Disabled controls and the light
    /// placeholder keep the system colour.
    /// An asks card's buttons (AskButtonStyle): a raised grey, like a
    /// bordered push button on either appearance.
    static let buttonFill = dynamic(dark: NSColor(white: 1, alpha: 0.12), light: NSColor(white: 1, alpha: 1))
    static let buttonEdge = dynamic(dark: NSColor(white: 1, alpha: 0.08), light: NSColor(white: 0, alpha: 0.18))
    static let faintText = dynamic(dark: NSColor(white: 1, alpha: 0.36), light: NSColor(white: 0, alpha: 0.45))
    /// Work line icons and chevrons.
    static let faintIcon = dynamic(dark: .tertiaryLabelColor, light: NSColor(white: 0, alpha: 0.36))
    /// Work lines and tool output: secondary, a step darker in light mode,
    /// where thin grey glyphs on white read lighter than their colour.
    static let quietText = dynamic(dark: .secondaryLabelColor, light: NSColor(white: 0, alpha: 0.6))

    /// The user's bubble: a touch of the accent colour over a faint fill.
    static let bubbleBackground = NSColor(name: nil) { appearance in
        let dark = appearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua
        let accent = NSColor.controlAccentColor.usingColorSpace(.sRGB) ?? .systemBlue
        let (base, baseAlpha, accentAlpha): (CGFloat, CGFloat, CGFloat) = dark ? (1, 0.06, 0.09) : (0, 0.035, 0.09)
        // `accent` at `accentAlpha` composited over `base` grey at `baseAlpha`.
        let alpha = accentAlpha + baseAlpha * (1 - accentAlpha)
        func mix(_ channel: CGFloat) -> CGFloat { (channel * accentAlpha + base * baseAlpha * (1 - accentAlpha)) / alpha }
        return NSColor(srgbRed: mix(accent.redComponent), green: mix(accent.greenComponent), blue: mix(accent.blueComponent), alpha: alpha)
    }

    /// A thread chip (a thread id in a reply that names a real thread):
    /// accent text on a faint accent pill, since it opens on a click.
    static let chipBackground = NSColor(name: nil) { appearance in
        let dark = appearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua
        return NSColor.controlAccentColor.withAlphaComponent(dark ? 0.2 : 0.12)
    }
    static let chipText = NSColor.controlAccentColor

    /// A reply button's pill (docs/protocol.md, "Reply buttons"), as in the
    /// mockup Mike picked (reply-buttons c.html): blue to start a thread,
    /// purple to message one, green once pressed, grey on its way, red
    /// when the last press failed. Fill, text and edge.
    static func replyButton(_ look: ReplyButtons.Look) -> (fill: NSColor, text: NSColor, edge: NSColor) {
        switch look {
        case .start: return replyStart
        case .send: return replySend
        case .pressed: return replyPressed
        case .pressing: return replyPressing
        case .failed: return replyFailed
        }
    }

    private static func hex(_ value: UInt32) -> NSColor {
        NSColor(srgbRed: CGFloat((value >> 16) & 0xFF) / 255, green: CGFloat((value >> 8) & 0xFF) / 255, blue: CGFloat(value & 0xFF) / 255, alpha: 1)
    }

    private static func replyColors(dark: (UInt32, UInt32, UInt32), light: (UInt32, UInt32, UInt32)) -> (fill: NSColor, text: NSColor, edge: NSColor) {
        (dynamic(dark: hex(dark.0), light: hex(light.0)), dynamic(dark: hex(dark.1), light: hex(light.1)), dynamic(dark: hex(dark.2), light: hex(light.2)))
    }

    private static let replyStart = replyColors(dark: (0x2F3B52, 0x9CC2FF, 0x3D5070), light: (0xE6EFFF, 0x1F5FBF, 0xBCD3F5))
    private static let replySend = replyColors(dark: (0x33304A, 0xC3B5FF, 0x4A4470), light: (0xEFEAFF, 0x5B3FC4, 0xD3C8F5))
    private static let replyPressed = replyColors(dark: (0x24332A, 0x8FD19E, 0x35503D), light: (0xE5F4E8, 0x2B7A3D, 0xBFE0C6))
    private static let replyPressing = replyColors(dark: (0x2A2A2C, 0x8E8B86, 0x3A3A3C), light: (0xEEEEF0, 0x8E8E93, 0xD8D8DC))
    private static let replyFailed = replyColors(dark: (0x3B2626, 0xFF9A8F, 0x5A3535), light: (0xFDECEB, 0xB3261E, 0xF2C4C0))

    /// Diff line tints: about 11%, so a diff isn't the loudest thing on screen.
    static let addedBackground = dynamic(dark: NSColor(srgbRed: 0.25, green: 0.78, blue: 0.4, alpha: 0.12),
                                         light: NSColor(srgbRed: 0.1, green: 0.62, blue: 0.25, alpha: 0.1))
    static let removedBackground = dynamic(dark: NSColor(srgbRed: 0.95, green: 0.3, blue: 0.3, alpha: 0.12),
                                           light: NSColor(srgbRed: 0.85, green: 0.2, blue: 0.2, alpha: 0.09))
    static let addedText = dynamic(dark: NSColor(srgbRed: 0.42, green: 0.84, blue: 0.5, alpha: 1),
                                   light: NSColor(srgbRed: 0.1, green: 0.55, blue: 0.22, alpha: 1))
    static let removedText = dynamic(dark: NSColor(srgbRed: 1, green: 0.45, blue: 0.45, alpha: 1),
                                     light: NSColor(srgbRed: 0.8, green: 0.15, blue: 0.15, alpha: 1))
    /// "Needs you" and "Failed" in the sidebar. System orange and red on
    /// the light sidebar measured about 2:1; these darker light-mode shades
    /// are about 4.5:1 and the same hue.
    static let needsYou = dynamic(dark: .systemOrange, light: NSColor(srgbRed: 0.70, green: 0.33, blue: 0, alpha: 1))
    static let failed = dynamic(dark: .systemRed, light: NSColor(srgbRed: 0.78, green: 0.13, blue: 0.13, alpha: 1))
    static let errorBackground = dynamic(dark: NSColor(srgbRed: 0.7, green: 0.2, blue: 0.2, alpha: 0.18),
                                         light: NSColor(srgbRed: 1, green: 0.94, blue: 0.94, alpha: 1))

    static func paragraph(lineHeight: CGFloat = 1, spacing: CGFloat = 8, before: CGFloat = 0, head: CGFloat = 0, first: CGFloat? = nil, tail: CGFloat = 0) -> NSMutableParagraphStyle {
        let style = NSMutableParagraphStyle()
        style.lineHeightMultiple = lineHeight
        style.paragraphSpacing = spacing
        style.paragraphSpacingBefore = before
        style.headIndent = head
        style.firstLineHeadIndent = first ?? head
        style.tailIndent = tail
        style.lineBreakMode = .byWordWrapping
        return style
    }

    /// A paragraph style with every line `height` tall, and the baseline
    /// offset that centres `font`'s glyphs in it. TextKit puts the extra
    /// height of a line height multiple above the glyphs, which made a
    /// one-line bubble's text sit low; a fixed height with an offset splits
    /// it above and below, like CSS line-height.
    static func lines(_ height: CGFloat, font: NSFont, spacing: CGFloat = 0, before: CGFloat = 0, head: CGFloat = 0, first: CGFloat? = nil, tail: CGFloat = 0) -> (style: NSMutableParagraphStyle, offset: CGFloat) {
        let style = paragraph(spacing: spacing, before: before, head: head, first: first, tail: tail)
        style.minimumLineHeight = height
        style.maximumLineHeight = height
        return (style, baselineOffset(height, font: font))
    }

    static func baselineOffset(_ height: CGFloat, font: NSFont) -> CGFloat {
        let natural = ceil(font.ascender - font.descender + font.leading)
        return max(0, (height - natural) / 2).rounded(.down)
    }

    /// Body text attributes for plain (not markdown) text.
    static func text(_ font: NSFont = bodyFont, color: NSColor = .labelColor, line: CGFloat = bodyLine, spacing: CGFloat = 0, alignment: NSTextAlignment = .natural) -> [NSAttributedString.Key: Any] {
        let (style, offset) = lines(line, font: font, spacing: spacing)
        style.alignment = alignment
        return [.font: font, .foregroundColor: color, .paragraphStyle: style, .baselineOffset: offset]
    }

    static var bodyAttributes: [NSAttributedString.Key: Any] { text() }
}

extension NSAttributedString.Key {
    /// Fill a rounded box behind the whole run (code blocks, cards).
    static let tbBlockBackground = NSAttributedString.Key("tbBlockBackground")
    /// Fill each line fragment edge to edge (diff lines).
    static let tbLineBackground = NSAttributedString.Key("tbLineBackground")
    /// A small rounded fill behind just the run's glyphs (inline code).
    static let tbInlineBackground = NSAttributedString.Key("tbInlineBackground")
    /// Clicking the run does something in its row ("Show 30 more lines"):
    /// the value is passed to the text view's `onAction`.
    static let tbAction = NSAttributedString.Key("tbAction")
    /// A button drawn behind the run (an ask's links and answers): the
    /// value is an `AskButtonStyle` raw value.
    static let tbButton = NSAttributedString.Key("tbButton")
    /// A word shaped like a thread id (`ThreadRefs`). The value is the word;
    /// it's drawn as a chip only if it names a thread (`ThreadChips`).
    static let tbThreadRef = NSAttributedString.Key("tbThreadRef")
    /// Where an asks card's link button goes, for its hover card: a
    /// `LinkPeek`. Text links are peeked from their `.link`.
    static let tbPeek = NSAttributedString.Key("tbPeek")
    /// A picture's chip in Mike's bubble (RowRenderer.pictureChips): the
    /// value is the picture's index in the message, an NSNumber, so a click
    /// opens the same picture as the tile over the words.
    static let tbPictureChip = NSAttributedString.Key("tbPictureChip")
    /// A Notion card's chip in Mike's bubble (RowRenderer.cardChips): the
    /// value is the card's title, the words its one U+FFFC stands for.
    static let tbCardChip = NSAttributedString.Key("tbCardChip")
    /// What a copy puts in place of this run's one U+FFFC: a ```mermaid or
    /// ```html box's fenced source (RichBlockCell).
    static let tbCopyText = NSAttributedString.Key("tbCopyText")
    /// The room an open card leaves under an ask for its Something else
    /// box (an NSNumber, the ask's index): one line as tall as the box, with
    /// the box itself a text view the cell puts over it (AskAnswerBox).
    static let tbAnswerBox = NSAttributedString.Key("tbAnswerBox")
    /// A whole paragraph that's one click target (the done card's
    /// follow-ups): the value is its `tbAction`. The text view lights the
    /// paragraph up under the pointer and shows "Send ↑" at its right
    /// (BackgroundLayoutManager.hoveredRow), and a click anywhere on its
    /// lines counts, not just on the words.
    static let tbRow = NSAttributedString.Key("tbRow")
    /// A hairline across the top of this paragraph, inside its
    /// `.tbBlockBackground` box: the line between an ask's answer rows.
    static let tbRowRule = NSAttributedString.Key("tbRowRule")
    /// A reply button's pill (`[title](button:<id>)` in a reply): the value
    /// is the button's id. BackgroundLayoutManager draws the pill in the
    /// colours of its `ReplyButtons.Look` (`.tbReplyLook`), and a click
    /// presses it (AppModel.pressReplyButton).
    static let tbReplyButton = NSAttributedString.Key("tbReplyButton")
    /// A `ReplyButtons.Look` raw value, beside `.tbReplyButton`.
    static let tbReplyLook = NSAttributedString.Key("tbReplyLook")
}

/// How a button on an asks card is drawn (`.tbButton`).
enum AskButtonStyle: String {
    /// The first link: the thing to go and do.
    case primary
    /// The answer he picked.
    case picked
    /// The agent's own pick, before he's picked anything.
    case suggested
    case plain

    // Filled like a macOS bordered button, so they read as buttons
    // rather than outlined labels (Mike, 28 Oct): the link to go and do
    // the thing and the picked answer in the accent, the rest a raised
    // grey, the agent's pick with an accent edge.
    var textColor: NSColor {
        switch self {
        case .primary, .picked: return .white
        case .plain, .suggested: return .labelColor
        }
    }

    var fill: NSColor {
        switch self {
        case .primary, .picked: return .controlAccentColor
        case .suggested, .plain: return Theme.buttonFill
        }
    }

    var stroke: NSColor {
        switch self {
        case .primary, .picked: return .clear
        case .suggested: return NSColor.controlAccentColor.withAlphaComponent(0.8)
        case .plain: return Theme.buttonEdge
        }
    }
}
