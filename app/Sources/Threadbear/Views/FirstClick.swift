import AppKit
import WebKit

// Clicks count even while Threadbear isn't the app in front (Mike, 4 Nov).
//
// macOS swallows the click that brings a window forward unless the view
// under the pointer says otherwise: AppKit asks that one view's
// `acceptsFirstMouse(for:)`. Buttons, labels and tables say yes by
// themselves; plain views, image views, text views and web views say no.
// So each of those a click can land on answers true (search for
// "FirstClick.swift"), and SwiftUI gets `.allowsWindowActivationEvents()`
// at the root of each hosting view: RootView in ThreadbearApp, the composer
// card's collapse button and the review window. FirstClickTests walks the
// transcript's rows for any view that says no.

/// The transcript's icons (Symbols.makeView): a press on a row's chevron
/// lands on the icon, not the row.
final class FirstClickImageView: NSImageView {
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }

    /// An image view signs up for dragged pictures even when it can't be
    /// edited, and then turns them away, so a file let go over a row's icon
    /// went nowhere. Without, the drag reaches the transcript, which hands
    /// it to the composer (ComposerDropView).
    override func registerForDraggedTypes(_ newTypes: [NSPasteboard.PasteboardType]) {}
}

/// The panels' web view, so a dashboard's buttons work on the first click.
class FirstClickWebView: WKWebView {
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
}

/// A local page running its own scripts (Run them, LocalPagePreview). Its
/// scripts can read the assets the page names, and the network guards keep
/// those off the internet; this keeps them off the pasteboard and out of
/// other apps too. A page could otherwise put the bytes in a link and ask
/// for a right-click Copy Link, a Copy Image, a drag out or a Services item,
/// none of which fire anything a script in the page could be stopped at
/// (Codex review, 6 Nov 2026). What's on screen can still be seen and
/// screenshotted: that was always so.
final class SealedPreviewWebView: FirstClickWebView {
    /// No context menu: Copy Link, Copy Image, Share and Services live there.
    override func willOpenMenu(_ menu: NSMenu, with event: NSEvent) {
        menu.removeAllItems()
        super.willOpenMenu(menu, with: event)
    }

    override func menu(for event: NSEvent) -> NSMenu? { nil }

    @objc func copy(_ sender: Any?) {}
    @objc func cut(_ sender: Any?) {}

    override func validateUserInterfaceItem(_ item: NSValidatedUserInterfaceItem) -> Bool {
        if [#selector(copy(_:)), #selector(cut(_:))].contains(item.action) { return false }
        return super.validateUserInterfaceItem(item)
    }

    /// The Services menu (and the app's own) read the selection through here.
    override func validRequestor(forSendType sendType: NSPasteboard.PasteboardType?, returnType: NSPasteboard.PasteboardType?) -> Any? {
        nil
    }

    // WKWebView implements these two in Objective-C without declaring them
    // to Swift, so they're replaced by selector.
    @objc(writeSelectionToPasteboard:types:)
    func writeSelection(to pboard: NSPasteboard, types: [NSPasteboard.PasteboardType]) -> Bool { false }

    /// A drag that starts in the page (a link, a picture, a selection, or
    /// one a script fills in) can't be dropped anywhere.
    @objc(draggingSession:sourceOperationMaskForDraggingContext:)
    func draggingSession(_ session: NSDraggingSession, sourceOperationMaskFor context: NSDraggingContext) -> NSDragOperation {
        []
    }
}
