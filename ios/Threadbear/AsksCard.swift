import SwiftUI
import ThreadbearKit

/// What a finished turn needs from Mike (its end_turn asks, backend API 14),
/// under the reply, as the Mac's Needs you card: each ask as one paragraph,
/// its links, and its likely answers as buttons. With one ask a tap sends
/// it; with several he picks, then sends. Anything else goes in the composer,
/// which sends the picks along with it.
struct AsksCard: View {
    let asks: [PhoneAsk]
    @Binding var picks: [Int: Int]
    /// Its answer is on its way: spinning, and nothing more to press.
    var busy: Bool
    var send: () -> Void
    /// Goes up with each pick, for its tick. Not the picks themselves, which a
    /// new card clears.
    @State private var pickTaps = 0
    @State private var sendTaps = 0

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            ForEach(Array(asks.enumerated()), id: \.offset) { index, ask in
                askView(ask, index: index)
            }
            if asks.count > 1, !picks.isEmpty {
                Button {
                    sendTaps += 1
                    send()
                } label: {
                    Text("Send").frame(maxWidth: .infinity).spinning(busy, tint: .white)
                }
                .buttonStyle(.borderedProminent)
                .allowsHitTesting(!busy)
            }
        }
        .padding()
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color(.secondarySystemBackground), in: RoundedRectangle(cornerRadius: 16, style: .continuous))
        .sensoryFeedback(.selection, trigger: pickTaps)
        .sensoryFeedback(.impact(weight: .light), trigger: sendTaps)
    }

    private func askView(_ ask: PhoneAsk, index: Int) -> some View {
        let ticked = ask.ticked == true
        return VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .firstTextBaseline, spacing: 6) {
                if ticked {
                    Image(systemName: "checkmark.circle.fill").foregroundStyle(.secondary)
                } else if asks.count > 1 {
                    Text("\(index + 1).").foregroundStyle(.secondary)
                }
                MarkdownText(ask.paragraph)
                    .textSelection(.enabled)
                    .foregroundStyle(ticked ? .secondary : .primary)
            }
            if !ticked, !(ask.links ?? []).isEmpty || !ask.choices.isEmpty {
                FlowLayout(spacing: 8) {
                    ForEach(ask.links ?? [], id: \.url) { link in
                        if let url = URL(string: link.url) {
                            Link(destination: url) {
                                Label(link.title, systemImage: "arrow.up.right.square")
                            }
                            .buttonStyle(.bordered)
                            .tint(.secondary)
                        }
                    }
                    ForEach(Array(ask.choices.enumerated()), id: \.offset) { choice, label in
                        choiceButton(label, index: index, choice: choice, suggested: ask.suggestedIndex == choice)
                    }
                }
                .controlSize(.small)
            }
        }
    }

    private func choiceButton(_ label: String, index: Int, choice: Int, suggested: Bool) -> some View {
        let picked = picks[index] == choice
        return Button {
            guard !busy else { return }
            if asks.count == 1 {
                // The only one, so the tap sends it: it goes prominent and spins.
                sendTaps += 1
                picks = [index: choice]
                send()
            } else {
                pickTaps += 1
                picks[index] = picked ? nil : choice
            }
        } label: {
            HStack(spacing: 4) {
                // The agent's own pick, as the Mac marks it.
                if suggested && !picked { Image(systemName: "star.fill").imageScale(.small).foregroundStyle(.secondary) }
                Text(label).spinning(picked && busy && asks.count == 1, tint: .white)
            }
        }
        .buttonStyle(picked ? AnyButtonStyle(.borderedProminent) : AnyButtonStyle(.bordered))
        .tint(picked ? .accentColor : .primary)
        // A picked one keeps its colour, so it's clear which is on its way.
        .disabled(busy && !picked)
        .allowsHitTesting(!busy)
    }
}

