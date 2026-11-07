import SwiftUI
import ThreadbearKit

/// A reply button (docs/protocol.md, "Reply buttons"): blue starts a thread,
/// purple sends a message, green with a tick once pressed, which then opens
/// the thread it started or messaged. A spinner while a press is on its way,
/// and the error under it if the press failed. ThreadbearKit's ReplyButtons
/// says which.
struct ReplyButtonPill: View {
    let button: MessageButton
    @Environment(AppModel.self) private var model
    @Environment(\.buttonThreadId) private var threadId
    @Environment(\.pushThread) private var pushThread

    var body: some View {
        let look = threadId.map { model.pressLook(button, in: $0) } ?? .ready
        VStack(alignment: .leading, spacing: 4) {
            Button {
                guard let threadId else { return }
                model.tap(button, in: threadId, pushThread: pushThread)
            } label: {
                HStack(spacing: 5) {
                    switch look {
                    case .pressing: ProgressView().controlSize(.mini).tint(.white)
                    case .pressed: Image(systemName: "checkmark").font(.caption.weight(.bold))
                    default: EmptyView()
                    }
                    Text(button.title).lineLimit(2).multilineTextAlignment(.leading)
                }
                .font(.subheadline.weight(.medium))
                .padding(.horizontal, 12)
                .padding(.vertical, 6)
                .foregroundStyle(isPressed(look) ? Color.green : .white)
                .background(background(look), in: Capsule())
                .overlay {
                    if isPressed(look) { Capsule().strokeBorder(Color.green.opacity(0.45)) }
                    if case .failed = look { Capsule().strokeBorder(Color.red.opacity(0.6), lineWidth: 1.5) }
                }
                .opacity(look == .pressing ? 0.75 : 1)
            }
            .buttonStyle(.plain)
            // Nothing to open: the thread it went to isn't known.
            .disabled(look == .pressing || look == .pressed(threadId: nil) || threadId == nil)
            .accessibilityHint(hint(look))
            if case let .failed(error) = look {
                Text(error).font(.caption).foregroundStyle(.red)
            }
        }
    }

    private func isPressed(_ look: ReplyButtons.Look) -> Bool {
        if case .pressed = look { return true }
        return false
    }

    private func background(_ look: ReplyButtons.Look) -> Color {
        if isPressed(look) { return Color.green.opacity(0.14) }
        return button.kind == .start ? .blue : .purple
    }

    private func hint(_ look: ReplyButtons.Look) -> String {
        switch look {
        case .pressed: "Pressed. Opens the thread it went to."
        case .pressing: "On its way to the Mac."
        case let .failed(error): "Didn't work: \(error). Tap to try again."
        case .ready: ReplyButtons.hint(button)
        }
    }
}
