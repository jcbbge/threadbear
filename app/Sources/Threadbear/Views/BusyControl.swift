import SwiftUI

extension View {
    /// While `busy`: a spinner where the control was, and no clicks, so it
    /// never looks idle while its work is on the way (AppModel+Busy.swift).
    /// The control keeps its room, so nothing beside it moves.
    func busy(_ busy: Bool) -> some View {
        modifier(BusyControl(busy: busy))
    }
}

private struct BusyControl: ViewModifier {
    let busy: Bool

    func body(content: Content) -> some View {
        content
            .disabled(busy)
            .opacity(busy ? 0 : 1)
            .overlay {
                if busy {
                    SpinnerMark(color: .secondaryLabelColor)
                        .frame(width: zoomed(12), height: zoomed(12))
                }
            }
    }
}