/// Under a finished turn that needs nothing, as the Mac's Done card:
/// Done and Archive on one line, then the agent's suggested follow-ups
/// (end_turn's `next`) under "Or carry on". A tap ticks one (again
/// unticks it), so he can pick several, as on the Mac (30 Oct); Send on
/// the card sends them, and the composer's Send takes them with what's
/// typed.
struct DoneCard: View {
    let next: [String]
    @Binding var picked: Set<Int>
    /// The ticked ones are on their way: Send spins, and nothing more to press.
    var busy: Bool
    var send: () -> Void
    var archive: () -> Void
    @State private var tickTaps = 0
    @State private var sendTaps = 0

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                Label("Done", systemImage: "checkmark.circle")
                    .font(.subheadline.weight(.medium))
                    .foregroundStyle(.secondary)
                Spacer()
                Button(action: archive) {
                    Image(systemName: "archivebox")
                }
                .buttonStyle(.bordered)
                .tint(.secondary)
                .controlSize(.small)
                .accessibilityLabel("Archive")
            }
            if !next.isEmpty {
                Text("Or carry on").font(.footnote).foregroundStyle(.secondary)
                ForEach(Array(next.enumerated()), id: \.offset) { index, step in
                    let ticked = picked.contains(index)
                    Button {
                        tickTaps += 1
                        if ticked { picked.remove(index) } else { picked.insert(index) }
                    } label: {
                        HStack(alignment: .firstTextBaseline, spacing: 10) {
                            Image(systemName: ticked ? "checkmark.circle.fill" : "circle")
                                .foregroundStyle(ticked ? Color.accentColor : .secondary)
                                .contentTransition(.symbolEffect(.replace))
                            Text(step).multilineTextAlignment(.leading)
                            Spacer(minLength: 0)
                        }
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .disabled(busy)
                    .accessibilityAddTraits(ticked ? .isSelected : [])
                }
                if !picked.isEmpty {
                    Button {
                        sendTaps += 1
                        send()
                    } label: {
                        Text("Send").frame(maxWidth: .infinity).spinning(busy, tint: .white)
                    }
                    .buttonStyle(.borderedProminent)
                    .allowsHitTesting(!busy)
                }
            }
        }
        .padding(12)
        .background(Color(.secondarySystemBackground), in: RoundedRectangle(cornerRadius: 14, style: .continuous))
        .sensoryFeedback(.selection, trigger: tickTaps)
        .sensoryFeedback(.impact(weight: .light), trigger: sendTaps)
    }
}

/// A finished turn's work, folded into one line that opens to it, as the
/// Mac shows it. The reply sits under it, outside the fold.
struct WorkedView: View {
    let worked: WorkedTurn

    var body: some View {
        DisclosureGroup {
            WorkedItems(worked: worked)
                .padding(.top, 6)
        } label: {
            Text(worked.title)
        }
        .font(.footnote)
        .foregroundStyle(.secondary)
        .tint(.secondary)
    }
}

/// "6 min later · Mine the repo finished": a thin rule with the wait in the
/// middle, before a turn the agent started by itself (TurnGap). Quiet, like
/// a chat app's day divider, as on the Mac.
struct GapView: View {
    let gap: TurnGap

    var body: some View {
        HStack(spacing: 10) {
            rule
            Text(gap.label)
                .font(.caption)
                .foregroundStyle(.tertiary)
                .lineLimit(1)
                .truncationMode(.tail)
                .layoutPriority(1)
            rule
        }
        .padding(.vertical, 2)
        .accessibilityElement(children: .combine)
    }

    private var rule: some View {
        Rectangle()
            .fill(.quaternary)
            .frame(height: 1 / UIScreen.main.scale)
            .frame(minWidth: 24)
    }
}

/// What a turn's working is made of, in its fold or a work: link's sheet.
struct WorkedItems: View {
    let worked: WorkedTurn

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            ForEach(worked.items) { item in
                switch item {
                case let .message(message):
                    if message.role == .assistant {
                        MarkdownText(message.text, seq: message.seq)
                            .font(.subheadline)
                            .foregroundStyle(.secondary)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .step(message.seq)
                    } else {
                        MessageView(message: message)
                    }
                case let .tools(run): ToolRunView(items: run)
                case let .worked(inner): WorkedView(worked: inner)
                case let .gap(gap): GapView(gap: gap)
                }
            }
        }
    }
}

/// Buttons that wrap onto the next line when they don't fit.
struct FlowLayout: Layout {
    var spacing: CGFloat = 8

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let rows = arrange(proposal.width ?? .infinity, subviews)
        let width = rows.map { $0.width }.max() ?? 0
        let height = rows.reduce(0) { $0 + $1.height } + spacing * CGFloat(max(0, rows.count - 1))
        return CGSize(width: proposal.width ?? width, height: height)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        var y = bounds.minY
        for row in arrange(bounds.width, subviews) {
            var x = bounds.minX
            for i in row.indexes {
                let size = subviews[i].sizeThatFits(.init(width: bounds.width, height: nil))
                subviews[i].place(at: CGPoint(x: x, y: y), proposal: .init(width: min(size.width, bounds.width), height: size.height))
                x += min(size.width, bounds.width) + spacing
            }
            y += row.height + spacing
        }
    }

    private struct Row { var indexes: [Int] = []; var width: CGFloat = 0; var height: CGFloat = 0 }

    private func arrange(_ maxWidth: CGFloat, _ subviews: Subviews) -> [Row] {
        var rows: [Row] = []
        var row = Row()
        for (i, view) in subviews.enumerated() {
            let size = view.sizeThatFits(.init(width: maxWidth, height: nil))
            let width = min(size.width, maxWidth)
            if !row.indexes.isEmpty, row.width + spacing + width > maxWidth {
                rows.append(row)
                row = Row()
            }
            row.width += (row.indexes.isEmpty ? 0 : spacing) + width
            row.height = max(row.height, size.height)
            row.indexes.append(i)
        }
        if !row.indexes.isEmpty { rows.append(row) }
        return rows
    }
}
