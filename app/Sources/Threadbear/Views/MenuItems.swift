import AppKit
import SwiftUI

extension NSMenuItem {
    /// A menu item with an SF Symbol beside its title. Every item in the
    /// app's own menus has one (MenuIconsTests), like the system's
    /// Copy and Paste.
    convenience init(title: String, symbol: String, action: Selector?, target: AnyObject? = nil) {
        self.init(title: title, action: action, keyEquivalent: "")
        setIcon(NSImage(systemSymbolName: symbol, accessibilityDescription: nil))
        self.target = target
    }

    /// The item's icon, shown. macOS 27 hides menu item images unless the
    /// item asks for them (`preferredImageVisibility`, NSMenuItem.h), so
    /// every AppKit menu in the app lost its icons on 27.2 (Mike, 5 Nov:
    /// the runner menu). Set icons through here, never `image =`
    /// (MenuIconsTests checks).
    func setIcon(_ icon: NSImage?) {
        image = icon
        // Only the macOS 27 SDK has it, and the README promises Xcode 26
        // (SDK 26.x, AppKit 2685) builds the app. An Xcode 26 build can still
        // run on macOS 27, so there it's set by name instead
        // (NSMenuItemImageVisibilityVisible is 1).
        #if canImport(AppKit, _version: 2700)
        if #available(macOS 27, *) { preferredImageVisibility = .visible }
        #else
        if #available(macOS 27, *), responds(to: NSSelectorFromString("setPreferredImageVisibility:")) {
            setValue(1, forKey: "preferredImageVisibility")
        }
        #endif
    }
}

/// A SwiftUI `Menu` that shows its items' icons. macOS hides them, in every
/// menu SwiftUI makes, unless `.labelStyle(.titleAndIcon)` is on the items:
/// on the `Menu` itself does nothing, and the item still reports an image,
/// so nothing but looking at the open menu shows it (Mike, 5 Nov; the icons
/// added on 28 Oct never showed). MenuIconsTests holds every menu to this.
struct IconMenu<Items: View, Title: View>: View {
    @ViewBuilder let content: () -> Items
    @ViewBuilder let label: () -> Title

    var body: some View {
        Menu {
            content().labelStyle(.titleAndIcon)
        } label: {
            label()
        }
    }
}

extension IconMenu where Title == Label<Text, Image> {
    /// A submenu. It needs the style as well: it doesn't reach down from the
    /// menu it's in.
    init(_ title: String, systemImage: String, @ViewBuilder content: @escaping () -> Items) {
        self.content = content
        self.label = { Label(title, systemImage: systemImage) }
    }
}

/// Menu bar items with their icons showing (see `IconMenu`).
struct IconMenuItems<Items: View>: View {
    @ViewBuilder let items: () -> Items

    var body: some View {
        items().labelStyle(.titleAndIcon)
    }
}

extension View {
    /// `.contextMenu` with its items' icons showing (see `IconMenu`).
    func iconContextMenu<Items: View>(@ViewBuilder _ items: @escaping () -> Items) -> some View {
        contextMenu { items().labelStyle(.titleAndIcon) }
    }
}

/// Keeps the AppKit view behind a chip or button so its menu can open from
/// it: a plain Button that pops an NSMenu. The Hibernate moon moved to this
/// from SwiftUI's `Menu` on 31 Oct, when its menu stopped showing; the cause
/// turned out to be the window left on the drag Space (DragSpace), which
/// hid every menu, not anything about `Menu`.
@MainActor
final class MenuAnchor {
    weak var view: NSView?
    /// Told when the menu, or the popover standing in for it, opens and
    /// closes. A sidebar row keeps its buttons showing meanwhile: the
    /// pointer leaves the row on its way into the menu, and the moon is
    /// only there while the row's hovered.
    var held: ((Bool) -> Void)?

    private var popover: NSPopover?

    /// Opens above the chip, since the composer sits at the bottom of the
    /// window, or `below` it (a sidebar row's button); AppKit moves it if
    /// there isn't room.
    func popUp(_ menu: NSMenu, below: Bool = false) {
        guard let view else { return }
        // A window a drag left on the drag Space hides every menu opened
        // from it: off it first, so this one shows.
        DragSpace.repair("menu", beforeMenu: true)
        held?(true)
        // Menus have stopped showing in this run for some other reason
        // (MenuWatch): the popover straight away.
        if MenuWatch.stuck {
            MenuPopover.show(menu, relativeTo: view.bounds, of: view, edge: below == view.isFlipped ? .maxY : .minY) { [held] in held?(false) }
            return
        }
        MenuWatch.anchor = (view, below, held)
        defer { MenuWatch.anchor = nil }
        let gap = zoomed(4)
        let top = below
            ? (view.isFlipped ? view.bounds.height + gap : -gap)
            : (view.isFlipped ? -menu.size.height - gap : view.bounds.height + menu.size.height + gap)
        menu.popUp(positioning: nil, at: NSPoint(x: 0, y: top), in: view)
        // Unless it went unseen and a popover is taking its place, which
        // lets go when it closes.
        if !MenuWatch.handingOver { held?(false) }
    }

    /// A popover above the chip that goes away on a click outside or Esc.
    /// A second click on the chip while it's open closes it.
    func show(_ make: (@escaping () -> Void) -> NSViewController) {
        guard let view else { return }
        if let popover, popover.isShown {
            popover.close()
            return
        }
        if let window = view.window, let screen = window.screen ?? NSScreen.main {
            let chip = window.convertToScreen(view.convert(view.bounds, to: nil))
            AppWindow.roomAboveAnchor = screen.visibleFrame.maxY - chip.maxY
        }
        let popover = NSPopover()
        popover.behavior = .transient
        let controller = make { [weak popover] in popover?.close() }
        popover.contentViewController = controller
        // Measure the SwiftUI content first: shown before it knew its
        // height, the popover was placed for the wrong size and, once it
        // grew, slid down over the composer with Effort off the screen.
        popover.contentSize = controller.view.fittingSize
        popover.show(relativeTo: view.bounds, of: view, preferredEdge: .maxY)
        self.popover = popover
    }
}

struct MenuAnchorView: NSViewRepresentable {
    let anchor: MenuAnchor

    func makeNSView(context: Context) -> NSView {
        let view = PassThroughView()
        anchor.view = view
        return view
    }

    func updateNSView(_ view: NSView, context: Context) {
        anchor.view = view
    }

    /// Only there to position menus; clicks go to the chip on top.
    private final class PassThroughView: NSView {
        override func hitTest(_ point: NSPoint) -> NSView? { nil }
    }
}

/// An NSMenuItem that runs a closure, for menus built in code.
final class ActionMenuItem: NSMenuItem {
    private let handler: () -> Void

    init(_ title: String, symbol: String, checked: Bool = false, handler: @escaping () -> Void) {
        self.handler = handler
        super.init(title: title, action: #selector(run), keyEquivalent: "")
        target = self
        state = checked ? .on : .off
        setIcon(NSImage(systemSymbolName: symbol, accessibilityDescription: nil))
    }

    required init(coder: NSCoder) { fatalError() }

    @objc private func run() { handler() }
}

extension NSMenuItem {
    /// A small star at the row's trailing edge: this row is the default,
    /// as the model picker's star says (ModelRow). A badge rather than a
    /// picture in the title, so the title stays the plain name that
    /// scripts and tests find the item by.
    func markDefault() {
        badge = NSMenuItemBadge(string: "★")
    }
}

