import SwiftUI
import ThreadbearKit
import WebKit

/// A ```mermaid or ```html block in a reply, drawn as what it shows: a box
/// like a code block, with the language on the left, a Diagram / Source
/// switch (Preview / Source for a page) and a button that opens it full
/// screen. The Mac draws the same box (Mike picked it, 6 Nov).
///
/// Both are drawn in a web view with no way out (RichWebSandbox): no
/// network, no storage kept, nowhere to navigate. A diagram runs only the
/// app's own script (Pele, bundled), with the source handed over as a
/// string; a page's own scripts never run.
struct RichBlockView: View {
    let kind: MarkdownBlock.RichKind
    let source: String

    @State private var showSource = false
    @State private var expanded = false
    /// No web view until the block has been on screen: the thread view isn't
    /// lazy, so a long thread would otherwise make one per block at once.
    @State private var seen = false
    @State private var height: CGFloat = 160

    /// Taller than this, the inline view is cut off; expanding shows it all.
    static let maxInlineHeight: CGFloat = 420

    var body: some View {
        VStack(spacing: 0) {
            header
            Divider().opacity(0.6)
            if showSource {
                ScrollView(.horizontal, showsIndicators: false) {
                    Text(source).font(.system(.footnote, design: .monospaced)).textSelection(.enabled).padding(10)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            } else if seen {
                RichWebView(kind: kind, source: source, fullScreen: false, height: $height)
                    // A new view for a new kind: scripts are set when it's made.
                    .id(kind)
                    .frame(height: min(height, Self.maxInlineHeight))
                    .overlay(alignment: .bottom) {
                        if height > Self.maxInlineHeight {
                            // Says there's more below, which expanding shows.
                            LinearGradient(colors: [.clear, Color(.secondarySystemBackground)], startPoint: .top, endPoint: .bottom)
                                .frame(height: 36).allowsHitTesting(false)
                        }
                    }
            } else {
                Color.clear.frame(height: height)
            }
        }
        .frame(maxWidth: .infinity)
        .background(Color(.secondarySystemBackground))
        // A page with its own background reaches the box's corners.
        .clipShape(RoundedRectangle(cornerRadius: 8))
        .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(Color.primary.opacity(0.12), lineWidth: 1))
        .onScrollVisibilityChange(threshold: 0.01) { visible in
            if visible { seen = true }
        }
        .fullScreenCover(isPresented: $expanded) {
            RichBlockSheet(kind: kind, source: source)
        }
    }

    private var header: some View {
        HStack(spacing: 10) {
            Text(kind.rawValue).font(.system(.caption, design: .monospaced)).foregroundStyle(.secondary)
            Spacer(minLength: 0)
            Picker("Show", selection: $showSource) {
                Text(kind == .mermaid ? "Diagram" : "Preview").tag(false)
                Text("Source").tag(true)
            }
            .pickerStyle(.segmented)
            .controlSize(.small)
            .fixedSize()
            .accessibilityLabel(kind == .mermaid ? "Show the diagram or its source" : "Show the page or its source")
            Button {
                expanded = true
            } label: {
                Image(systemName: "arrow.up.left.and.arrow.down.right").font(.footnote)
            }
            .buttonStyle(.borderless)
            .foregroundStyle(.secondary)
            .accessibilityLabel(kind == .mermaid ? "Open the diagram full screen" : "Open the page full screen")
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 6)
    }
}

/// The block full screen: pinch to zoom and scroll, with its source a tap away.
private struct RichBlockSheet: View {
    let kind: MarkdownBlock.RichKind
    let source: String
    @State private var showSource = false
    @State private var height: CGFloat = 0
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            Group {
                if showSource {
                    ScrollView([.horizontal, .vertical]) {
                        Text(source).font(.system(.footnote, design: .monospaced)).textSelection(.enabled).padding()
                    }
                } else {
                    RichWebView(kind: kind, source: source, fullScreen: true, height: $height)
                        .id(kind)
                }
            }
            .navigationTitle(kind == .mermaid ? "Diagram" : "Page")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button("Done") { dismiss() }.accessibilityLabel("Close")
                }
                ToolbarItem(placement: .principal) {
                    Picker("Show", selection: $showSource) {
                        Text(kind == .mermaid ? "Diagram" : "Preview").tag(false)
                        Text("Source").tag(true)
                    }
                    .pickerStyle(.segmented)
                    .fixedSize()
                    .accessibilityLabel(kind == .mermaid ? "Show the diagram or its source" : "Show the page or its source")
                }
            }
        }
    }
}

