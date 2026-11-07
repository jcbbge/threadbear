import SwiftUI
import ThreadbearCore

/// A recovery offer just below the failed turn, above the message box.
struct RefusalOffer: View {
    @Environment(AppModel.self) private var app
    let thread: ThreadSummary

    var body: some View {
        let continuing = app.continuingRefusals.contains(thread.id)
        if let target = app.refusalTarget(for: thread) {
            ViewThatFits(in: .horizontal) {
                HStack(spacing: zoomed(12)) {
                    message
                    Spacer(minLength: 0)
                    button(target, continuing: continuing)
                }
                VStack(alignment: .leading, spacing: zoomed(8)) {
                    message
                    button(target, continuing: continuing)
                }
            }
            .font(.system(size: TypeScale.label))
            .padding(zoomed(12))
            .background(Color(nsColor: Theme.cardBackground), in: RoundedRectangle(cornerRadius: zoomed(12)))
            .overlay { RoundedRectangle(cornerRadius: zoomed(12)).stroke(Color(nsColor: Theme.hairline), lineWidth: 0.5) }
            .padding(.bottom, zoomed(8))
        }
    }

    private var message: some View {
        Text("Claude couldn't continue with this message.")
            .foregroundStyle(.secondary)
            .fixedSize(horizontal: false, vertical: true)
    }

    private func button(_ target: Account, continuing: Bool) -> some View {
        Button(continuing ? "Continuing…" : "Continue with Codex Sol") {
            app.continueRefusal(thread.id)
        }
        .disabled(continuing)
        .fixedSize()
        .tip("Move this thread to \(target.title) on GPT-6.1-Sol and continue the task. Your draft stays in the box.")
    }
}
