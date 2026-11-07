import SwiftUI
import ThreadbearKit
import UIKit
import UniformTypeIdentifiers

/// A ```slack, ```email or ```draft block in a reply: text the agent wrote
/// for Mike to send somewhere else. A box like a code block's, its label on
/// the left and Copy on the right, then the draft in the body font with
/// every line where the agent put it (the reply's own Markdown would join
/// them up). A Slack draft draws Slack's formatting; the Mac draws the same
/// box.
struct DraftBlockView: View {
    let draft: DraftBlock

    @State private var copied = false
    /// Which tap the "Copied" belongs to, so an older tap's timer doesn't
    /// put "Copy" back early.
    @State private var copies = 0

    var body: some View {
        VStack(spacing: 0) {
            header
            Divider().opacity(0.6)
            VStack(alignment: .leading, spacing: 0) {
                ForEach(Array(draft.lines.enumerated()), id: \.offset) { _, line in
                    lineView(line)
                }
            }
            .textSelection(.enabled)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(10)
        }
        .frame(maxWidth: .infinity)
        .background(Color(.secondarySystemBackground))
        .clipShape(RoundedRectangle(cornerRadius: 8))
        .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(Color.primary.opacity(0.12), lineWidth: 1))
    }

    private var header: some View {
        HStack(spacing: 10) {
            Text(draft.label).font(.caption).foregroundStyle(.secondary)
            Spacer(minLength: 0)
            Button(action: copy) {
                Label(copied ? "Copied" : "Copy", systemImage: copied ? "checkmark.circle.fill" : "doc.on.doc")
                    .font(.caption.weight(copied ? .semibold : .regular))
                    .contentTransition(.symbolEffect(.replace))
            }
            .buttonStyle(.borderless)
            // Green with a tick for a moment after a tap, as on the Mac.
            .foregroundStyle(copied ? AnyShapeStyle(Color.green) : AnyShapeStyle(.secondary))
            .sensoryFeedback(.success, trigger: copies)
            .accessibilityLabel(copied ? "Copied" : "Copy the \(draft.label.lowercased())")
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 6)
    }

    @ViewBuilder private func lineView(_ line: DraftBlock.Line) -> some View {
        // A blank line keeps its height, so the gaps between paragraphs stay.
        let text = Text(line.spans.allSatisfy { $0.text.isEmpty } ? AttributedString(" ") : Self.attributed(line, kind: draft.kind))
        if line.quote {
            text
                .foregroundStyle(.secondary)
                .padding(.leading, 10)
                .overlay(alignment: .leading) {
                    RoundedRectangle(cornerRadius: 1.5).fill(.quaternary).frame(width: 3)
                }
        } else {
            text
        }
    }

    /// A line's spans with their looks. An email or plain draft is one span
    /// as written; its bare web addresses are linked.
    static func attributed(_ line: DraftBlock.Line, kind: DraftBlock.Kind) -> AttributedString {
        var out = AttributedString()
        for span in line.spans {
            var piece = AttributedString(span.text)
            var intent: InlinePresentationIntent = []
            if span.bold { intent.insert(.stronglyEmphasized) }
            if span.italic { intent.insert(.emphasized) }
            if span.strike { intent.insert(.strikethrough) }
            if span.code { intent.insert(.code) }
            if !intent.isEmpty { piece.inlinePresentationIntent = intent }
            if let link = span.link { piece.link = link }
            out += piece
        }
        if kind != .slack { linkBareAddresses(&out) }
        return out
    }

    private static let detector = try? NSDataDetector(types: NSTextCheckingResult.CheckingType.link.rawValue)

    /// http(s) addresses written out in the text, as the Mac links them.
    private static func linkBareAddresses(_ text: inout AttributedString) {
        let plain = String(text.characters)
        guard let detector, plain.contains("http") else { return }
        for match in detector.matches(in: plain, range: NSRange(plain.startIndex..., in: plain)) {
            guard let url = match.url, let scheme = url.scheme?.lowercased(), scheme == "http" || scheme == "https",
                  let range = Range(match.range, in: plain),
                  let lower = AttributedString.Index(range.lowerBound, within: text),
                  let upper = AttributedString.Index(range.upperBound, within: text) else { continue }
            text[lower..<upper].link = url
        }
    }

    /// Plain text and HTML in one item, so Slack and Mail keep the bold and
    /// the links, and anywhere else gets the words.
    private func copy() {
        UIPasteboard.general.setItems([[
            UTType.plainText.identifier: draft.plainText,
            UTType.html.identifier: draft.html,
        ]])
        copies += 1
        let tap = copies
        copied = true
        Task { @MainActor in
            try? await Task.sleep(for: .seconds(1.5))
            if copies == tap { copied = false }
        }
    }
}
