import Foundation
import ThreadbearCore
import WebKit

/// Serves local HTML previews as `threadbear-preview://<token>/<page>`,
/// answering only for what LocalPreviewSite allows: the page and the assets
/// it names in its folder. A `file://` load with read access to the folder
/// let a page read any file beside it (Daybreak finding 6). The page's own
/// scripts are off (WebPanelPool), so what it names can be shown, not read,
/// until Mike chooses Run them for those exact bytes (PreviewScriptConsent).
/// Then its scripts can read what it names, and everything below is what
/// keeps that on the screen.
///
/// Each load gets a new token, so each is its own origin with a fresh list
/// of what it may read, and two previews can't read each other's files.
///
/// A page can still read a file beside it that its markup names, so it may
/// send nothing out: every answer carries `policy` as its
/// Content-Security-Policy (which a page can't loosen), and WebPanelPool
/// adds a content rule list blocking every load but this scheme's and
/// refuses navigating away, new windows and downloads.
final class LocalPreviewSchemeHandler: NSObject, WKURLSchemeHandler {
    static let scheme = "threadbear-preview"
    /// Inline styles stay, for mockups (scripts are off anyway); everything
    /// else is this scheme's alone, or data: and blob: made on the page.
    static let policy = [
        "default-src \(scheme): 'unsafe-inline' 'unsafe-eval' data: blob:",
        "connect-src \(scheme):",
        "form-action 'none'",
        "frame-src \(scheme): data: blob:",
        "base-uri 'none'",
    ].joined(separator: "; ")
    /// For a page running its scripts: frames of this scheme only, so a
    /// script can't make a data: or blob: frame to run in (clipboardGuard).
    static let scriptsPolicy = policy.replacingOccurrences(of: "frame-src \(scheme): data: blob:", with: "frame-src \(scheme):")
    /// In every frame, first: a click on a link (HTML or SVG, in a shadow
    /// root too) to anywhere but this scheme is cancelled before WebKit
    /// starts the navigation, which is when it would open a connection.
    static let linkGuard = """
    (() => {
      const own = '\(scheme):';
      addEventListener('click', (e) => {
        for (const node of e.composedPath()) {
          if (!node || !node.getAttribute) continue;
          const name = (node.localName || '').toLowerCase();
          if (name !== 'a' && name !== 'area') continue;
          const href = node.getAttribute('href') ?? node.getAttributeNS('http://www.w3.org/1999/xlink', 'href');
          if (href == null) return;
          let target;
          try { target = new URL(href, document.baseURI).protocol; } catch (_) { target = ''; }
          if (target !== own) e.preventDefault();
          return;
        }
        // No link found, but one inside a closed shadow root can't be seen
        // from here: the click is retargeted to its host. A click on an
        // element that can host one has no default action of its own, so
        // cancelling it costs nothing (cross-lab review, 6 Nov).
        const at = e.target && e.target.localName || '';
        if (at.includes('-') || ['article','aside','blockquote','body','div','footer','h1','h2','h3','h4','h5','h6','header','main','nav','p','section','span'].includes(at)) e.preventDefault();
      }, true);
    })();
    """

    /// In a view running the page's scripts, in every frame, first and in a
    /// world of its own (so the page can't reach these listeners): nothing
    /// is dragged or copied out of the page. A script there can read the
    /// assets the page names and could hand them to a drag or a copy, which
    /// go through the OS rather than the network (Codex review, 6 Nov 2026).
    static let scriptsGuard = """
    (() => {
      for (const type of ['dragstart', 'copy', 'cut']) {
        addEventListener(type, (e) => { e.preventDefault(); e.stopImmediatePropagation(); }, true);
      }
    })();
    """
    /// The same view, in the page's world, in every frame: no Clipboard
    /// API, and no `execCommand('copy')` or `'cut'`, either of which a
    /// script can use on any click in the page to put what it read on the
    /// pasteboard. WebKit writes those itself, past SealedPreviewWebView
    /// (Codex review). Defined before the page's scripts and not
    /// configurable, and a scripts-on page gets no data: or blob: frames
    /// (`scriptsPolicy`), where it could look for a copy of its own.
    static let clipboardGuard = """
    (() => {
      try { delete Navigator.prototype.clipboard; } catch (_) {}
      try { Object.defineProperty(Navigator.prototype, 'clipboard', { get: () => undefined, configurable: false }); } catch (_) {}
      // Everything the wrapper uses is taken now, before the page's scripts
      // can replace it, and the command is made a string once and that
      // string passed on: a name that reads "bold" to the check and "copy"
      // to WebKit got past the first version (Codex review).
      const exec = Document.prototype.execCommand;
      const apply = Reflect.apply, toString = String, lower = String.prototype.toLowerCase;
      Object.defineProperty(Document.prototype, 'execCommand', {
        value: function (command, showUI, value) {
          const name = toString(command);
          const key = apply(lower, name, []);
          if (key === 'copy' || key === 'cut') return false;
          return apply(exec, this, arguments.length > 2 ? [name, showUI, value] : arguments.length > 1 ? [name, showUI] : [name]);
        },
        writable: false, configurable: false,
      });
    })();
    """

