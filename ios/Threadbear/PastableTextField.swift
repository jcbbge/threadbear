import SwiftUI
import ThreadbearKit
import UIKit
import UniformTypeIdentifiers

/// A text box that also takes a pasted photo. SwiftUI's TextField only ever
/// pastes text, so this is UIKit's text view with Paste offered whenever the
/// pasteboard holds an image. Pasting from the edit menu or ⌘V is the user's
/// own act, so reading the pasteboard then doesn't bring up iOS's "Allow
/// Paste" prompt; checking `hasImages` beforehand doesn't either.
///
/// Given `photos`, each one is a chip in the words where it was put in
/// (docs/protocol.md, "Pictures in a message"): a mark in `text`
/// (InlinePictures) drawn as its PhotoChipAttachment, so deleting a chip
/// takes its photo out too.
struct PastableTextField: UIViewRepresentable {
    @Binding var text: String
    var placeholder: String
    var lines: ClosedRange<Int>
    /// Nil when photos can't be sent: Paste is then text only.
    var onPasteImages: (([NSItemProvider]) -> Void)?
    /// The photos whose chips are in the words, in order.
    var photos: Binding<[PickedPhoto]>? = nil
    /// Kept up to date with the cursor, and where it goes after the words
    /// change from outside (photos put in).
    var cursor: TextCursor? = nil
    /// A pasted thread id (Copy thread ID, here or on the Mac) as the
    /// `[title](thread:<id>)` link it should go in as, or nil to paste the
    /// words as they are.
    var threadReference: ((String) -> String?)? = nil

    func makeUIView(context: Context) -> PastingTextView {
        let view = PastingTextView()
        view.delegate = context.coordinator
        view.font = .preferredFont(forTextStyle: .body)
        view.adjustsFontForContentSizeCategory = true
        view.backgroundColor = .clear
        // Line up with a TextField's text: no inset or padding of its own.
        view.textContainerInset = .zero
        view.textContainer.lineFragmentPadding = 0
        view.isScrollEnabled = false
        view.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        view.placeholderLabel.text = placeholder
        return view
    }

    func updateUIView(_ view: PastingTextView, context: Context) {
        context.coordinator.parent = self
        let photos = self.photos?.wrappedValue ?? []
        let words = InlinePictures.normalized(text, count: photos.count)
        let shown = view.contents
        if shown.text != words || shown.photoIds != photos.map(\.id) || view.chipsOutOfOrder {
            context.coordinator.updating = true
            view.show(words, photos: photos)
            if let range = cursor?.range, range.location != NSNotFound {
                let length = ((view.text ?? "") as NSString).length
                view.selectedRange = NSRange(location: min(range.location, length), length: 0)
            }
            context.coordinator.updating = false
        }
        view.placeholderLabel.text = placeholder
        view.placeholderLabel.isHidden = !text.isEmpty
        view.onPasteImages = onPasteImages
        view.threadReference = threadReference
        // .disabled() while a send is on its way: the box empties when it
        // lands, so words typed meanwhile would be lost. Edits are turned
        // away rather than isEditable going off, which would drop the
        // keyboard he's about to type the next message on.
        let locked = !context.environment.isEnabled
        view.locked = locked
        view.alpha = locked ? 0.5 : 1
    }

    func sizeThatFits(_ proposal: ProposedViewSize, uiView view: PastingTextView, context: Context) -> CGSize? {
        guard let width = proposal.width, width > 0, let font = view.font else { return nil }
        let fit = view.sizeThatFits(CGSize(width: width, height: .greatestFiniteMagnitude)).height
        let lowest = font.lineHeight * CGFloat(lines.lowerBound)
        let highest = font.lineHeight * CGFloat(lines.upperBound)
        // Grows with the text up to its last line, then scrolls, like
        // TextField(axis: .vertical) with a lineLimit.
        let scrolls = fit > highest + 1
        // The HStack around it also asks at an infinite width, to learn how
        // far it can stretch, and any text fits on one line there. Only the
        // real width may decide: taking that answer too turned scrolling off
        // (back to the top) and on (back to the cursor) on alternate keys.
        if width.isFinite, view.isScrollEnabled != scrolls { DispatchQueue.main.async { view.isScrollEnabled = scrolls } }
        return CGSize(width: width, height: ceil(min(max(fit, lowest), highest)))
    }

