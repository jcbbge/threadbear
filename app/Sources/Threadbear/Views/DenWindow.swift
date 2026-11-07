import AppKit
import SwiftUI
import ThreadbearCore

/// Threadbear > About Threadbear: a small window of its own in place of the
/// stock panel, with the bear waving once as it opens and a few lines from
/// what the app already knows. A den is where a bear lives.
@MainActor
enum DenWindow {
    private(set) static var current: NSWindow?

    static func show(app: AppModel) {
        let window = current ?? make()
        current = window
        // Open already: just to the front, not another wave.
        if !window.isVisible {
            // The numbers are as of each opening, and it waves each time.
            let build = BuildInfo.read(bundle: Bundle.main.bundleURL)
            let view = DenView(lines: DenLines.make(app.threads.values, now: Date()), short: build?.short,
                               build: build.flatMap { DenLines.build(short: $0.short, builtAt: $0.builtAt) })
            window.contentView = NSHostingView(rootView: view)
            window.setContentSize(window.contentView?.fittingSize ?? window.frame.size)
            if let main = MainWindowFrame.window {
                window.setFrameOrigin(NSPoint(x: main.frame.midX - window.frame.width / 2,
                                              y: main.frame.maxY - window.frame.height - min(70, main.frame.height / 8)))
            } else {
                window.center()
            }
        }
        #if DEBUG
        if Automation.instanceId != nil {
            window.tuckBehind()
            return
        }
        #endif
        window.makeKeyAndOrderFront(nil)
    }

    private static func make() -> NSWindow {
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: zoomed(320), height: 100),
                              styleMask: [.titled, .closable, .fullSizeContentView], backing: .buffered, defer: false)
        window.titlebarAppearsTransparent = true
        window.titleVisibility = .hidden
        window.isMovableByWindowBackground = true
        window.isReleasedWhenClosed = false
        window.title = "About Threadbear"
        window.standardWindowButton(.miniaturizeButton)?.isHidden = true
        window.standardWindowButton(.zoomButton)?.isHidden = true
        return window
    }
}

private struct DenView: View {
    let lines: [String]
    let short: String?
    let build: String?
    @State private var opened = false
    @State private var waves = 0

    var body: some View {
        VStack(spacing: 0) {
            Image(nsImage: Bear.image(.wave, side: zoomed(80)))
                .renderingMode(.template)
                .foregroundStyle(.primary.opacity(0.85))
                // A tilt from its feet, once, as it opens.
                .keyframeAnimator(initialValue: 0.0, trigger: waves) { bear, angle in
                    bear.rotationEffect(.degrees(angle), anchor: .bottom)
                } keyframes: { _ in
                    KeyframeTrack {
                        CubicKeyframe(-9, duration: 0.225)
                        CubicKeyframe(7, duration: 0.225)
                        CubicKeyframe(-5, duration: 0.216)
                        CubicKeyframe(0, duration: 0.234)
                    }
                }
                .accessibilityHidden(true)
            Text("Threadbear")
                .font(.system(size: zoomed(15), weight: .semibold))
                .padding(.top, zoomed(14))
            if !lines.isEmpty {
                VStack(spacing: 0) {
                    ForEach(lines, id: \.self) { Text($0).frame(minHeight: zoomed(22)) }
                }
                .font(.system(size: TypeScale.label))
                .foregroundStyle(.secondary)
                .padding(.top, zoomed(10))
            }
            VStack(spacing: zoomed(4)) {
                if let build { Text(buildLine(build)) }
                Text(DenLines.credit)
            }
            .font(.system(size: zoomed(11.5)))
            .foregroundStyle(.secondary)
            .opacity(0.75)
            .padding(.top, zoomed(16))
            // So a line can be copied into a bug report.
            .textSelection(.enabled)
        }
        .multilineTextAlignment(.center)
        .fixedSize(horizontal: false, vertical: true)
        .padding(.horizontal, zoomed(26))
        .padding(.top, zoomed(20))
        .padding(.bottom, zoomed(24))
        .frame(width: zoomed(320))
        .scaleEffect(opened || Juice.reduceMotion ? 1 : 0.96)
        .opacity(opened || Juice.reduceMotion ? 1 : 0)
        .onAppear {
            withAnimation(.timingCurve(0.2, 0.9, 0.3, 1, duration: 0.22)) { opened = true }
            if !Juice.reduceMotion { waves += 1 }
        }
    }

    /// The commit in the code face, a touch brighter than the words round it.
    private func buildLine(_ line: String) -> AttributedString {
        var text = AttributedString(line)
        if let short, let range = text.range(of: short) {
            text[range].font = .system(size: zoomed(11), design: .monospaced)
            text[range].foregroundColor = .secondary
        }
        return text
    }
}
