import Network
import WebKit

/// The lockdown every web view showing something an agent wrote gets: a
/// local mockup in the side pane (WebPanelPool) and the transcript's
/// ```html and ```mermaid boxes (RichRenderer). Moved here from
/// WebPanelPool so both get the same one; see LocalPreviewSchemeHandler
/// for what each part stops (Daybreak finding 6 and its verify-fix).
@MainActor
enum PreviewSandbox {
    /// A store of its own that isn't saved, every connection sent to a
    /// proxy that isn't there, no windows, no WebRTC, and the link guard
    /// in every frame. `pageScripts` false turns the page's own scripts
    /// off; the app's scripts (the link guard, a measurement) still run.
    static func lockDown(_ config: WKWebViewConfiguration, proxy: NWEndpoint, pageScripts: Bool) {
        let store = WKWebsiteDataStore.nonPersistent()
        // Every connection the store would make goes to a proxy on this
        // Mac that isn't there. The rule list and the navigation policy
        // stop loads, but WebKit opens a connection for a clicked link
        // (and looks its host up) before asking; through the proxy, no
        // name is looked up and nothing leaves (the egress test caught it).
        store.proxyConfigurations = [ProxyConfiguration(httpCONNECTProxy: proxy)]
        // Loopback skips any proxy, so a click on a link away from the
        // preview is stopped in the page, before WebKit would connect.
        config.userContentController.addUserScript(WKUserScript(
            source: LocalPreviewSchemeHandler.linkGuard, injectionTime: .atDocumentStart, forMainFrameOnly: false))
        config.websiteDataStore = store
        config.preferences.javaScriptCanOpenWindowsAutomatically = false
        // A local preview is static: the page's own scripts never run.
        // Whatever its markup names it can show, but no script can read
        // those bytes back (verify-fix: `<a href="private.png">` let a
        // page's script fetch the file).
        config.defaultWebpagePreferences.allowsContentJavaScript = pageScripts
        // WebRTC goes round proxies and content rules alike. WebKit only
        // offers the switch privately; KVC finds `_setPeerConnectionEnabled:`.
        if config.preferences.responds(to: NSSelectorFromString("_setPeerConnectionEnabled:")) {
            config.preferences.setValue(false, forKey: "peerConnectionEnabled")
        }
    }

    /// The content rule list that keeps a preview off the network (all
    /// but the preview scheme blocked), compiled once (WebKit keeps it in
    /// its own store for next time). Nil if it couldn't be: then show
    /// nothing.
    private static var compiledRules: WKContentRuleList?
    private static var waiting: [(WKContentRuleList?) -> Void]?

    static func withRules(_ use: @escaping (WKContentRuleList?) -> Void) {
        if let compiledRules { return use(compiledRules) }
        if waiting != nil { waiting?.append(use); return }
        waiting = [use]
        WKContentRuleListStore.default().compileContentRuleList(
            forIdentifier: "threadbear-local-preview", encodedContentRuleList: LocalPreviewSchemeHandler.ruleList
        ) { compiled, _ in
            MainActor.assumeIsolated {
                compiledRules = compiled
                let all = waiting ?? []
                waiting = nil
                all.forEach { $0(compiled) }
            }
        }
    }

    static func rules() async -> WKContentRuleList? {
        await withCheckedContinuation { continuation in withRules { continuation.resume(returning: $0) } }
    }
}