    func makeCoordinator() -> Coordinator { Coordinator(self) }

    final class Coordinator: NSObject, UITextViewDelegate {
        var parent: PastableTextField
        /// Set while the view shows new words from outside, whose changes
        /// aren't his typing.
        var updating = false
        init(_ parent: PastableTextField) { self.parent = parent }

        func textViewDidChange(_ view: UITextView) {
            guard !updating, let view = view as? PastingTextView else { return }
            let contents = view.contents
            parent.text = contents.text
            // A chip deleted or moved in the words takes its photo along. One
            // that's only just arrived has no chip here yet, as the view
            // hasn't been updated, so a key pressed right then mustn't count
            // as deleting it. It stays, and normalized() gives it a mark.
            if let photos = parent.photos, contents.photoIds != photos.wrappedValue.map(\.id) {
                let byId = Dictionary(photos.wrappedValue.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })
                let drawn = Set(view.chipPhotos.map(\.id))
                let arriving = photos.wrappedValue.filter { !drawn.contains($0.id) && !contents.photoIds.contains($0.id) }
                photos.wrappedValue = contents.photoIds.compactMap { byId[$0] } + arriving
            }
            view.placeholderLabel.isHidden = !view.text.isEmpty
        }

        func textView(_ view: UITextView, shouldChangeTextIn range: NSRange, replacementText text: String) -> Bool {
            !((view as? PastingTextView)?.locked ?? false)
        }

        func textViewDidChangeSelection(_ view: UITextView) {
            guard !updating else { return }
            parent.cursor?.range = view.selectedRange
        }
    }
}

final class PastingTextView: UITextView {
    var onPasteImages: (([NSItemProvider]) -> Void)?
    var threadReference: ((String) -> String?)?
    /// While a send is on its way: no typing, pasting or cutting.
    var locked = false
    let placeholderLabel = UILabel()
    /// The photos the chips stand for, to draw them again in the other
    /// appearance.
    private(set) var chipPhotos: [PickedPhoto] = []

    override init(frame: CGRect, textContainer: NSTextContainer?) {
        super.init(frame: frame, textContainer: textContainer)
        placeholderLabel.textColor = .placeholderText
        placeholderLabel.font = .preferredFont(forTextStyle: .body)
        placeholderLabel.adjustsFontForContentSizeCategory = true
        placeholderLabel.numberOfLines = 0
        placeholderLabel.translatesAutoresizingMaskIntoConstraints = false
        addSubview(placeholderLabel)
        NSLayoutConstraint.activate([
            placeholderLabel.leadingAnchor.constraint(equalTo: frameLayoutGuide.leadingAnchor),
            placeholderLabel.trailingAnchor.constraint(lessThanOrEqualTo: frameLayoutGuide.trailingAnchor),
            placeholderLabel.topAnchor.constraint(equalTo: frameLayoutGuide.topAnchor),
        ])
        isAccessibilityElement = true
        // A chip is a picture drawn for light or dark and one text size,
        // and the words carry their font: lay them out again.
        registerForTraitChanges([UITraitUserInterfaceStyle.self, UITraitPreferredContentSizeCategory.self]) { (view: PastingTextView, _) in
            let selection = view.selectedRange
            view.show(view.contents.text, photos: view.chipPhotos)
            view.selectedRange = selection
        }
    }

    required init?(coder: NSCoder) { fatalError("not from a storyboard") }

    override var accessibilityLabel: String? {
        get { placeholderLabel.text }
        set {}
    }

    private var baseAttributes: [NSAttributedString.Key: Any] {
        [.font: UIFont.preferredFont(forTextStyle: .body), .foregroundColor: UIColor.label]
    }

    /// The words on show, each mark a chip for its photo.
    func show(_ words: String, photos: [PickedPhoto]) {
        let base = baseAttributes
        let font = UIFont.preferredFont(forTextStyle: .body)
        let out = NSMutableAttributedString()
        var run = ""
        var next = 0
        for scalar in words.unicodeScalars {
            guard scalar == InlinePictures.mark else {
                run.unicodeScalars.append(scalar)
                continue
            }
            guard next < photos.count else { continue }
            out.append(NSAttributedString(string: run, attributes: base))
            run = ""
            var chip = base
            chip[.attachment] = PhotoChipAttachment(photo: photos[next], number: next + 1, font: font, traits: traitCollection)
            out.append(NSAttributedString(string: InlinePictures.markString, attributes: chip))
            next += 1
        }
        out.append(NSAttributedString(string: run, attributes: base))
        attributedText = out
        typingAttributes = base
        chipPhotos = photos
    }

