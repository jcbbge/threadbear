import AppKit
import QuartzCore
import SwiftUI
import ThreadbearCore

/// Voice mode's button beside Send: a waveform in a circle, blue to start
/// and red while it's on, its bars moving with whoever is talking. The
/// words he's saying, or what it's doing, show beside it.
struct VoiceButton: View {
    let threadId: String
    let size: CGFloat
    @State private var voice = VoiceMode.shared

    var body: some View {
        let on = voice.isOn(for: threadId)
        HStack(spacing: 6) {
            Button {
                voice.toggle(threadId: threadId)
            } label: {
                VoiceBars(level: on ? CGFloat(voice.level) : 0, active: on, busy: busy)
                    .frame(width: size * 0.5, height: size * 0.5)
                    .foregroundStyle(.white)
                    .frame(width: size, height: size)
                    .background(Circle().fill(on ? Color.red : Color.accentColor))
                    .contentShape(Circle())
            }
            .buttonStyle(.plain)
            .tip(on ? "End voice" : "Talk with this thread out loud")
            .accessibilityLabel(on ? "End voice" : "Start voice")
        }
        .animation(.easeOut(duration: 0.15), value: on)
        .popover(isPresented: failureShown) {
            if case .failed(let message) = voice.phase {
                Text(message)
                    .padding(12)
                    .frame(maxWidth: 300)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
    }

    private var failureShown: Binding<Bool> {
        Binding(get: {
            if case .failed = voice.phase, voice.threadId == threadId { return true }
            return false
        }, set: { if !$0 { voice.dismissFailure() } })
    }

    private var busy: Bool {
        switch voice.phase {
        case .starting, .thinking: true
        default: false
        }
    }

}

/// Five bars: still when off, gently pulsing while busy, and following the
/// sound level while someone talks. Layers, moved by Core Animation, as the
/// bear's are (AGENTS.md, Animations): the app only sets their heights a few
/// times a second, and the pulse carries on while the main thread is busy.
struct VoiceBars: NSViewRepresentable {
    let level: CGFloat
    let active: Bool
    let busy: Bool

    func makeNSView(context: Context) -> VoiceBarsView { VoiceBarsView() }

    func updateNSView(_ view: VoiceBarsView, context: Context) {
        view.update(level: level, active: active, busy: busy)
    }
}

final class VoiceBarsView: NSView {
    private static let shape: [CGFloat] = [0.45, 0.75, 1, 0.75, 0.45]
    private var bars: [CALayer] = []
    private var level: CGFloat = 0
    private var active = false
    private var busy = false
    private var pulsing = false

    override init(frame: NSRect) {
        super.init(frame: frame)
        wantsLayer = true
        for _ in Self.shape {
            let bar = CALayer()
            bar.backgroundColor = NSColor.white.cgColor
            layer?.addSublayer(bar)
            bars.append(bar)
        }
    }

    required init?(coder: NSCoder) { fatalError("not from a nib") }

    override func layout() {
        super.layout()
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        let width = bounds.width * 0.12, gap = bounds.width * 0.1
        let total = width * 5 + gap * 4
        for (i, bar) in bars.enumerated() {
            bar.anchorPoint = CGPoint(x: 0.5, y: 0.5)
            bar.position = CGPoint(x: (bounds.width - total) / 2 + width / 2 + CGFloat(i) * (width + gap), y: bounds.midY)
            bar.cornerRadius = width / 2
            bar.bounds = CGRect(x: 0, y: 0, width: width, height: bounds.height * height(i))
        }
        CATransaction.commit()
        setPulse()
    }

    override func setFrameSize(_ newSize: NSSize) {
        super.setFrameSize(newSize)
        needsLayout = true
    }

    override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        // Infinite animations don't outlive leaving the window.
        pulsing = false
        if window != nil { setPulse() }
    }

    func update(level: CGFloat, active: Bool, busy: Bool) {
        self.level = level
        self.active = active
        self.busy = busy
        setPulse()
        CATransaction.begin()
        CATransaction.setAnimationDuration(0.12)
        for (i, bar) in bars.enumerated() {
            bar.bounds.size = CGSize(width: bar.bounds.width, height: bounds.height * height(i))
        }
        CATransaction.commit()
    }

    private func height(_ i: Int) -> CGFloat {
        guard active else { return Self.shape[i] * 0.8 }
        if pulseWanted { return 0.3 }
        return max(0.2, min(1, Self.shape[i] * (0.25 + level)))
    }

    private var pulseWanted: Bool { active && busy && level < 0.05 && !Juice.reduceMotion }

    private func setPulse() {
        guard pulseWanted != pulsing, bounds.height > 0 else { return }
        pulsing = pulseWanted
        for (i, bar) in bars.enumerated() {
            guard pulsing else {
                bar.removeAnimation(forKey: "pulse")
                continue
            }
            let pulse = CABasicAnimation(keyPath: "bounds.size.height")
            pulse.fromValue = bounds.height * 0.3
            pulse.toValue = bounds.height * 0.55
            pulse.duration = 0.8
            pulse.autoreverses = true
            pulse.repeatCount = .infinity
            pulse.isRemovedOnCompletion = false
            pulse.timingFunction = CAMediaTimingFunction(name: .easeInEaseOut)
            pulse.timeOffset = Double(i) * 0.2
            bar.add(pulse, forKey: "pulse")
        }
    }
}
