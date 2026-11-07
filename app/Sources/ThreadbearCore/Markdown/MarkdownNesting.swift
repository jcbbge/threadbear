import Foundation

/// How deep Markdown's quotes and lists could nest, at most, without
/// parsing it. swift-markdown builds its tree, and MarkdownRenderer draws
/// it, by recursing once per level, on the transcript's worker threads with
/// their small stacks, so a line of 8,000 `>`s (or `- `s) from an agent's
/// reply or a cloned repo's README could run one out of stack and stop the
/// app. The iPhone's parser had the same (Daybreak, 7 Nov 2026). A block
/// that could go past `MarkdownRenderer`'s limit is drawn as plain words.
public enum MarkdownNesting {
    /// An upper bound on the containers open at any line: a line opens at
    /// most one per marker at its start (`>`, `-`, `*`, `+`, `1.`, `1)`), and
    /// keeps open at most those it continues, one per `>` or two columns of
    /// indent. A line with no marker can be a lazy continuation, which keeps
    /// them all. Linear, and never less than the real depth.
    public static func bound(_ text: String) -> Int {
        var open = 0
        var most = 0
        var markers = 0
        var quotes = 0
        var columns = 0
        var inPrefix = true
        var digits = 0
        var afterMarker = false
        func endLine() {
            // A marker that ends its line is an empty item, which still nests
            // ("-" on each line, each indented more: cross-lab review, 7 Nov).
            if afterMarker { markers += 1 }
            if markers > 0 { open = min(open, quotes + columns / 2) + markers }
            most = max(most, open)
            markers = 0
            quotes = 0
            columns = 0
            inPrefix = true
            digits = 0
            afterMarker = false
        }
        for byte in text.utf8 {
            if byte == 0x0A || byte == 0x0D {
                endLine()
                continue
            }
            guard inPrefix else { continue }
            if afterMarker {
                // A list marker counts only with a space or tab after it.
                afterMarker = false
                if byte == 0x20 || byte == 0x09 {
                    markers += 1
                    columns += byte == 0x09 ? 4 : 1
                    continue
                }
                inPrefix = false
                continue
            }
            switch byte {
            case 0x20:
                columns += 1
            case 0x09:
                columns += 4
            case UInt8(ascii: ">"):
                if digits > 0 { inPrefix = false } else { markers += 1; quotes += 1 }
            case UInt8(ascii: "-"), UInt8(ascii: "*"), UInt8(ascii: "+"):
                if digits > 0 { inPrefix = false } else { afterMarker = true }
            case UInt8(ascii: "0")...UInt8(ascii: "9"):
                digits += 1
                if digits > 9 { inPrefix = false }
            case UInt8(ascii: "."), UInt8(ascii: ")"):
                if digits > 0 { digits = 0; afterMarker = true } else { inPrefix = false }
            default:
                inPrefix = false
            }
        }
        endLine()
        return most
    }

    /// An upper bound on the cells a block's tables could come to: its
    /// widest delimiter row (`-|-|`, maybe after quote and list marks) by its
    /// lines, as short rows are padded to the width. Nothing in a table's
    /// own rows can make it wider.
    public static func tableCells(_ text: String) -> Int {
        var widest = 0
        var lines = 1
        var pipes = 0
        var dashes = false
        var delimiter = true
        func endLine() {
            if delimiter, dashes { widest = max(widest, pipes + 1) }
            pipes = 0
            dashes = false
            delimiter = true
        }
        for byte in text.utf8 {
            switch byte {
            case 0x0A, 0x0D:
                lines += 1
                endLine()
            case UInt8(ascii: "|"):
                pipes += 1
            case UInt8(ascii: "-"):
                dashes = true
            case UInt8(ascii: ":"), 0x20, 0x09, UInt8(ascii: ">"), UInt8(ascii: "*"), UInt8(ascii: "+"), UInt8(ascii: "."), UInt8(ascii: ")"), UInt8(ascii: "0")...UInt8(ascii: "9"):
                break
            default:
                delimiter = false
            }
        }
        endLine()
        return widest * lines
    }

    /// The marks inline Markdown nests with (`*`, `_`, `~`, `[`): emphasis
    /// and strikethrough take two a level and a link or picture one (its
    /// `[`), so these bound how deep a paragraph's tree can go.
    public static func inlineMarks(_ text: String) -> Int {
        var count = 0
        for byte in text.utf8 where byte == UInt8(ascii: "*") || byte == UInt8(ascii: "_") || byte == UInt8(ascii: "~") || byte == UInt8(ascii: "[") {
            count += 1
        }
        return count
    }
}
