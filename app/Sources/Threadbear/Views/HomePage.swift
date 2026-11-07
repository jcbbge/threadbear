import AppKit
import SwiftUI
import ThreadbearCore

/// The page a view in the activity bar opens in the detail area (the
/// Librarian's, Scheduled's): a picture of the bear at the job, a few
/// lines on what the view is for, its numbers in tiles, and anything else
/// under them (the Librarian's settings).
struct HomePage<About: View, Below: View>: View {
    let picture: NSImage?
    let pictureLabel: String
    /// What the picture says when it's clicked. A secret: nothing hints at
    /// it, and the pointer stays the arrow.
    var pokes: [String] = []
    let stats: [HomeStat]
    @ViewBuilder let about: () -> About
    @ViewBuilder var below: () -> Below

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: zoomed(32)) {
                // Room under the picture for what it says when it's poked.
                VStack(alignment: .leading, spacing: zoomed(36)) {
                    // Nothing when the picture didn't ship (a build that left
                    // the resource bundle out), rather than a gap.
                    if let picture {
                        PokeablePicture(picture: picture, label: pictureLabel, lines: pokes)
                    }
                    about()
                        .frame(maxWidth: zoomed(620), alignment: .leading)
                }
                if !stats.isEmpty {
                    // Three across at most, so six tiles make even rows.
                    LazyVGrid(
                        columns: [GridItem(.adaptive(minimum: zoomed(170)), spacing: zoomed(14), alignment: .top)],
                        alignment: .leading,
                        spacing: zoomed(14)
                    ) {
                        ForEach(stats) { HomeStatTile(stat: $0) }
                    }
                    .frame(maxWidth: zoomed(620), alignment: .leading)
                }
                below()
                    .frame(maxWidth: zoomed(620), alignment: .leading)
            }
            .frame(maxWidth: zoomed(1000), alignment: .leading)
            .padding(.horizontal, zoomed(32))
            .padding(.top, zoomed(28))
            .padding(.bottom, zoomed(48))
            .frame(maxWidth: .infinity)
        }
    }
}

extension HomePage where Below == EmptyView {
    init(picture: NSImage?, pictureLabel: String, pokes: [String] = [], stats: [HomeStat], @ViewBuilder about: @escaping () -> About) {
        self.init(picture: picture, pictureLabel: pictureLabel, pokes: pokes, stats: stats, about: about) { EmptyView() }
    }
}

/// A home page's picture. Click it and it wobbles from its bottom edge and a
/// short line fades in under it, in the gap above the title, so the page
/// doesn't shift. Under Reduce Motion, just the line.
private struct PokeablePicture: View {
    let picture: NSImage
    let label: String
    let lines: [String]
    @State private var pokes: PokeLines?
    @State private var line: String?
    /// Counts the pokes: the wobble's trigger, and what tells lines apart.
    @State private var count = 0
    @State private var lineShown = false
    @State private var fade: Task<Void, Never>?

    static var shownFor: Duration { .milliseconds(2500) }

    private struct Wobble {
        var angle = 0.0
        var squash = 1.0
    }

    var body: some View {
        Image(nsImage: picture)
            .resizable()
            .interpolation(.high)
            .aspectRatio(contentMode: .fit)
            .keyframeAnimator(initialValue: Wobble(), trigger: Juice.reduceMotion ? 0 : count) { image, wobble in
                image
                    .scaleEffect(x: wobble.squash, y: 2 - wobble.squash, anchor: .bottom)
                    .rotationEffect(.degrees(wobble.angle), anchor: .bottom)
            } keyframes: { _ in
                KeyframeTrack(\.squash) {
                    CubicKeyframe(1.02, duration: 0.045)
                    CubicKeyframe(1, duration: 0.11)
                }
                KeyframeTrack(\.angle) {
                    CubicKeyframe(-2, duration: 0.16)
                    CubicKeyframe(1.5, duration: 0.11)
                    CubicKeyframe(-0.8, duration: 0.1)
                    CubicKeyframe(0, duration: 0.08)
                }
            }
            .onTapGesture { poke() }
            .accessibilityLabel(label)
            // Capped in height too, so a tall picture (the alarm clock) is no
            // bigger than a wide one.
            .frame(maxWidth: zoomed(280), maxHeight: zoomed(260), alignment: .leading)
            .overlay(alignment: .bottomLeading) {
                // Drawn in the gap below, taking no room of its own.
                ZStack(alignment: .leading) {
                    if let line {
                        Text(line)
                            .id(count)
                            .transition(.asymmetric(
                                insertion: .opacity.combined(with: .offset(y: Juice.reduceMotion ? 0 : -zoomed(3))).animation(.easeOut(duration: 0.18).delay(0.09)),
                                removal: .opacity.animation(.linear(duration: 0.09))))
                    }
                }
                .font(.system(size: TypeScale.label))
                .foregroundStyle(.secondary)
                .lineLimit(1)
                .fixedSize()
                .opacity(lineShown ? 1 : 0)
                .offset(y: zoomed(24))
                .allowsHitTesting(false)
            }
            .onDisappear { fade?.cancel() }
    }

