import AppKit
import ThreadbearCore

/// Dragging a thread's row out of the sidebar (Mike asked 6 Nov): let go
/// over another thread and it goes into that thread's message as the
/// thread's chip, as pasting its id does (`ComposerTextView`). Anywhere
/// else, another app, it's the id as text.
///
/// AppKit's drag rather than SwiftUI's `onDrag`: the row's own drag
/// gesture (select on mouse down, drag left to archive) takes the mouse
/// first, so the row starts this from that gesture once the drag goes a
/// way that isn't the swipe (`RowSwipe.dragsOut`).
@MainActor
enum ThreadDrag {
    /// Starts dragging `thread` from the mouse event under way. `ended`
    /// runs when it's let go, wherever that is. False when there's no drag
    /// event to start one from.
    @discardableResult
    static func begin(_ thread: ThreadSummary, ended: @escaping () -> Void) -> Bool {
        guard let event = NSApp.currentEvent, event.type == .leftMouseDragged,
              let view = event.window?.contentView else { return false }
        let item = NSPasteboardItem()
        item.setString(thread.id, forType: .string)
        let dragging = NSDraggingItem(pasteboardWriter: item)
        // What it'll be in the message: the thread's chip, held by its
        // left end, a little way in.
        let title = thread.title.isEmpty ? "Untitled" : thread.title
        let image = CardChip.attachment(title: title, kind: .thread, font: ComposerTextField.font).image ?? NSImage()
        let point = view.convert(event.locationInWindow, from: nil)
        dragging.setDraggingFrame(NSRect(x: point.x - zoomed(14), y: point.y - image.size.height / 2,
                                         width: image.size.width, height: image.size.height), contents: image)
        let source = Source(ended: ended)
        // The session doesn't keep its source, so this does till it ends.
        Source.current = source
        view.beginDraggingSession(with: [dragging], event: event, source: source)
        return true
    }

    final class Source: NSObject, NSDraggingSource {
        nonisolated(unsafe) static var current: Source?
        private let ended: () -> Void

        init(ended: @escaping () -> Void) {
            self.ended = ended
        }

        func draggingSession(_ session: NSDraggingSession, sourceOperationMaskFor context: NSDraggingContext) -> NSDragOperation {
            .copy
        }

        func draggingSession(_ session: NSDraggingSession, endedAt screenPoint: NSPoint, operation: NSDragOperation) {
            ended()
            if Source.current === self { Source.current = nil }
        }
    }
}