    /// Everything blocked but this scheme's own loads.
    static let ruleList = """
    [{"trigger":{"url-filter":".*"},"action":{"type":"block"}},
     {"trigger":{"url-filter":"^\(scheme):"},"action":{"type":"ignore-previous-rules"}}]
    """
    private var sites: [String: LocalPreviewSite] = [:]
    /// The newest token for each file, so a reload drops the one before.
    private var tokens: [String: String] = [:]

    /// Whether `url` is this preview's own, the only place its view may go.
    static func isPreview(_ url: URL?) -> Bool {
        url?.scheme == scheme || url?.absoluteString == "about:blank" || url?.absoluteString == "about:srcdoc"
    }

    /// The address to load `file` at, or nil for a file that can't be a page.
    /// With `pageDigest`, for a view running the page's scripts: the page is
    /// served only while its bytes match, and only to `owner`, so a script
    /// can't reach a site through another view's token.
    func address(for file: URL, pageDigest: String? = nil, owner: WKWebView? = nil) -> URL? {
        guard let site = LocalPreviewSite(file: file, pageDigest: pageDigest) else { return nil }
        // The static view and a scripts-on one of the same file are kept
        // apart, so loading one doesn't take the other's token away.
        let key = file.standardizedFileURL.path + "\n" + (pageDigest ?? "")
        if let old = tokens[key] { sites[old] = nil; owners[old] = nil }
        let token = UUID().uuidString.lowercased()
        tokens[key] = token
        sites[token] = site
        if let owner { owners[token] = ObjectIdentifier(owner) }
        var c = URLComponents()
        c.scheme = Self.scheme
        c.host = token
        c.path = "/" + site.page
        return c.url
    }

    /// The one view each scripts-on site answers.
    private var owners: [String: ObjectIdentifier] = [:]

    /// Stops serving `file` (its static view's site), and lets the site
    /// close the folder it holds open: the transcript's html boxes are
    /// drawn once each, and kept they added up to one open folder per
    /// block (cross-lab review, 6 Nov).
    func forget(_ file: URL) {
        if let token = tokens.removeValue(forKey: file.standardizedFileURL.path + "\n") {
            sites[token] = nil
            owners[token] = nil
        }
    }

    func forgetAll() {
        tokens = [:]
        sites = [:]
        owners = [:]
    }

    /// For tests: answers a request the way WebKit would see it answered.
    func respond(to url: URL) -> (response: HTTPURLResponse, data: Data) {
        Self.answer(url, site: site(for: url))
    }

    private func site(for url: URL) -> LocalPreviewSite? {
        guard url.scheme == Self.scheme, let token = url.host else { return nil }
        return sites[token]
    }

    /// The answer for `url` from `site`. Reads the file and what it names
    /// (LocalPreviewSite.serve), so it's run off the main thread: a page of
    /// many megabytes held the app while it was read for names (Daybreak,
    /// 7 Nov 2026).
    private static func answer(_ url: URL, site: LocalPreviewSite?) -> (response: HTTPURLResponse, data: Data) {
        readHook?()
        guard let site, let served = site.serve(url.path) else {
            let refused = HTTPURLResponse(url: url, statusCode: 404, httpVersion: "HTTP/1.1",
                                          headerFields: ["Content-Type": "text/plain", "Content-Security-Policy": Self.scriptsPolicy])!
            return (refused, Data("Not available to this preview.".utf8))
        }
        let ok = HTTPURLResponse(url: url, statusCode: 200, httpVersion: "HTTP/1.1",
                                 headerFields: ["Content-Type": served.mimeType, "Content-Length": "\(served.data.count)",
                                                "Content-Security-Policy": site.pageDigest == nil ? Self.policy : Self.scriptsPolicy])!
        return (ok, served.data)
    }

    /// For tests: called where each file is read, on the thread it's read on.
    static var readHook: (() -> Void)?

    /// Tasks WebKit has started and not stopped (main thread only): an
    /// answer for one it stopped is dropped, as WebKit throws if a stopped
    /// task is answered.
    private var running = Set<ObjectIdentifier>()
    private static let serving = DispatchQueue(label: "threadbear.preview.serve", qos: .userInitiated, attributes: .concurrent)

    func webView(_ webView: WKWebView, start task: WKURLSchemeTask) {
        guard let url = task.request.url else {
            task.didFailWithError(URLError(.badURL))
            return
        }
        if let token = url.host, let owner = owners[token], owner != ObjectIdentifier(webView) {
            task.didFailWithError(URLError(.noPermissionsToReadFile))
            return
        }
        // The site is looked up here, on the main thread, where `sites`
        // lives; the site itself is safe to use from any thread (its lock).
        let site = site(for: url)
        let key = ObjectIdentifier(task)
        running.insert(key)
        Self.serving.async { [weak self] in
            let (response, data) = Self.answer(url, site: site)
            DispatchQueue.main.async {
                // The task is held by this block until here, so its
                // identifier can't be another task's.
                guard let self, self.running.remove(key) != nil else { return }
                task.didReceive(response)
                task.didReceive(data)
                task.didFinish()
            }
        }
    }

    // An answer still being read is dropped when it's ready.
    func webView(_ webView: WKWebView, stop task: WKURLSchemeTask) {
        running.remove(ObjectIdentifier(task))
    }
}
