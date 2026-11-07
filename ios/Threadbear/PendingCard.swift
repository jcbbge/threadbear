import SwiftUI
import ThreadbearKit

/// What a thread's stuck on: a permission to give, questions to answer, or
/// a secret to type (SecretCard).
struct PendingCard: View {
    @Environment(AppModel.self) private var model
    let threadId: String
    let runnerId: String
    let pending: PendingApproval
    var onSent: (String) -> Void
    @State private var chosen: [Int: Set<String>] = [:]
    @State private var typed = ""

    private enum Tapped: Equatable {
        case option(ApprovalOption)
        case sendAnswer
    }

    /// The button that's been tapped, spinning until the card goes
    /// (AppModel.answerCard), there still if he leaves and comes back.
    private var tapped: Tapped? {
        guard let choice = model.cardAnswers[pending.id]?.choice else { return nil }
        return ApprovalOption(rawValue: choice).map(Tapped.option) ?? .sendAnswer
    }

    var body: some View {
        switch pending {
        case let .secret(id, label, reason, placeholder, key):
            SecretCard(threadId: threadId, runnerId: runnerId, approvalId: id, label: label, reason: reason,
                       placeholder: placeholder, key: key, onSent: onSent)
        default:
            card
        }
    }

    private var card: some View {
        VStack(alignment: .leading, spacing: 12) {
            switch pending {
            case let .approval(id, name, title, options, inputSummary):
                Label(title, systemImage: "hand.raised")
                    .font(.headline)
                if let inputSummary, !inputSummary.isEmpty {
                    Text(inputSummary)
                        .font(.system(.footnote, design: .monospaced))
                        .lineLimit(6)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(10)
                        .background(Color(.tertiarySystemFill), in: RoundedRectangle(cornerRadius: 8))
                } else if !name.isEmpty {
                    Text(name).font(.footnote).foregroundStyle(.secondary)
                }
                HStack {
                    ForEach(options, id: \.self) { option in
                        let spins = tapped == .option(option)
                        Button { respond(id, option) } label: {
                            Text(label(option))
                                .frame(maxWidth: .infinity)
                                .spinning(spins, tint: option == .allow ? .white : nil)
                        }
                        .buttonStyle(option == .allow ? AnyButtonStyle(.borderedProminent) : AnyButtonStyle(.bordered))
                        // Accent only on the one that moves things along.
                        .tint(option == .deny ? .red : option == .allow ? .accentColor : .secondary)
                        // The tapped one keeps its colour, with the spinner in it.
                        .disabled(tapped != nil && !spins)
                        .accessibilityLabel(spins ? "\(label(option)), sending" : label(option))
                    }
                }
                .allowsHitTesting(tapped == nil)
            case let .question(id, questions):
                ForEach(Array(questions.enumerated()), id: \.offset) { index, question in
                    VStack(alignment: .leading, spacing: 8) {
                        Text(question.question).font(.headline)
                        ForEach(question.options, id: \.label) { option in
                            optionRow(index: index, question: question, option: option)
                        }
                    }
                }
                TextField("Something else", text: $typed, axis: .vertical)
                    .textFieldStyle(.roundedBorder)
                    .disabled(tapped != nil)
                Button {
                    answer(id, questions)
                } label: {
                    Text("Send answer")
                        .frame(maxWidth: .infinity)
                        .spinning(tapped == .sendAnswer, tint: .white)
                }
                .buttonStyle(.borderedProminent)
                .allowsHitTesting(tapped == nil)
                .disabled(tapped == nil && Answers.build(questions, chosen: chosen, typed: typed).isEmpty)
            case .secret, .other:
                // A kind this build doesn't know (a secret is SecretCard's).
                Label("Answer this on the Mac.", systemImage: "laptopcomputer")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
            }
        }
        .padding()
        .background(Color(.secondarySystemBackground), in: RoundedRectangle(cornerRadius: 16, style: .continuous))
        // Only for taps, never a card turning up. A soft tick to say no, a light
        // tap for what moves things along.
        .sensoryFeedback(trigger: tapped) { _, new in
            switch new {
            case nil: nil
            case .option(.deny): .selection
            default: .impact(weight: .light)
            }
        }
        .sensoryFeedback(.selection, trigger: chosen)
    }

    private func optionRow(index: Int, question: Question, option: Question.Option) -> some View {
        let isOn = chosen[index]?.contains(option.label) == true
        return Button {
            var set = chosen[index] ?? []
            if question.multiSelect {
                if isOn { set.remove(option.label) } else { set.insert(option.label) }
            } else {
                set = isOn ? [] : [option.label]
            }
            chosen[index] = set
        } label: {
            HStack(alignment: .top, spacing: 10) {
                Image(systemName: isOn ? (question.multiSelect ? "checkmark.square.fill" : "largecircle.fill.circle")
                                       : (question.multiSelect ? "square" : "circle"))
                    .foregroundStyle(isOn ? Color.accentColor : .secondary)
                    .contentTransition(.symbolEffect(.replace))
                VStack(alignment: .leading, spacing: 2) {
                    Text(option.label).foregroundStyle(.primary)
                    if let description = option.description {
                        Text(description).font(.footnote).foregroundStyle(.secondary)
                    }
                }
                Spacer(minLength: 0)
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(tapped != nil)
    }

    private func label(_ option: ApprovalOption) -> String {
        switch option {
        case .allow: "Allow"
        case .allowAlways: "Always"
        case .deny: "Deny"
        }
    }

    private func respond(_ approvalId: String, _ decision: ApprovalOption) {
        let threadId = threadId
        // ThreadView says why under the transcript if it's refused.
        model.answerCard(approvalId, choice: decision.rawValue, send: { backend in
            try await backend.respond(threadId: threadId, approvalId: approvalId, decision: decision)
        }, sent: onSent)
    }

    private func answer(_ approvalId: String, _ questions: [Question]) {
        let threadId = threadId
        let answers = Answers.build(questions, chosen: chosen, typed: typed)
        let summary = Answers.summary(questions, answers: answers)
        model.answerCard(approvalId, choice: "send", send: { backend in
            try await backend.answer(threadId: threadId, approvalId: approvalId, answers: answers, summary: summary)
        }, sent: onSent)
    }
}

extension View {
    /// A button's label with a spinner in place of its words, keeping its size.
    func spinning(_ on: Bool, tint: Color? = nil) -> some View {
        opacity(on ? 0 : 1)
            .overlay {
                if on {
                    ProgressView().controlSize(.small).tint(tint)
                }
            }
    }
}

/// Lets one button pick bordered or prominent without two copies.
struct AnyButtonStyle: PrimitiveButtonStyle {
    private let make: (Configuration) -> AnyView
    init<S: PrimitiveButtonStyle>(_ style: S) { make = { AnyView(style.makeBody(configuration: $0)) } }
    func makeBody(configuration: Configuration) -> some View { make(configuration) }
}