/// The web view under a rich block. Inline it doesn't scroll and reports its
/// content's height (a diagram is scaled to fit under maxInlineHeight; a
/// taller page is cut off there); full screen it scrolls and zooms.
struct RichWebView: UIViewRepresentable {
    let kind: MarkdownBlock.RichKind
    let source: String
    let fullScreen: Bool
    @Binding var height: CGFloat

    func makeCoordinator() -> Coordinator { Coordinator(height: $height) }

    func makeUIView(context: Context) -> WKWebView {
        let view = WKWebView(frame: .zero, configuration: RichWebSandbox.configuration(scripts: kind == .mermaid))
        view.isOpaque = false
        view.backgroundColor = .clear
        view.scrollView.backgroundColor = .clear
        view.scrollView.isScrollEnabled = fullScreen
        view.scrollView.bounces = fullScreen
        view.navigationDelegate = context.coordinator
        view.uiDelegate = context.coordinator
        let coordinator = context.coordinator
        coordinator.kind = kind
        coordinator.source = source
        coordinator.fullScreen = fullScreen
        // Nothing loads until the rule list keeping it off the network is on.
        RichWebSandbox.withRules { rules in
            guard let rules else {
                coordinator.loading = true
                view.loadHTMLString("<p style=\"font:14px -apple-system;color:gray\">This couldn't be shown safely.</p>", baseURL: nil)
                return
            }
            view.configuration.userContentController.add(rules)
            coordinator.ready = true
            coordinator.load(view)
        }
        return view
    }

    /// The same block with new source (a message edited): drawn again, once
    /// the rule list is on (until then the first load takes the new source).
    func updateUIView(_ view: WKWebView, context: Context) {
        let coordinator = context.coordinator
        guard coordinator.source != source else { return }
        coordinator.source = source
        if coordinator.ready { coordinator.load(view) }
    }

    static func dismantleUIView(_ view: WKWebView, coordinator: Coordinator) {
        view.stopLoading()
        view.navigationDelegate = nil
        view.uiDelegate = nil
    }

    @MainActor final class Coordinator: NSObject, WKNavigationDelegate, WKUIDelegate {
        @Binding var height: CGFloat
        var kind: MarkdownBlock.RichKind = .mermaid
        var source = ""
        /// The one navigation allowed: the page loadHTMLString starts.
        var loading = false
        var fullScreen = false
        /// The rule list is on the view, so it may load.
        var ready = false

        func load(_ view: WKWebView) {
            let page = kind == .mermaid ? RichWebSandbox.diagramPage(fullScreen: fullScreen) : RichWebSandbox.htmlPage(source, fullScreen: fullScreen)
            loading = true
            view.loadHTMLString(page, baseURL: nil)
        }

        init(height: Binding<CGFloat>) { _height = height }

        func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction,
                     decisionHandler: @escaping @MainActor (WKNavigationActionPolicy) -> Void) {
            // Only the page itself, once; no link, form, reload or frame
            // goes anywhere, and nothing downloads.
            let isPage = loading && action.targetFrame?.isMainFrame == true && action.request.url?.absoluteString == "about:blank"
                && !action.shouldPerformDownload
            if isPage { loading = false }
            decisionHandler(isPage ? .allow : .cancel)
        }

        func webView(_ webView: WKWebView, decidePolicyFor response: WKNavigationResponse,
                     decisionHandler: @escaping @MainActor (WKNavigationResponsePolicy) -> Void) {
            decisionHandler(response.canShowMIMEType && response.isForMainFrame ? .allow : .cancel)
        }

        /// No new windows.
        func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
                     for action: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? { nil }

