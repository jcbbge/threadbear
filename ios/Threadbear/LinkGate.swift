import SwiftUI
import ThreadbearKit
import UIKit

/// The phone's one way to hand a link to iOS (SECURITY.md, "Links and
/// files"), as OpenGate is the Mac's. A web page opens in the browser; any
/// other scheme starts another app with what the link says, so it waits for
/// a yes that names it; a file is the Mac's. The app's root sets this as
/// every view's `openURL`, and a thread's own link handling (`follow`) ends
/// here for anything that isn't a link into the thread (Daybreak, 7 Nov).
@MainActor
final class LinkGate {
    static let shared = LinkGate()

    /// What really opens, and what asks. Seams, so nothing opens in a test.
    var systemOpen: @MainActor (URL) -> Void = { UIApplication.shared.open($0) }
    var ask: @MainActor (_ title: String, _ detail: String, _ yes: String?, _ answer: @escaping @MainActor () -> Void) -> Void = { LinkGate.alert($0, $1, $2, $3) }

    func decide(_ url: URL) -> OpenURLAction.Result {
        switch LinkPolicy.kind(of: url) {
        case .web(let web):
            return .systemAction(web)
        case .file:
            ask("That file opens on the Mac.", "", nil) {}
            return .handled
        case .ask(let other):
            let question = Self.question(other)
            ask(question.title, question.detail, "Open") { [weak self] in self?.systemOpen(other) }
            return .handled
        case .refuse:
            return .discarded
        }
    }

    /// One of the app's own links, fixed in the code (Settings, its docs).
    /// Never a link from a thread, a Mac or a page.
    func openOwn(_ url: URL) {
        systemOpen(url)
    }

    /// The question's words for a link that isn't a web page.
    static func question(_ url: URL) -> (title: String, detail: String) {
        ("Open this \(url.scheme ?? "") link?",
         "It isn't a web page: it opens another app, which acts on what the link says. It's from a thread, so Threadbear asks first.\n\n\(LinkPolicy.shown(url))")
    }

    /// An alert over whatever's on top. Not SwiftUI's `.alert` at the root:
    /// a link in the working sheet or a full-screen picture would ask from
    /// under what's presented, which shows nothing and leaves the tap dead.
    private static func alert(_ title: String, _ detail: String, _ yes: String?, _ answer: @escaping @MainActor () -> Void) {
        let scenes = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
        let window = scenes.flatMap(\.windows).first(where: \.isKeyWindow) ?? scenes.first?.windows.first
        guard var top = window?.rootViewController else { return }
        while let next = top.presentedViewController { top = next }
        let sheet = UIAlertController(title: title, message: detail.isEmpty ? nil : detail, preferredStyle: .alert)
        if let yes {
            sheet.addAction(UIAlertAction(title: "Cancel", style: .cancel))
            sheet.addAction(UIAlertAction(title: yes, style: .default) { _ in MainActor.assumeIsolated { answer() } })
        } else {
            sheet.addAction(UIAlertAction(title: "OK", style: .cancel))
        }
        top.present(sheet, animated: true)
    }
}

extension View {
    /// Every link under here goes through LinkGate.
    func linksThroughGate(_ gate: LinkGate = .shared) -> some View {
        environment(\.openURL, OpenURLAction { gate.decide($0) })
    }
}
