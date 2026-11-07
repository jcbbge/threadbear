import Foundation

/// A web address written in inline code (`github.com/waynesutton/threadbear`,
/// `https://convex.dev`), made a link like the file paths there are
/// (FilePathRefs). With a scheme it's always one; without, only on a
/// common web ending, so a file name (`deploy.sh`, `readme.md`) stays a
/// file: file paths are looked for first anyway.
public enum CodeWebAddress {
    static let endings: Set<String> = [
        "com", "org", "net", "dev", "app", "io", "ai", "co", "run", "site", "so", "me", "xyz", "tech",
        "cloud", "page", "pages", "link", "gg", "fm", "tv", "news", "blog", "us", "uk", "de", "fr", "ca", "au",
    ]

    public static func url(_ code: String) -> URL? {
        let text = code.trimmingCharacters(in: .whitespaces)
        guard !text.isEmpty, text.count < 500, text.rangeOfCharacter(from: .whitespacesAndNewlines) == nil, !text.contains("`") else { return nil }
        if text.range(of: #"^https?://[^\s<>"]+$"#, options: [.regularExpression, .caseInsensitive]) != nil { return URL(string: text) }
        guard let match = text.range(of: #"^(?:www\.)?(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+([a-z]{2,})(?::\d+)?(?:/[^\s<>"]*)?$"#, options: [.regularExpression, .caseInsensitive]) else { return nil }
        let host = String(text[match]).split(separator: "/", maxSplits: 1).first.map(String.init) ?? text
        let ending = host.split(separator: ":").first.map { String($0.split(separator: ".").last ?? "") }?.lowercased() ?? ""
        guard endings.contains(ending) else { return nil }
        return URL(string: "https://" + text)
    }
}