        func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
            Task { @MainActor in
                if kind == .mermaid {
                    // The app's own function (RichWebSandbox.drawScript), in
                    // the page's world where Pele is; the source goes in as
                    // an argument, never as markup or code.
                    _ = try? await webView.callAsyncJavaScript("return threadbearDraw(source)", arguments: ["source": source], contentWorld: .page)
                }
                await measure(webView)
                // Pictures in a page (data: only) can land after it has finished.
                try? await Task.sleep(for: .milliseconds(300))
                await measure(webView)
            }
        }

        static let contentHeight = """
        (() => {
          const range = document.createRange();
          range.selectNodeContents(document.body);
          const style = getComputedStyle(document.body);
          return Math.ceil(range.getBoundingClientRect().bottom + window.scrollY + parseFloat(style.paddingBottom || 0) + parseFloat(style.marginBottom || 0));
        })()
        """

        private func measure(_ webView: WKWebView) async {
            // In the app's own world: a page's scripts are off, the app's aren't.
            // How far down the content reaches, not scrollHeight, which is
            // never less than the view's own height and so never let a
            // block get shorter than its first guess.
            let value = try? await webView.evaluateJavaScript(Self.contentHeight, in: nil, contentWorld: .defaultClient)
            if let number = value as? NSNumber, number.doubleValue > 0 { height = CGFloat(number.doubleValue) }
        }
    }
}

/// How rich blocks' web views are locked down, as the Mac's local previews
/// are (WebPanelPool.webView(for:) and LocalPreviewSchemeHandler there).
@MainActor enum RichWebSandbox {
    static func configuration(scripts: Bool) -> WKWebViewConfiguration {
        let config = WKWebViewConfiguration()
        let store = WKWebsiteDataStore.nonPersistent()
        // Any connection WebKit would open goes to a port on this phone that
        // nothing listens on, so no name is looked up and nothing leaves,
        // even before the rule list or the navigation policy get a say.
        store.proxyConfigurations = [ProxyConfiguration(httpCONNECTProxy: .hostPort(host: "127.0.0.1", port: 9))]
        config.websiteDataStore = store
        config.preferences.javaScriptCanOpenWindowsAutomatically = false
        config.allowsInlineMediaPlayback = false
        config.mediaTypesRequiringUserActionForPlayback = .all
        config.dataDetectorTypes = []
        // In every frame, first: a tap on any link (HTML or SVG, in a shadow
        // root too) is cancelled in the page, before WebKit starts the
        // navigation, which is when it would open a connection. Loopback
        // skips the proxy, so the policy below would be too late for a
        // link to a server on this phone (cross-lab review, 6 Nov). User
        // scripts run with the page's scripts off.
        config.userContentController.addUserScript(WKUserScript(source: linkGuard, injectionTime: .atDocumentStart, forMainFrameOnly: false))
        // A page's own scripts never run. A diagram's page runs only Pele and
        // the draw function, which the app put there.
        config.defaultWebpagePreferences.allowsContentJavaScript = scripts
        if scripts, let pele = peleSource {
            config.userContentController.addUserScript(WKUserScript(source: pele, injectionTime: .atDocumentStart, forMainFrameOnly: true))
            config.userContentController.addUserScript(WKUserScript(source: drawScript, injectionTime: .atDocumentStart, forMainFrameOnly: true))
        }
        // WebRTC goes round proxies and content rules alike. WebKit only
        // offers the switch privately; KVC finds `_setPeerConnectionEnabled:`.
        if config.preferences.responds(to: NSSelectorFromString("_setPeerConnectionEnabled:")) {
            config.preferences.setValue(false, forKey: "peerConnectionEnabled")
        }
        return config
    }

    static let linkGuard = """
    (() => {
      addEventListener('click', (e) => {
        for (const node of e.composedPath()) {
          const name = (node && node.localName || '').toLowerCase();
          if (name === 'a' || name === 'area') { e.preventDefault(); return; }
        }
        // A link inside a closed shadow root isn't in the path: the click
        // is retargeted to its host. An element that can host one has no
        // default action of its own, so cancelling it costs nothing.
        const at = e.target && e.target.localName || '';
        if (at.includes('-') || ['article','aside','blockquote','body','div','footer','h1','h2','h3','h4','h5','h6','header','main','nav','p','section','span'].includes(at)) e.preventDefault();
      }, true);
      addEventListener('submit', (e) => e.preventDefault(), true);
    })();
    """

    /// Pele, read once from the app, for every diagram after.
    static let peleSource: String? = {
        let url = Bundle.main.url(forResource: "pele", withExtension: "js")
            ?? Bundle.main.url(forResource: "pele", withExtension: "js", subdirectory: "Rich")
        return url.flatMap { try? String(contentsOf: $0, encoding: .utf8) }
    }()

