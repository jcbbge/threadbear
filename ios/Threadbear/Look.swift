import SwiftUI
import ThreadbearKit

/// The Mac sidebar's colours (app Theme and SidebarMetrics), so a row reads
/// the same on both. The accent itself is the asset catalogue's, set to the
/// system blue the Mac's accent is.
enum Look {
    /// "Needs you": system orange on the dark look; a darker shade of the
    /// same hue in light mode, where system orange on white is about 2:1.
    static let needsYou = dynamic(dark: .systemOrange, light: UIColor(red: 0.70, green: 0.33, blue: 0, alpha: 1))
    /// "Failed", likewise.
    static let failed = dynamic(dark: .systemRed, light: UIColor(red: 0.78, green: 0.13, blue: 0.13, alpha: 1))
    /// Times and folder names: quieter than secondary, still about 3.3:1.
    static let faint = dynamic(dark: UIColor(white: 1, alpha: 0.36), light: UIColor(white: 0, alpha: 0.45))
    /// A project tile's fill, and the hairline under a heading.
    static let tile = Color.primary.opacity(0.08)
    /// The folder tile for a thread in no project: quieter still.
    static let folderTile = Color.primary.opacity(0.04)

    private static func dynamic(dark: UIColor, light: UIColor) -> Color {
        Color(UIColor { $0.userInterfaceStyle == .dark ? dark : light })
    }
}

/// The user's bubble as the Mac draws it: a touch of the accent over a
/// faint grey, rather than a solid grey block.
struct BubbleBackground: View {
    @Environment(\.colorScheme) private var scheme

    var body: some View {
        ZStack {
            Color.primary.opacity(scheme == .dark ? 0.06 : 0.035)
            Color.accentColor.opacity(0.09)
        }
    }
}

/// A row's project as the Mac's ProjectTiles: the first project's picture
/// filling a tile, or its symbol or first letter on a quiet one; a second
/// tile's edge showing behind it when the thread is in more than one; a
/// folder when it's in none.
struct ProjectTiles: View {
    @Environment(AppModel.self) private var model
    var projects: [ProjectRef]
    var size: CGFloat = 30

    var body: some View {
        let corner = size * 0.23
        ZStack(alignment: .bottomLeading) {
            if projects.count > 1 {
                // Up and to the right of the front tile, with the front
                // tile's shape cut out so the overlap doesn't show darker.
                RoundedRectangle(cornerRadius: corner)
                    .fill(Look.tile)
                    .frame(width: size, height: size)
                    .mask {
                        ZStack {
                            Rectangle()
                            RoundedRectangle(cornerRadius: corner + 1)
                                .frame(width: size + 2, height: size + 2)
                                .offset(x: -4, y: 4)
                                .blendMode(.destinationOut)
                        }
                        .compositingGroup()
                    }
                    .offset(x: 4, y: -4)
            }
            ProjectIconView(project: projects.first.flatMap { model.project($0.id) }, title: projects.first?.title, size: size)
        }
        .frame(width: size + 4, height: size + 4, alignment: .bottomLeading)
        .accessibilityHidden(true)
    }
}

/// One project's icon (the Mac's ProjectIconView): its picture, else its
/// symbol, else the title's first letter; a folder with no project at all.
struct ProjectIconView: View {
    var project: PhoneProject?
    /// The title to take a letter from when the projects list hasn't caught
    /// up with a thread's ProjectRef yet.
    var title: String?
    var size: CGFloat

    var body: some View {
        let corner = size * 0.23
        let shape = RoundedRectangle(cornerRadius: corner, style: .continuous)
        if let url = project?.icon?.url, let image = ProjectPictures.shared.image(at: url) {
            Image(uiImage: image)
                .resizable()
                .interpolation(.high)
                .aspectRatio(contentMode: .fit)
                .frame(width: size, height: size)
                .clipShape(shape)
        } else {
            Group {
                if let symbol = project?.icon?.symbol, UIImage(systemName: symbol) != nil {
                    Image(systemName: symbol)
                        .font(.system(size: size * 0.47))
                        .foregroundStyle(.secondary)
                } else if let title = project?.title ?? title {
                    Text(ProjectMark.letter(title))
                        .font(.system(size: size * 0.47, weight: .semibold, design: .rounded))
                        .foregroundStyle(.secondary)
                } else {
                    Image(systemName: "folder")
                        .font(.system(size: size * 0.4))
                        .foregroundStyle(Look.faint)
                }
            }
            .frame(width: size, height: size)
            .background(project == nil && title == nil ? Look.folderTile : Look.tile, in: shape)
        }
    }
}

/// Pictures fetched once per URL and kept for the app's life. A changed
/// picture is a new file in storage, so a new URL, and nothing here goes
/// stale. Reading `image(at:)` from a view body registers the view with
/// the observation, so it redraws when the picture arrives.
@MainActor @Observable
final class ProjectPictures {
    static let shared = ProjectPictures()
    private var images: [URL: UIImage] = [:]
    @ObservationIgnored private var loading: Set<URL> = []
    @ObservationIgnored private var failed: Set<URL> = []

    func image(at url: URL) -> UIImage? {
        if let image = images[url] { return image }
        guard !loading.contains(url), !failed.contains(url) else { return nil }
        loading.insert(url)
        Task {
            defer { loading.remove(url) }
            // Capped and downsampled like a reply's pictures: the address comes
            // from the mirror, and an icon is never shown bigger than a tile.
            guard let data = try? await CappedDownload.data(from: url, session: .shared, limit: 5 * 1024 * 1024),
                  let source = try? PictureSource.open(data), let cg = PictureSource.thumbnail(source, maxSide: 512) else {
                failed.insert(url)
                return
            }
            images[url] = UIImage(cgImage: cg)
        }
        return nil
    }
}

/// A group's heading as the Mac sidebar has it: a small symbol, the title
/// in semibold grey, and a hairline out to the edge.
struct SectionHeading: View {
    var title: String
    var icon: String
    /// For a heading that folds: whether it's folded and how many rows
    /// that hides (nil: not known yet).
    var fold: Fold?
    /// Goes up to give the icon one small bounce (a thread tucked in).
    var bounce = 0

    struct Fold {
        var folded: Bool
        var count: Int?
    }

    var body: some View {
        HStack(spacing: 6) {
            Image(systemName: icon)
                .font(.system(size: 12, weight: .medium))
                .symbolEffect(.bounce, value: bounce)
                .frame(width: 16)
            Text(title)
                .font(.subheadline.weight(.semibold))
                .fixedSize()
            Rectangle()
                .fill(Look.tile)
                .frame(height: 1)
                .padding(.horizontal, 4)
            if let fold {
                // Folded, the count says what's hidden, as on the Mac.
                if fold.folded, let count = fold.count {
                    Text("\(count)")
                        .font(.footnote)
                        .monospacedDigit()
                        .foregroundStyle(Look.faint)
                        .contentTransition(.numericText(value: Double(count)))
                }
                // Always showing: there's no hover on the phone to reveal it.
                Image(systemName: "chevron.down")
                    .font(.system(size: 10, weight: .semibold))
                    .foregroundStyle(Look.faint)
                    .rotationEffect(.degrees(fold.folded ? -90 : 0))
            }
        }
        .foregroundStyle(.secondary)
        .padding(.top, 14)
        .padding(.bottom, 4)
        // The whole band takes the tap, not just the words.
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(fold == nil ? .isHeader : [.isHeader, .isButton])
        .accessibilityValue(fold.map { $0.folded ? "Collapsed" : "Expanded" } ?? "")
    }
}
