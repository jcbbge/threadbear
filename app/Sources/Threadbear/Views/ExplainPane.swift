import AppKit
import SwiftUI
import ThreadbearCore

/// Explain in the pane (ExplainModel.swift): the words Mike selected, what
/// the small model said about them, his follow-ups, and a box to ask
/// another. None of it goes into the thread.
struct ExplainPane: View {
    @Environment(AppModel.self) private var app
    let thread: ThreadSummary
    @State private var question = ""
    @FocusState private var asking: Bool

    var body: some View {
        if let session = app.explainers[thread.id] {
            VStack(spacing: 0) {
                ScrollViewReader { scroller in
                    ScrollView {
                        VStack(alignment: .leading, spacing: zoomed(14)) {
                            SelectionQuote(text: session.selection)
                            ForEach(Array(session.turns.enumerated()), id: \.offset) { index, turn in
                                TurnView(turn: turn, threadId: thread.id) { app.retryExplainer(turn: index, in: thread.id) }
                                    .id(index)
                            }
                        }
                        .padding(zoomed(14))
                        .frame(maxWidth: .infinity, alignment: .leading)
                    }
                    .onChange(of: session.turns.count) { _, count in
                        withAnimation { scroller.scrollTo(count - 1, anchor: .top) }
                    }
                }
                Divider()
                followUp(session)
            }
        } else {
            PaneNote(text: "Select some words in the thread and pick Explain.")
        }
    }

    private func followUp(_ session: ExplainSession) -> some View {
        HStack(spacing: zoomed(6)) {
            TextField("Ask a follow-up", text: $question, axis: .vertical)
                .textFieldStyle(.plain)
                .font(.system(size: TypeScale.label))
                .lineLimit(1...5)
                .focused($asking)
                .onSubmit(send)
                .tip("Ask more about this. It stays out of the thread.")
            Button(action: send) {
                Image(systemName: "arrow.up.circle.fill")
                    .font(.system(size: zoomed(18)))
            }
            .buttonStyle(.plain)
            .foregroundStyle(canSend(session) ? Color.accentColor : Color.secondary)
            .disabled(!canSend(session))
            .tip("Ask")
        }
        .padding(.horizontal, zoomed(12))
        .padding(.vertical, zoomed(10))
    }

    private func canSend(_ session: ExplainSession) -> Bool {
        !session.isBusy && !question.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    private func send() {
        guard let session = app.explainers[thread.id], canSend(session) else { return }
        app.askExplainer(question, in: thread.id)
        question = ""
    }
}

/// The selected words, set off on the left like a quote.
private struct SelectionQuote: View {
    let text: String

    var body: some View {
        HStack(alignment: .top, spacing: zoomed(8)) {
            RoundedRectangle(cornerRadius: 1)
                .fill(Color.secondary.opacity(0.4))
                .frame(width: 2)
            Text(text)
                .font(.system(size: TypeScale.label))
                .foregroundStyle(.secondary)
                .lineLimit(6)
                .textSelection(.enabled)
        }
        .fixedSize(horizontal: false, vertical: true)
    }
}

private struct TurnView: View {
    let turn: ExplainTurn
    /// The thread beside it, whose file links are that thread's to fetch.
    let threadId: String
    let retry: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: zoomed(6)) {
            if let question = turn.question {
                Text(question)
                    .font(.system(size: TypeScale.label, weight: .semibold))
                    .textSelection(.enabled)
            }
            if let answer = turn.answer {
                Text(Self.markdown(answer))
                    .environment(\.openURL, OpenGate.urlAction(files: .thread(threadId)))
                    .textSelection(.enabled)
                    .fixedSize(horizontal: false, vertical: true)
            } else if let error = turn.error {
                HStack(alignment: .firstTextBaseline, spacing: zoomed(8)) {
                    Text(error)
                        .font(.system(size: TypeScale.label))
                        .foregroundStyle(.secondary)
                    Button("Try again", action: retry)
                        .buttonStyle(.link)
                        .font(.system(size: TypeScale.label))
                        .tip("Ask the model again")
                }
            } else {
                HStack(spacing: zoomed(6)) {
                    SpinnerMark()
                        .frame(width: zoomed(12), height: zoomed(12))
                    Text("Thinking")
                        .font(.system(size: TypeScale.label))
                        .foregroundStyle(.secondary)
                }
            }
        }
    }

    /// The transcript's own Markdown styling, so an answer reads like a
    /// reply in the thread.
    static func markdown(_ text: String) -> AttributedString {
        let rendered = MarkdownRenderer.render(text).string
        return (try? AttributedString(rendered, including: \.appKit)) ?? AttributedString(text)
    }
}