    /// Every load blocked but the page itself and data: pictures in it.
    static let ruleList = """
    [{"trigger":{"url-filter":".*"},"action":{"type":"block"}},
     {"trigger":{"url-filter":"^about:"},"action":{"type":"ignore-previous-rules"}},
     {"trigger":{"url-filter":"^data:"},"action":{"type":"ignore-previous-rules"}}]
    """

    private static var rules: WKContentRuleList?
    private static var waiting: [(WKContentRuleList?) -> Void]?

    static func withRules(_ use: @escaping (WKContentRuleList?) -> Void) {
        if let rules { return use(rules) }
        if waiting != nil { waiting?.append(use); return }
        waiting = [use]
        WKContentRuleListStore.default().compileContentRuleList(forIdentifier: "threadbear-rich-block", encodedContentRuleList: ruleList) { list, _ in
            MainActor.assumeIsolated {
                rules = list
                let all = waiting ?? []
                waiting = nil
                all.forEach { $0(list) }
            }
        }
    }

    /// Nothing but inline styles and data: pictures, whatever the markup
    /// asks for. A page can add its own policy, which only narrows this.
    static let policy = "default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; form-action 'none'; base-uri 'none'"

    private static func head(fullScreen: Bool) -> String {
        let zoom = fullScreen ? "maximum-scale=5, user-scalable=yes" : "maximum-scale=1, user-scalable=no"
        return """
        <meta http-equiv="Content-Security-Policy" content="\(policy)">
        <meta name="viewport" content="width=device-width, initial-scale=1, \(zoom)">
        """
    }

    /// A page from an ```html block: the agent's markup after the app's
    /// policy and viewport, which the parser puts in the head.
    static func htmlPage(_ source: String, fullScreen: Bool) -> String {
        // The doctype first, so it isn't drawn in quirks mode whatever the
        // agent wrote (theirs comes too late to count).
        "<!doctype html>\n" + head(fullScreen: fullScreen) + "<style>html,body{margin:0;padding:0;background:transparent;-webkit-text-size-adjust:100%}</style>\n" + source
    }

    /// The page a diagram is drawn into, themed with Pele's CSS variables to
    /// the phone's greys, light or dark with the system.
    static func diagramPage(fullScreen: Bool) -> String {
        """
        <!doctype html><html><head>\(head(fullScreen: fullScreen))
        <style>
        html,body{margin:0;padding:0;background:transparent;font:14px -apple-system,system-ui}
        #d{padding:14px;display:flex;justify-content:center}
        #d svg{max-width:100%;height:auto\(fullScreen ? "" : ";max-height:\(Int(RichBlockView.maxInlineHeight) - 28)px")}
        #d.err{display:block;color:#d0453a;font:13px ui-monospace,Menlo,monospace;white-space:pre-wrap}
        .pele{--pele-bg:#f2f2f7;--pele-fg:#1d1d1f;--pele-muted:#6e6e73;--pele-line:#86868b;--pele-surface:#ffffff;
          --pele-surface-alt:#f0f0f2;--pele-border:#c7c7cc;--pele-accent:#007aff;--pele-radius:6px}
        @media (prefers-color-scheme: dark){
          .pele{--pele-bg:#1c1c1e;--pele-fg:#ececec;--pele-muted:#9a9a9a;--pele-line:#8e8e93;--pele-surface:#333335;
            --pele-surface-alt:#3a3a3c;--pele-border:#5a5a5e;--pele-accent:#0a84ff}
          #d.err{color:#ff6961}
        }
        </style></head><body><div id="d"></div></body></html>
        """
    }

    /// Draws a diagram's source with Pele: no links, no pictures, so the
    /// SVG names nothing outside itself. A diagram Pele can't read shows
    /// its message as text.
    static let drawScript = """
    window.threadbearDraw = function (source) {
      const box = document.getElementById('d');
      try {
        box.className = '';
        box.innerHTML = pele.render(String(source), { links: false, images: false, fontFamily: '-apple-system, system-ui', fontSize: 14, idPrefix: 'd' }).svg;
      } catch (error) {
        box.className = 'err';
        box.textContent = "This diagram couldn't be drawn: " + (error && error.message ? error.message : String(error));
      }
      return true;
    };
    """
}