    /// What's in it: the words with a mark for each chip, and the chips'
    /// photos in order. U+FFFC typed or pasted as text is no photo.
    var contents: (text: String, photoIds: [UUID]) {
        let attributed = attributedText ?? NSAttributedString()
        let ns = attributed.string as NSString
        var text = ""
        var ids: [UUID] = []
        var last = 0
        attributed.enumerateAttribute(.attachment, in: NSRange(location: 0, length: attributed.length)) { value, range, _ in
            guard let chip = value as? PhotoChipAttachment else { return }
            text += InlinePictures.words(ns.substring(with: NSRange(location: last, length: range.location - last)))
            text += InlinePictures.markString
            ids.append(chip.photoId)
            last = NSMaxRange(range)
        }
        text += InlinePictures.words(ns.substring(from: last))
        return (text, ids)
    }

    /// A chip whose number isn't its place any more (one before it went).
    var chipsOutOfOrder: Bool {
        var place = 0
        var stale = false
        attributedText?.enumerateAttribute(.attachment, in: NSRange(location: 0, length: attributedText.length)) { value, _, stop in
            guard let chip = value as? PhotoChipAttachment else { return }
            place += 1
            if chip.number != place {
                stale = true
                stop.pointee = true
            }
        }
        return stale
    }

    private var pastesImages: Bool { onPasteImages != nil && UIPasteboard.general.hasImages }

    override func canPerformAction(_ action: Selector, withSender sender: Any?) -> Bool {
        if locked, [#selector(paste(_:)), #selector(cut(_:)), #selector(delete(_:))].contains(action) { return false }
        // A plain text view turns Paste off for an image, as it can't hold one.
        if action == #selector(paste(_:)), pastesImages { return true }
        return super.canPerformAction(action, withSender: sender)
    }

    override func paste(_ sender: Any?) {
        // A photo pasted goes round the delegate, so this one's checked here.
        if locked { return }
        // A thread's id goes in as a link to it, which the agent can read the
        // thread from and the bubble draws as a chip, as the Mac does.
        // insertText goes through the delegate like typing does.
        if !pastesImages, let words = UIPasteboard.general.string, let reference = threadReference?(words) {
            return insertText(reference)
        }
        guard pastesImages, let onPasteImages else { return super.paste(sender) }
        // The items, not `images`: those are every picture on it decoded
        // here, before any limit. An item is read when its turn comes, off
        // the main thread, and only as many as the message has room for.
        let items = UIPasteboard.general.itemProviders.filter { $0.hasItemConformingToTypeIdentifier(UTType.image.identifier) }
        if items.isEmpty { return super.paste(sender) }
        onPasteImages(items)
    }

    // Copied chips go as the markers the agent would get, as plain text:
    // as pictures, a paste would bring the chip itself back as a photo.

    override func copy(_ sender: Any?) {
        guard let words = selectionWithMarkers else { return super.copy(sender) }
        UIPasteboard.general.string = words
    }

    override func cut(_ sender: Any?) {
        guard let words = selectionWithMarkers, let range = selectedTextRange else { return super.cut(sender) }
        UIPasteboard.general.string = words
        replace(range, withText: "")
        delegate?.textViewDidChange?(self)
    }

    /// The selected words with each chip as `[Picture N]`; nil with no chip in it.
    private var selectionWithMarkers: String? {
        let range = selectedRange
        guard range.length > 0, let attributed = attributedText, NSMaxRange(range) <= attributed.length else { return nil }
        let piece = attributed.attributedSubstring(from: range)
        let ns = piece.string as NSString
        var out = ""
        var last = 0
        var any = false
        piece.enumerateAttribute(.attachment, in: NSRange(location: 0, length: piece.length)) { value, run, _ in
            guard let chip = value as? PhotoChipAttachment else { return }
            any = true
            out += InlinePictures.words(ns.substring(with: NSRange(location: last, length: run.location - last)))
            out += InlinePictures.marker(chip.number)
            last = NSMaxRange(run)
        }
        out += InlinePictures.words(ns.substring(from: last))
        return any ? out : nil
    }
}