    private func poke() {
        var next = pokes ?? PokeLines(lines)
        guard let said = next.poke() else { return }
        pokes = next
        withAnimation(.linear(duration: 0.01)) {
            count += 1
            line = said
            lineShown = true
        }
        fade?.cancel()
        fade = Task {
            try? await Task.sleep(for: Self.shownFor)
            guard !Task.isCancelled else { return }
            withAnimation(.easeIn(duration: 0.3)) { lineShown = false }
            pokes?.endRun()
        }
    }
}

/// A page's title, with more behind the ⓘ, and the line under it.
struct HomeTitle: View {
    let title: String
    let line: String
    let more: String

    var body: some View {
        VStack(alignment: .leading, spacing: zoomed(12)) {
            HStack(alignment: .firstTextBaseline, spacing: zoomed(8)) {
                Text(title)
                    .font(.system(size: zoomed(24), weight: .semibold))
                InfoTip(more)
            }
            Text(line)
                .font(.system(size: TypeScale.label))
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
        }
    }
}

/// What it's doing now, under a page's title: a dot, accent while busy.
struct HomeStatusLine: View {
    let text: String
    let busy: Bool

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: zoomed(6)) {
            Circle()
                .fill(busy ? Color(nsColor: .controlAccentColor) : Color(nsColor: Theme.faintText))
                .frame(width: zoomed(7), height: zoomed(7))
            Text(text)
                .font(.system(size: TypeScale.label))
                .lineLimit(1)
        }
        .padding(.top, zoomed(4))
    }
}

/// One number on a page, what it counts, and more in its tooltip.
struct HomeStat: Identifiable, Equatable {
    var id: String { label }
    let value: String
    let label: String
    let help: String
}

private struct HomeStatTile: View {
    let stat: HomeStat

    var body: some View {
        VStack(alignment: .leading, spacing: zoomed(4)) {
            Text(stat.value)
                .font(.system(size: zoomed(22), weight: .semibold))
                .monospacedDigit()
                .lineLimit(1)
            Text(stat.label)
                .font(.system(size: TypeScale.label))
                .foregroundStyle(.secondary)
                .lineLimit(1)
        }
        .padding(.horizontal, zoomed(14))
        .padding(.vertical, zoomed(12))
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color.primary.opacity(0.04), in: RoundedRectangle(cornerRadius: zoomed(10), style: .continuous))
        .tip(stat.help)
        .accessibilityElement(children: .combine)
    }
}

/// Pictures that ship in the app's resource bundle (Package.swift,
/// Resources/Art). Found by hand rather than through Bundle.module, which
/// stops the app when the bundle isn't there (CodeHighlighter does the
/// same): build-app.sh copies it into Contents/Resources, and `swift run`
/// and `swift test` have it beside the binary.
enum Art {
    @MainActor static let librarian: NSImage? = image("librarian")
    @MainActor static let scheduled: NSImage? = image("scheduled")

    private static let bundle: Bundle? = {
        let name = "Threadbear_Threadbear.bundle"
        return [Bundle.main.resourceURL, Bundle.main.bundleURL, Bundle.main.executableURL?.deletingLastPathComponent()]
            .compactMap { $0?.appendingPathComponent(name) }
            .first { FileManager.default.fileExists(atPath: $0.path) }
            .flatMap(Bundle.init(url:))
    }()

    private static func image(_ name: String) -> NSImage? {
        guard let url = bundle?.url(forResource: name, withExtension: "png", subdirectory: "Art") else { return nil }
        return NSImage(contentsOf: url)
    }
}
