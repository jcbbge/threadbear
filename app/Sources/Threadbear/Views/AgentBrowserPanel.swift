import AppKit
import QuartzCore
import SwiftUI
import ThreadbearCore

/// A thread's pages in real Chrome. Existing profiles use BrowserBear's
/// private socket for frames and input, keeping their original sign-ins.
/// The separate agent Chrome remains available through its debugging port.
enum AgentBrowser {
    static let panelId = "threadbear.browser"

    /// BrowserBear's folder.
    static var home: String {
        ProcessInfo.processInfo.environment["BROWSERBEAR_HOME"]
            ?? (NSHomeDirectory() as NSString).appendingPathComponent("Library/Application Support/BrowserBear")
    }
}

struct AgentTab: Decodable, Identifiable, Equatable {
    var tabId: Int
    var targetId: String?
    var bridge: Bool?
    var profile: String?
    var profileName: String?
    var profileEmail: String?
    var inChrome: Bool?
    var suspended: Bool?
    var requiresConsent: Bool?
    var profileTitle: String {
        [profileName, profileEmail].compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: " · ")
    }
    var url: String
    var title: String
    var thread: String?
    /// working, yours or idle (service/marks.mjs); nil when unmarked.
    var state: String?
    var action: String?
    /// The agent is waiting on `handoff --wait`, so Done means something.
    var finish: Bool?
    var status: String?
    /// Goes up each time the agent hands this tab to Mike.
    var handoffs: Int?
    var handoffAt: Double?
    var popup: Bool?
    var openedAt: Double?
    /// The agent's Chrome has a window of its own up over this page (a
    /// passkey, a permission), which the panel's picture can't show.
    var sheet: AgentSheet?
    var id: String { "\(profile ?? "agent-chrome")/\(tabId)" }
}

/// BrowserBear's agent host (agent/sheets.mjs) sets this while one of
/// Chrome's own windows is up over a page.
struct AgentSheet: Decodable, Equatable {
    /// The host brought the page's window onto the screen with it.
    var moved: Bool?
    var since: Double?
}

struct BrowserProfile: Decodable, Identifiable, Equatable {
    var id: String
    var name: String?
    var email: String?
    var panelPopups: Bool?
    var title: String {
        let title = [name, email].compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: " · ")
        return title.isEmpty ? "Chrome profile \(id.prefix(8))" : title
    }
}

/// A new handoff picks its tab once. Reopening a panel keeps any choice the
/// user made afterwards, including after switching to another thread and back.
struct AgentBrowserChoice {
    var id: String?
    private var seen: [String: Int] = [:]
    mutating func updateHandoff(_ tabs: [AgentTab]) {
        let pending = tabs.filter { $0.state == "yours" && ($0.handoffs ?? 0) > (seen[$0.id] ?? 0) }
        if let latest = pending.max(by: { ($0.handoffAt ?? 0) < ($1.handoffAt ?? 0) }) { id = latest.id }
        for tab in pending { seen[tab.id] = tab.handoffs ?? 0 }
    }
}

private struct BrowserPanelState: Decodable {
    var profiles: [BrowserProfile]
    var tabs: [AgentTab]
}

private struct AgentState: Decodable, Equatable {
    var port: Int
    var socket: String
    var chromePid: pid_t?
    var tabs: [AgentTab]
}

/// Reads the host's tabs.json. A second's lag is fine: it's for which tabs a
/// thread has and what the agent's doing, and the picture comes over the port.
@MainActor
final class AgentBrowserModel: ObservableObject {
    static let shared = AgentBrowserModel()

    @Published private(set) var tabs: [AgentTab] = []
    @Published private(set) var port = 0
    @Published private(set) var profiles: [BrowserProfile] = []
    @Published private(set) var error: String?
    /// Requests whose buttons are waiting for BrowserBear's answer, by
    /// `pendingKey`. It can take a while, as Chrome has to do the thing.
    @Published private(set) var pending: Set<String> = []
    /// The request each key is waiting on, so an old request's timeout
    /// can't clear a newer one's spinner.
    private var pendingRequests: [String: UUID] = [:]
    private var agentTabs: [AgentTab] = []
    private var profileTabs: [AgentTab] = []
    private var pipe: BrowserBearPipe?
    private var polling = false
    private var requestError: String?
    private var timer: Timer?
    private var last: Data?
    private var choices: [String: AgentBrowserChoice] = [:]

    private var chromePid: pid_t?
    /// The app Mike was in, for when Chrome takes the focus.
    private var lastApp: NSRunningApplication?
    /// Mike asked for Chrome's own window, so it's meant to come forward.
    var realWindowShown = false

    private init() {
        // A page's window.open brings its Chrome forward, however parked the
        // window is (5 Nov), and Chrome has no switch against it, so the focus
        // goes straight back to wherever Mike was.
        NSWorkspace.shared.notificationCenter.addObserver(forName: NSWorkspace.didActivateApplicationNotification, object: nil, queue: .main) { [weak self] note in
            let app = note.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication
            MainActor.assumeIsolated { self?.activated(app) }
        }
        read()
        timer = .scheduledTimer(withTimeInterval: 0.75, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated { self?.read() }
        }
    }

    private func activated(_ app: NSRunningApplication?) {
        guard let app else { return }
        guard let chromePid, app.processIdentifier == chromePid else {
            lastApp = app
            return
        }
        // A passkey or permission sheet needs Chrome in front to take a
        // click or Touch ID, so it keeps the focus while one is up.
        if !realWindowShown && !agentTabs.contains(where: { $0.sheet != nil }) { lastApp?.activate() }
    }

    /// Brings the agent's Chrome forward, with whatever sheet it has up.
    func showChromeSheet() {
        guard let chromePid else { return }
        NSRunningApplication(processIdentifier: chromePid)?.activate()
    }

    private func read() {
        pollProfiles()
        let path = (AgentBrowser.home as NSString).appendingPathComponent("agent/tabs.json")
        guard let data = FileManager.default.contents(atPath: path), data != last else { return }
        last = data
        guard let state = try? JSONDecoder().decode(AgentState.self, from: data) else { return }
        let hadSheet = agentTabs.contains { $0.sheet != nil }
        agentTabs = state.tabs
        // The sheet's done and its window's parked again, but Chrome kept the
        // focus it took for it: give it back, as for any other activation.
        if hadSheet, !agentTabs.contains(where: { $0.sheet != nil }), !realWindowShown,
           let pid = state.chromePid, NSWorkspace.shared.frontmostApplication?.processIdentifier == pid {
            lastApp?.activate()
        }
        mergeTabs()
        port = state.port
        chromePid = state.chromePid
    }

    func tabs(for threadId: String) -> [AgentTab] { tabs.filter { $0.thread == threadId } }

    func selectedTab(for thread: String, in tabs: [AgentTab]) -> String? {
        var choice = choices[thread] ?? AgentBrowserChoice()
        choice.updateHandoff(tabs)
        choices[thread] = choice
        return choice.id
    }

    func select(_ id: String?, in thread: String) {
        var choice = choices[thread] ?? AgentBrowserChoice()
        choice.id = id
        choices[thread] = choice
    }

    var available: Bool { port != 0 || FileManager.default.fileExists(atPath: BrowserBear.socket) }

    private func mergeTabs() {
        let joined = Dictionary(agentTabs.map { ($0.id, $0) }, uniquingKeysWith: { _, new in new })
        tabs = Array(profileTabs.reduce(into: joined) { $0[$1.id] = $1 }.values).sorted { $0.tabId < $1.tabId }
    }

    private func pollProfiles() {
        guard !polling, FileManager.default.fileExists(atPath: BrowserBear.socket) else { return }
        if pipe == nil {
            let connection = BrowserBearPipe()
            connection.onRequestError = { [weak self] message in
                DispatchQueue.main.async { self?.polling = false; self?.error = message }
            }
            connection.onError = { [weak self, weak connection] message in
                DispatchQueue.main.async {
                    guard let self, self.pipe === connection else { return }
                    self.error = message
                    self.polling = false
                    connection?.close()
                    self.pipe = nil
                    self.profiles = []
                    self.profileTabs = []
                    self.mergeTabs()
                }
            }
            pipe = connection
        }
        polling = true
        pipe?.request("panelState", reply: { [weak self] result in
            guard result["_error"] == nil else { return }
            let data = try? JSONSerialization.data(withJSONObject: result)
            let state = data.flatMap { try? JSONDecoder().decode(BrowserPanelState.self, from: $0) }
            DispatchQueue.main.async {
                guard let self else { return }
                self.polling = false
                guard let state else { self.error = "BrowserBear sent an unreadable list of pages."; return }
                self.error = self.requestError
                self.profiles = state.profiles
                self.profileTabs = state.tabs.filter { $0.bridge == true }
                self.mergeTabs()
            }
        })
    }

    static func pendingKey(_ cmd: String, _ tab: AgentTab) -> String { "\(cmd)/\(tab.tabId)" }
    static let openingKey = "open"

    /// `key` is what a button watches, in `pending`, until the answer comes.
    private func action(_ cmd: String, _ args: [String: Any], thread: String? = nil, key: String? = nil, then: (() -> Void)? = nil) {
        requestError = nil
        error = nil
        guard let pipe else { return }
        let request = UUID()
        if let key {
            pending.insert(key)
            pendingRequests[key] = request
            // A connection that drops takes its answers with it, and the pipe
            // gives up on any by 45 seconds, so the button comes back by then.
            DispatchQueue.main.asyncAfter(deadline: .now() + 46) { [weak self] in self?.answered(key, request) }
        }
        pipe.request(cmd, args, thread: thread, failure: { [weak self] message in
            DispatchQueue.main.async {
                self?.requestError = message
                self?.error = message
                if let key { self?.answered(key, request) }
            }
        }, reply: { [weak self] result in
            let failed = result["_error"] != nil
            DispatchQueue.main.async {
                if let key { self?.answered(key, request) }
                if !failed { then?() }
            }
        })
    }

    private func answered(_ key: String, _ request: UUID) {
        guard pendingRequests[key] == request else { return }
        pendingRequests[key] = nil
        pending.remove(key)
    }

    func done(_ tab: AgentTab) { action("markDone", ["tab": tab.tabId], key: Self.pendingKey("markDone", tab)) }

    func resume(_ tab: AgentTab, thread: String, then: (() -> Void)? = nil) {
        action("panelResume", ["tab": tab.tabId, "profile": tab.profile ?? "agent-chrome"], thread: thread, key: Self.pendingKey("panelResume", tab), then: then)
    }

    func showInChrome(_ tab: AgentTab, thread: String) {
        action("panelShowChrome", ["tab": tab.tabId, "profile": tab.profile ?? "agent-chrome"], thread: thread)
    }

    /// The profile is an exact connected identity, never a partial display name.
    func open(_ url: String, thread: String, profile: String) {
        action("open", ["profile": profile, "url": url], thread: thread, key: Self.openingKey)
    }

}

// MARK: - The panel

struct AgentBrowserPanel: View {
    let thread: ThreadSummary
    @ObservedObject private var model = AgentBrowserModel.shared
    @State private var chosen: String?
    @State private var address = ""
    @StateObject private var surface = AgentSurfaceHandle()
    @FocusState private var addressFocused: Bool
    /// The profile an address typed with no page open goes to. Picking a
    /// profile from the menu makes it the default, starred there.
    @AppStorage("browserPanelProfile") private var defaultProfile = ""

    private var tabs: [AgentTab] { model.tabs(for: thread.id) }

    /// The one picked, else the newest: a sign-in popup comes up by itself,
    /// and goes when it closes.
    private var tab: AgentTab? {
        tabs.first { $0.id == chosen } ?? tabs.max { ($0.openedAt ?? Double($0.tabId)) < ($1.openedAt ?? Double($1.tabId)) }
    }

    var body: some View {
        VStack(spacing: 0) {
            toolbar
            // Only when there's a profile to choose: with BrowserBear agent-only
            // (Mike's trial) or no profiles connected, an empty "Choose Chrome
            // profile" menu just looked like a setup step.
            if !model.profiles.isEmpty { profilePicker }
            if let tab, tab.bridge == true, model.profiles.first(where: { $0.id == tab.profile })?.panelPopups != true {
                Text("New windows open in Chrome.").font(.system(size: TypeScale.label)).foregroundStyle(.secondary).padding(.bottom, zoomed(4))
            }
            if tabs.count > 1 { tabStrip }
            if let tab, tab.state == "yours" { yourTurn(tab) }
            if let tab, let sheet = tab.sheet { chromeSheet(sheet) }
            if let tab, tab.inChrome == true || tab.suspended == true || tab.requiresConsent == true {
                VStack(spacing: zoomed(10)) {
                    PaneNote(text: tab.inChrome == true ? "This page is open in Chrome's window." : "This Chrome tab is not connected to the panel.")
                    Button(tab.requiresConsent == true ? "Show this tab here" : tab.inChrome == true ? "Return to panel" : "Reconnect") {
                        surface.error = nil
                        surface.connected = false
                        model.resume(tab, thread: thread.id)
                    }
                    .busy(model.pending.contains(AgentBrowserModel.pendingKey("panelResume", tab)))
                    .tip("Display this tab here using its existing Chrome sign-in")
                }
            } else if let tab, tab.bridge == true || model.port != 0 {
                AgentSurface(port: model.port, tab: tab, thread: thread.id, handle: surface)
                    .id("\(tab.id)-\(surface.retry)")
                    .overlay {
                        if let error = surface.error {
                            VStack(spacing: zoomed(8)) {
                                Text(error).font(.system(size: TypeScale.label)).multilineTextAlignment(.center)
                                Button("Reconnect") {
                                    surface.error = nil
                                    surface.connected = false
                                    if tab.bridge == true { model.resume(tab, thread: thread.id) { surface.retry += 1 } }
                                    else { surface.retry += 1 }
                                }
                                    .tip("Reconnect this page to BrowserBear")
                            }
                            .padding().background(.regularMaterial, in: RoundedRectangle(cornerRadius: zoomed(8)))
                            .padding()
                        } else if !surface.connected {
                            ProgressView("Connecting to Chrome…").padding().background(.regularMaterial, in: RoundedRectangle(cornerRadius: zoomed(8)))
                        }
                    }
            } else {
                PaneNote(text: model.error ?? (model.profiles.isEmpty ? "Connect BrowserBear in a Chrome profile to use its pages here." : "Type an address, or choose a Chrome profile, to open a page with its existing sign-ins."))
            }
            if let tab, tab.state == "working", let action = tab.action { working(action) }
            if tab != nil, let error = model.error { Text(error).font(.system(size: TypeScale.label)).foregroundStyle(.secondary).padding(zoomed(6)) }
        }
        .onChange(of: tab?.url) { _, url in
            if !addressFocused { address = url.map(Self.shown) ?? "" }
        }
        .onAppear {
            chooseHandoff()
            address = tab.map { Self.shown($0.url) } ?? ""
        }
        .onChange(of: tabs.filter { $0.state == "yours" }.map { "\($0.id):\($0.handoffs ?? 0)" }) { _, _ in chooseHandoff() }
        .onChange(of: tab?.id) { _, _ in surface.error = nil; surface.connected = false }
        .onChange(of: tabs.map(\.id)) { old, new in
            let added = Set(new).subtracting(old)
            if let newest = tabs.filter({ added.contains($0.id) }).max(by: { ($0.openedAt ?? 0) < ($1.openedAt ?? 0) }) {
                chosen = newest.id
                model.select(chosen, in: thread.id)
            }
        }
    }

    private func chooseHandoff() {
        chosen = model.selectedTab(for: thread.id, in: tabs)
    }

    private static func shown(_ url: String) -> String { url == "about:blank" ? "" : url }

    /// The default profile, else the first connected one.
    private var newPageProfile: BrowserProfile? {
        model.profiles.first { $0.id == defaultProfile } ?? model.profiles.first
    }

    /// Where an address typed with no page goes: the chosen profile, else the
    /// agent's own Chrome when none of the user's profiles is offered.
    private var newPageProfileID: String? {
        newPageProfile?.id ?? (model.profiles.isEmpty && model.available ? "agent" : nil)
    }

    /// The panel's page can take an address itself; otherwise one typed opens
    /// a new page (no page yet, one that's in Chrome's window, waiting for
    /// Show this tab here, or disconnected).
    private var pageTakesAddress: Bool {
        guard let tab else { return false }
        return tab.inChrome != true && tab.requiresConsent != true && tab.suspended != true && surface.error == nil
    }

    private var toolbar: some View {
        HStack(spacing: zoomed(2)) {
            PaneHeaderButton(symbol: "chevron.left", help: "Back") { surface.evaluate("history.back()") }
            PaneHeaderButton(symbol: "chevron.right", help: "Forward") { surface.evaluate("history.forward()") }
            PaneHeaderButton(symbol: "arrow.clockwise", help: "Reload") { surface.send("Page.reload") }
            TextField("Address", text: $address)
                .disabled(!pageTakesAddress && tab?.profile == nil && newPageProfileID == nil)
                .textFieldStyle(.plain)
                .font(.system(size: TypeScale.label))
                .focused($addressFocused)
                .padding(.horizontal, zoomed(8))
                .padding(.vertical, zoomed(4))
                .background(SidebarMetrics.hover, in: RoundedRectangle(cornerRadius: zoomed(6)))
                .onSubmit(go)
            PaneHeaderButton(symbol: "macwindow", help: "Show Chrome's own window, for a passkey or a password manager's popup") {
                if let tab, tab.inChrome == true { surface.connected = false; model.resume(tab, thread: thread.id) }
                else if let tab, tab.suspended == true || tab.requiresConsent == true || surface.error != nil { model.showInChrome(tab, thread: thread.id) }
                else { surface.showRealWindow() }
            }
        }
        .padding(.horizontal, zoomed(6))
        .padding(.vertical, zoomed(4))
    }

    private func go() {
        var text = address.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return }
        if !text.contains("://") { text = (text.contains(".") && !text.contains(" ") ? "https://" : "https://www.google.com/search?q=") + text }
        if pageTakesAddress { surface.send("Page.navigate", ["url": text]) }
        else if let profile = tab?.profile ?? newPageProfileID {
            chosen = nil
            model.select(nil, in: thread.id)
            model.open(text, thread: thread.id, profile: profile)
        }
        addressFocused = false
    }

    private var profilePicker: some View {
        HStack {
            IconMenu {
                ForEach(model.profiles) { profile in
                    Button("New page in \(profile.title)", systemImage: profile.id == newPageProfile?.id ? "star.fill" : "person.crop.circle") {
                        defaultProfile = profile.id
                        chosen = nil
                        model.select(nil, in: thread.id)
                        model.open("about:blank", thread: thread.id, profile: profile.id)
                    }
                    .tip(profile.id == newPageProfile?.id ? "Open a new page in \(profile.title), the default for addresses typed with no page open" : "Open a new page in \(profile.title) and make it the default")
                }
            } label: {
                Label(tab.map { $0.profileTitle.isEmpty ? ($0.bridge == true ? "Chrome profile" : "Separate agent Chrome") : $0.profileTitle } ?? "Choose Chrome profile", systemImage: "person.crop.circle")
                    .font(.system(size: TypeScale.label)).lineLimit(1)
            }
            .menuStyle(.borderlessButton)
            .fixedSize(horizontal: false, vertical: true)
            .disabled(model.pending.contains(AgentBrowserModel.openingKey))
            .tip("Open a page in a Chrome profile using its existing sign-ins")
            if model.pending.contains(AgentBrowserModel.openingKey) {
                SpinnerMark(color: .secondaryLabelColor).frame(width: zoomed(11), height: zoomed(11))
            }
            Spacer(minLength: 0)
        }
        .padding(.horizontal, zoomed(10))
        .padding(.bottom, zoomed(4))
    }

    private var tabStrip: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: zoomed(2)) {
                ForEach(tabs) { item in
                    Button { chosen = item.id; model.select(item.id, in: thread.id) } label: {
                        Text(item.title.isEmpty ? item.url : item.title)
                            .font(.system(size: TypeScale.label))
                            .lineLimit(1)
                            .frame(maxWidth: zoomed(160))
                            .padding(.horizontal, zoomed(8))
                            .padding(.vertical, zoomed(3))
                            .background(item.id == tab?.id ? SidebarMetrics.hover : .clear, in: RoundedRectangle(cornerRadius: zoomed(5)))
                    }
                    .buttonStyle(.plain)
                    .tip(item.url)
                }
            }
            .padding(.horizontal, zoomed(6))
        }
        .padding(.bottom, zoomed(4))
    }

    private func yourTurn(_ tab: AgentTab) -> some View {
        HStack(spacing: zoomed(8)) {
            Circle().fill(.orange).frame(width: zoomed(7), height: zoomed(7))
            Text("Your turn").font(.system(size: TypeScale.label, weight: .medium))
            Spacer()
            Button("Done") { model.done(tab) }
                .controlSize(.small)
                .busy(model.pending.contains(AgentBrowserModel.pendingKey("markDone", tab)))
                .tip("Tell the agent you've finished here")
        }
        .padding(.horizontal, zoomed(10))
        .padding(.vertical, zoomed(5))
    }

    /// Chrome's own window over the page, which the picture here can't show.
    private func chromeSheet(_ sheet: AgentSheet) -> some View {
        HStack(spacing: zoomed(8)) {
            Image(systemName: "macwindow").font(.system(size: TypeScale.label)).foregroundStyle(.orange)
            Text(sheet.moved == true ? "Chrome is asking for something in its own window, like a passkey. It's in the middle of your screen." : "Chrome is asking for something in its own window, like a passkey.")
                .font(.system(size: TypeScale.label))
                .fixedSize(horizontal: false, vertical: true)
            Spacer(minLength: 0)
            Button("Show it") { model.showChromeSheet() }
                .controlSize(.small)
                .tip("Bring Chrome's window to the front")
        }
        .padding(.horizontal, zoomed(10))
        .padding(.vertical, zoomed(5))
    }

    private func working(_ action: String) -> some View {
        HStack(spacing: zoomed(6)) {
            Circle().fill(.green).frame(width: zoomed(6), height: zoomed(6))
            Text(action).font(.system(size: TypeScale.label)).foregroundStyle(.secondary).lineLimit(1)
            Spacer()
        }
        .padding(.horizontal, zoomed(10))
        .padding(.vertical, zoomed(4))
    }
}

/// Lets the toolbar reach whichever view is showing the page.
@MainActor
final class AgentSurfaceHandle: ObservableObject {
    @Published var error: String?
    @Published var retry = 0
    @Published var connected = false
    weak var view: AgentSurfaceView?
    func send(_ method: String, _ params: [String: Any] = [:]) { view?.stream?.send(method, params) }
    func evaluate(_ js: String) { send("Runtime.evaluate", ["expression": js, "userGesture": true]) }
    func showRealWindow() { view?.showRealWindow() }
}

struct AgentSurface: NSViewRepresentable {
    let port: Int
    let tab: AgentTab
    let thread: String
    let handle: AgentSurfaceHandle

    func makeNSView(context: Context) -> AgentSurfaceView {
        let view = AgentSurfaceView(port: port, tab: tab, thread: thread)
        view.onError = { [weak handle, weak view] message in
            guard let handle, handle.view === view else { return }
            handle.error = message
        }
        view.onConnected = { [weak handle, weak view] in
            guard let handle, handle.view === view else { return }
            handle.connected = true
        }
        handle.view = view
        return view
    }

    func updateNSView(_ view: AgentSurfaceView, context: Context) { handle.view = view }
}

// MARK: - The connection to the page

/// One page's debugging connection: frames in, commands out. Everything but
/// `send` runs on the socket's own queue, so a busy main thread doesn't hold up
/// the picture.
final class AgentStream: NSObject, URLSessionWebSocketDelegate, @unchecked Sendable {
    private var task: URLSessionWebSocketTask?
    private var session: URLSession?
    private var pipe: BrowserBearPipe?
    private var thread = ""
    private var dialogOpen = false
    private var frames = 0
    var receivedFrames: Int { lock.lock(); defer { lock.unlock() }; return frames }
    var onFirstFrame: (() -> Void)?
    private let lock = NSLock()
    private var nextId = 1
    private var waiting: [Int: ([String: Any]) -> Void] = [:]
    private var moving = false
    private var nextMove: [String: Any]?
    private var ended = false
    private var isEnded: Bool { lock.lock(); defer { lock.unlock() }; return ended }
    /// The decoded picture, off the main thread.
    var onFrame: ((CGImage) -> Void)?
    /// A page's alert, confirm or prompt: nothing in the page moves until it's answered.
    var onDialog: (([String: Any]) -> Void)?
    /// The agent answered it first, or the page went.
    var onDialogClosed: (() -> Void)?
    var onError: ((String) -> Void)?

    init(port: Int, targetId: String, bridgeTab: Int? = nil, profile: String? = nil, thread: String = "") {
        super.init()
        self.thread = thread
        if let bridgeTab {
            let pipe = BrowserBearPipe()
            self.pipe = pipe
            pipe.onEvent = { [weak self] in self?.handleMessage($0) }
            pipe.onError = { [weak self] in self?.fail($0) }
            pipe.onRequestError = { [weak self] in self?.fail($0) }
            var args: [String: Any] = ["tab": bridgeTab]
            if let profile { args["profile"] = profile }
            pipe.request("panelAttach", args, thread: thread, failure: { [weak self] in self?.fail($0) })
            return
        }
        let queue = OperationQueue()
        queue.maxConcurrentOperationCount = 1
        queue.qualityOfService = .userInteractive
        let session = URLSession(configuration: .ephemeral, delegate: self, delegateQueue: queue)
        self.session = session
        let task = session.webSocketTask(with: URL(string: "ws://127.0.0.1:\(port)/devtools/page/\(targetId)")!)
        task.maximumMessageSize = 64 * 1024 * 1024
        self.task = task
        task.resume()
        receive()
    }

    func close() {
        lock.lock()
        ended = true
        waiting.removeAll()
        nextMove = nil
        lock.unlock()
        pipe?.close()
        task?.cancel(with: .goingAway, reason: nil)
        session?.invalidateAndCancel()
    }

    func send(_ method: String, _ params: [String: Any] = [:], reply: (([String: Any]) -> Void)? = nil) {
        guard !isEnded else { return }
        if method == "Input.dispatchMouseEvent", ["mousePressed", "mouseReleased"].contains(params["type"] as? String ?? "") {
            lock.lock()
            nextMove = nil
            lock.unlock()
        }
        if method == "Input.dispatchMouseEvent", params["type"] as? String == "mouseMoved", reply == nil {
            move(params)
            return
        }
        sendRaw(method, params, reply: reply)
    }

    /// Pointer motion can arrive much faster than frames. Keep the latest
    /// position rather than replaying old moves after a busy page recovers.
    private func move(_ params: [String: Any]) {
        lock.lock()
        if moving { nextMove = params; lock.unlock(); return }
        moving = true
        lock.unlock()
        sendRaw("Input.dispatchMouseEvent", params) { [weak self] _ in
            guard let self else { return }
            self.lock.lock()
            self.moving = false
            let next = self.nextMove
            self.nextMove = nil
            self.lock.unlock()
            if let next { self.move(next) }
        }
    }

    private func sendRaw(_ method: String, _ params: [String: Any], reply: (([String: Any]) -> Void)? = nil) {
        guard !isEnded else { return }
        if let pipe {
            pipe.request("panelCdp", ["method": method, "params": params], thread: thread, failure: { [weak self] message in
                guard let self, !self.isEnded, (!self.dialogOpen || method == "Page.handleJavaScriptDialog"), method != "Runtime.evaluate" else { return }
                // A slow input or navigation may already have landed. Keep the
                // picture alive so the user can see its result and continue.
                let timedOut = message.localizedCaseInsensitiveContains("timed out") || message.contains("didn't answer in time")
                if (method.hasPrefix("Input.") || method == "Page.navigate" || method == "Page.reload"), timedOut { return }
                self.fail(message)
            }, reply: reply)
            return
        }
        lock.lock()
        let id = nextId
        nextId += 1
        if let reply { waiting[id] = reply }
        lock.unlock()
        guard let data = try? JSONSerialization.data(withJSONObject: ["id": id, "method": method, "params": params]),
              let text = String(data: data, encoding: .utf8) else { return }
        task?.send(.string(text)) { _ in }
    }

    func showWindow(_ shown: Bool, reply: @escaping () -> Void) {
        pipe?.request("panelWindow", ["shown": shown], thread: thread, reply: { _ in reply() })
    }

    private func receive() {
        task?.receive { [weak self] result in
            guard let self, case .success(let message) = result else { return }
            if case .string(let text) = message { self.handle(text) }
            self.receive()
        }
    }

    private func handle(_ text: String) {
        guard let data = text.data(using: .utf8),
              let m = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return }
        handleMessage(m)
    }

    private func handleMessage(_ m: [String: Any]) {
        guard !isEnded else { return }
        if m["method"] as? String == "panelError", let params = m["params"] as? [String: Any] {
            fail(params["message"] as? String ?? "BrowserBear disconnected this page.")
            return
        }
        if let id = m["id"] as? Int {
            lock.lock()
            let reply = waiting.removeValue(forKey: id)
            lock.unlock()
            reply?(m["result"] as? [String: Any] ?? [:])
            return
        }
        if m["method"] as? String == "Page.javascriptDialogOpening", let params = m["params"] as? [String: Any] {
            dialogOpen = true
            onDialog?(params)
            return
        }
        if m["method"] as? String == "Page.javascriptDialogClosed" {
            dialogOpen = false
            onDialogClosed?()
            return
        }
        guard m["method"] as? String == "Page.screencastFrame", let params = m["params"] as? [String: Any],
              let b64 = params["data"] as? String, let jpeg = Data(base64Encoded: b64),
              let source = CGImageSourceCreateWithData(jpeg as CFData, nil),
              let image = CGImageSourceCreateImageAtIndex(source, 0, [kCGImageSourceShouldCacheImmediately: true] as CFDictionary)
        else { return }
        onFrame?(image)
        lock.lock()
        frames += 1
        let first = frames == 1
        lock.unlock()
        if first { onFirstFrame?() }
        // Chrome sends the next one when it's had this answer, so a slow Mac
        // gets fewer frames rather than a growing queue.
        if let sid = params["sessionId"] { send("Page.screencastFrameAck", ["sessionId": sid]) }
    }

    private func fail(_ message: String) {
        lock.lock()
        guard !ended else { lock.unlock(); return }
        ended = true
        nextMove = nil
        lock.unlock()
        pipe?.close()
        onError?(message)
    }
}

// MARK: - The picture and Mike's input

final class AgentSurfaceView: NSView {
    private(set) var stream: AgentStream?
    private let port: Int
    private let targetId: String
    private let bridgeTab: Int?
    private let profile: String?
    private let thread: String
    var onError: ((String) -> Void)?
    var onConnected: (() -> Void)?
    private var streamed: CGSize = .zero
    private var buttons = 0
    private var lastCursorLook = Date.distantPast
    private var cursorPending = false
    private var realWindowShown = false

    init(port: Int, tab: AgentTab, thread: String) {
        self.port = port
        self.targetId = tab.targetId ?? ""
        self.bridgeTab = tab.bridge == true ? tab.tabId : nil
        self.thread = thread
        self.profile = tab.profile
        super.init(frame: .zero)
        wantsLayer = true
        layer?.contentsGravity = bridgeTab == nil ? .topLeft : .resize
        layer?.backgroundColor = NSColor.windowBackgroundColor.cgColor
        layerContentsRedrawPolicy = .never
    }

    required init?(coder: NSCoder) { fatalError() }

    override var isFlipped: Bool { true }
    override var acceptsFirstResponder: Bool { true }
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }

    override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        if window == nil { stop() } else { start() }
    }

    private func start() {
        guard stream == nil else { return }
        let stream = AgentStream(port: port, targetId: targetId, bridgeTab: bridgeTab, profile: profile, thread: thread)
        // Off the main thread, in its own transaction: Core Animation allows
        // it, and the picture keeps moving while the app is busy.
        let target = layer
        stream.onFrame = { image in
            CATransaction.begin()
            CATransaction.setDisableActions(true)
            target?.contents = image
            CATransaction.commit()
            CATransaction.flush()
        }
        stream.onDialog = { [weak self] params in
            DispatchQueue.main.async { self?.showDialog(params) }
        }
        stream.onDialogClosed = { [weak self] in
            DispatchQueue.main.async { self?.closeDialog() }
        }
        stream.onError = { [weak self] message in
            DispatchQueue.main.async { self?.onError?(message) }
        }
        stream.onFirstFrame = { [weak self] in DispatchQueue.main.async { self?.onConnected?() } }
        self.stream = stream
        stream.send("Page.enable")
        stream.send("Emulation.setFocusEmulationEnabled", ["enabled": true])
        streamed = .zero
        resizePage()
    }

    private func stop() {
        if dialogView != nil { stream?.send("Page.handleJavaScriptDialog", ["accept": false]); closeDialog() }
        stream?.send("Page.stopScreencast")
        stream?.close()
        stream = nil
    }

    override func layout() {
        super.layout()
        resizePage()
    }

    override func viewDidChangeBackingProperties() {
        super.viewDidChangeBackingProperties()
        streamed = .zero
        resizePage()
    }

    /// The page takes the panel's size, so it lays itself out for it, at the
    /// screen's own resolution. The agent sees the same page at the same size.
    private func resizePage() {
        guard let stream, let window, bounds.width > 10, bounds.height > 10, bounds.size != streamed else { return }
        streamed = bounds.size
        let scale = window.backingScaleFactor
        layer?.contentsScale = scale
        // Existing Chrome windows and sites expect at least a phone's width.
        // Scale that viewport into a narrow panel, including its input points.
        let ratio = pageScale
        stream.send("Emulation.setDeviceMetricsOverride", [
            "width": Int(ceil(bounds.width * ratio)), "height": Int(ceil(bounds.height * ratio)), "deviceScaleFactor": scale, "mobile": false,
        ])
        stream.send("Page.startScreencast", [
            "format": "jpeg", "quality": 85, "everyNthFrame": 1,
            "maxWidth": Int(bounds.width * scale), "maxHeight": Int(bounds.height * scale),
        ])
    }

    // MARK: Mouse

    override func updateTrackingAreas() {
        super.updateTrackingAreas()
        trackingAreas.forEach(removeTrackingArea)
        addTrackingArea(NSTrackingArea(rect: .zero, options: [.mouseMoved, .activeAlways, .inVisibleRect, .cursorUpdate], owner: self))
    }

    private var pageScale: CGFloat { bridgeTab == nil ? 1 : max(1, 360 / max(1, bounds.width)) }

    private func point(_ event: NSEvent) -> CGPoint {
        let p = convert(event.locationInWindow, from: nil)
        return CGPoint(x: p.x * pageScale, y: p.y * pageScale)
    }

    private static func modifiers(_ event: NSEvent) -> Int {
        var bits = 0
        if event.modifierFlags.contains(.option) { bits |= 1 }
        if event.modifierFlags.contains(.control) { bits |= 2 }
        if event.modifierFlags.contains(.command) { bits |= 4 }
        if event.modifierFlags.contains(.shift) { bits |= 8 }
        return bits
    }

    private func mouse(_ type: String, _ event: NSEvent, button: String = "none", clicks: Int = 0) {
        let p = point(event)
        stream?.send("Input.dispatchMouseEvent", [
            "type": type, "x": p.x, "y": p.y, "button": button, "buttons": buttons,
            "clickCount": clicks, "modifiers": Self.modifiers(event),
        ])
    }

    private final class Press {
        var released: NSEvent?
        var checked = false
        var handled = false
    }
    private var pendingPress: Press?

    override func mouseDown(with event: NSEvent) {
        window?.makeFirstResponder(self)
        // A <select> would open Chrome's native menu on the parked window,
        // out of sight and holding up the page, so it opens here instead.
        let p = point(event)
        let press = Press()
        pendingPress = press
        selectAt(p) { [weak self] handled in
            press.checked = true
            press.handled = handled
            guard let self, !handled else { return }
            self.buttons |= 1
            self.mouse("mousePressed", event, button: "left", clicks: event.clickCount)
            if let up = press.released {
                self.buttons &= ~1
                self.mouse("mouseReleased", up, button: "left", clicks: up.clickCount)
                if self.pendingPress === press { self.pendingPress = nil }
            }
        }
    }

    override func mouseUp(with event: NSEvent) {
        if let press = pendingPress, !press.checked { press.released = event; return }
        pendingPress = nil
        guard buttons & 1 != 0 else { return }
        buttons &= ~1
        mouse("mouseReleased", event, button: "left", clicks: event.clickCount)
    }

    override func mouseDragged(with event: NSEvent) { mouse("mouseMoved", event) }

    override func mouseMoved(with event: NSEvent) {
        mouse("mouseMoved", event)
        lookAtCursor(point(event))
    }

    // Chrome's own context menu would open out of sight too, and it's a native
    // one the page can't answer past, so this is a small one of ours.
    override func rightMouseDown(with event: NSEvent) {
        let menu = NSMenu()
        menu.addItem(item("Back", symbol: "chevron.left") { [weak self] in self?.stream?.send("Runtime.evaluate", ["expression": "history.back()"]) })
        menu.addItem(item("Forward", symbol: "chevron.right") { [weak self] in self?.stream?.send("Runtime.evaluate", ["expression": "history.forward()"]) })
        menu.addItem(item("Reload", symbol: "arrow.clockwise") { [weak self] in self?.stream?.send("Page.reload") })
        menu.addItem(.separator())
        menu.addItem(item("Copy", symbol: "doc.on.doc") { [weak self] in self?.editing("copy") })
        menu.addItem(item("Paste", symbol: "doc.on.clipboard") { [weak self] in self?.editing("paste") })
        NSMenu.popUpContextMenu(menu, with: event, for: self)
    }

    final class MenuAction: NSObject {
        let run: () -> Void
        init(_ run: @escaping () -> Void) { self.run = run }
        @objc func fire() { run() }
    }

    /// No `symbol` for a page's own <select> options: they're the page's
    /// words, which have no icons ("" draws none).
    private func item(_ title: String, symbol: String = "", _ run: @escaping () -> Void) -> NSMenuItem {
        let action = MenuAction(run)
        let item = NSMenuItem(title: title, symbol: symbol, action: #selector(MenuAction.fire), target: action)
        item.representedObject = action // the menu item doesn't keep its target
        return item
    }

    override func scrollWheel(with event: NSEvent) {
        scrollWheel(event, at: point(event))
    }

    private func scrollWheel(_ event: NSEvent, at p: CGPoint) {
        // Trackpad deltas are in points already; a wheel's are in lines.
        let scale: CGFloat = event.hasPreciseScrollingDeltas ? 1 : 40
        stream?.send("Input.dispatchMouseEvent", [
            "type": "mouseWheel", "x": p.x, "y": p.y, "button": "none", "modifiers": Self.modifiers(event),
            "deltaX": -event.scrollingDeltaX * scale * pageScale, "deltaY": -event.scrollingDeltaY * scale * pageScale,
        ])
    }

    /// The pointer the page wants there, as the picture can't show it.
    private func lookAtCursor(_ p: CGPoint) {
        guard !cursorPending, Date().timeIntervalSince(lastCursorLook) > 0.1 else { return }
        cursorPending = true
        lastCursorLook = Date()
        stream?.send("Runtime.evaluate", [
            "expression": "(() => { const e = document.elementFromPoint(\(p.x), \(p.y)); return e ? getComputedStyle(e).cursor : '' })()",
            "returnByValue": true,
        ]) { reply in
            let cursor = (reply["result"] as? [String: Any])?["value"] as? String ?? ""
            DispatchQueue.main.async { [weak self] in
                guard let self else { return }
                self.cursorPending = false
                guard self.window?.isKeyWindow == true else { return }
                switch cursor {
                case "pointer": NSCursor.pointingHand.set()
                case "text": NSCursor.iBeam.set()
                case "grab", "grabbing": NSCursor.openHand.set()
                case "not-allowed": NSCursor.operationNotAllowed.set()
                default: NSCursor.arrow.set()
                }
            }
        }
    }

    // MARK: <select>

    private func selectAt(_ p: CGPoint, then: @escaping @MainActor (Bool) -> Void) {
        guard let stream else { return then(false) }
        let js = """
        (() => { const s = document.elementFromPoint(\(p.x), \(p.y))?.closest?.('select');
          if (!s || s.multiple || s.size > 1 || s.disabled) return null;
          window.__tbSelect = s; s.focus();
          return [...s.options].map((o, i) => ({ i, text: o.text, on: o.selected, off: o.disabled })); })()
        """
        stream.send("Runtime.evaluate", ["expression": js, "returnByValue": true]) { reply in
            let options = (reply["result"] as? [String: Any])?["value"] as? [[String: Any]]
            DispatchQueue.main.async { [weak self] in
                guard let self else { return }
                guard let options else { return MainActor.assumeIsolated { then(false) } }
                MainActor.assumeIsolated { then(true) }
                self.showSelect(options, at: p)
            }
        }
    }

    /// The automation's choice for the next menu, as a real one would wait
    /// for a person: `pick` is the row to press.
    private var automationPick: Int?

    private func showSelect(_ options: [[String: Any]], at p: CGPoint) {
        let menu = NSMenu()
        for option in options {
            let index = option["i"] as? Int ?? 0
            let row = item(option["text"] as? String ?? "") { [weak self] in
                self?.stream?.send("Runtime.evaluate", ["expression": """
                (() => { const s = window.__tbSelect; if (!s) return; s.selectedIndex = \(index);
                  s.dispatchEvent(new Event('input', { bubbles: true })); s.dispatchEvent(new Event('change', { bubbles: true })); })()
                """, "userGesture": true])
            }
            row.state = option["on"] as? Bool == true ? .on : .off
            row.isEnabled = option["off"] as? Bool != true
            menu.addItem(row)
        }
        if let pick = automationPick {
            automationPick = nil
            if let row = menu.item(at: pick), let target = row.target as? MenuAction { target.fire() }
            return
        }
        menu.popUp(positioning: nil, at: CGPoint(x: p.x / pageScale, y: p.y / pageScale), in: self)
    }

    // MARK: Automation

    func automate(_ c: [String: Any], in window: NSWindow) -> String {
        let x = (c["x"] as? Double) ?? 0, y = (c["y"] as? Double) ?? 0
        let at = convert(NSPoint(x: x / pageScale, y: y / pageScale), to: nil)
        let now = ProcessInfo.processInfo.systemUptime
        var flags: NSEvent.ModifierFlags = []
        for m in c["mods"] as? [String] ?? [] {
            switch m {
            case "cmd": flags.insert(.command)
            case "shift": flags.insert(.shift)
            case "alt": flags.insert(.option)
            case "ctrl": flags.insert(.control)
            default: break
            }
        }
        automationPick = c["pick"] as? Int
        func mouse(_ type: NSEvent.EventType) -> NSEvent? {
            .mouseEvent(with: type, location: at, modifierFlags: flags, timestamp: now, windowNumber: window.windowNumber, context: nil, eventNumber: 0, clickCount: 1, pressure: 1)
        }
        func key(_ chars: String, _ code: UInt16, _ type: NSEvent.EventType) -> NSEvent? {
            .keyEvent(with: type, location: .zero, modifierFlags: flags, timestamp: now, windowNumber: window.windowNumber, context: nil,
                      characters: chars, charactersIgnoringModifiers: chars.lowercased(), isARepeat: false, keyCode: code)
        }
        switch c["do"] as? String {
        case "status":
            return "ok stream=\(stream != nil) frames=\(stream?.receivedFrames ?? 0) frame=\(bounds.size) bridge=\(bridgeTab != nil)"
        case "click":
            mouse(.leftMouseDown).map(window.sendEvent)
            // The press waits on a look for a <select>, so the release follows it.
            DispatchQueue.main.asyncAfter(deadline: .now() + ((c["releaseDelay"] as? Double) ?? 0.15)) { mouse(.leftMouseUp).map(window.sendEvent) }
        case "right":
            mouse(.rightMouseDown).map(window.sendEvent)
        case "scroll":
            guard let cg = CGEvent(scrollWheelEvent2Source: nil, units: .pixel, wheelCount: 1, wheel1: Int32(-((c["dy"] as? Double) ?? 0)), wheel2: 0, wheel3: 0),
                  let event = NSEvent(cgEvent: cg) else { return "error no event" }
            scrollWheel(event, at: CGPoint(x: x, y: y))
        case "key":
            let chars = c["chars"] as? String ?? ""
            let code = UInt16(c["code"] as? Int ?? 0)
            guard let down = key(chars, code, .keyDown), let up = key(chars, code, .keyUp) else { return "error no event" }
            if flags.contains(.command), performKeyEquivalent(with: down) { return "ok key equivalent" }
            keyDown(with: down)
            keyUp(with: up)
        case "type":
            for ch in c["text"] as? String ?? "" {
                let text = String(ch)
                let code = KeyNames.code(forCharacter: text.lowercased())
                guard let down = key(text, code, .keyDown), let up = key(text, code, .keyUp) else { continue }
                keyDown(with: down)
                keyUp(with: up)
            }
        default:
            return "error do what?"
        }
        return "ok"
    }

    // MARK: Keys

    /// On a Mac, Chrome only edits text for a key sent this way if it's told
    /// which editing command the key means, as AppKit would normally work out.
    private static func editCommands(_ event: NSEvent) -> [String] {
        let cmd = event.modifierFlags.contains(.command)
        let alt = event.modifierFlags.contains(.option)
        let shift = event.modifierFlags.contains(.shift)
        let sel = shift ? "AndModifySelection" : ""
        switch event.keyCode {
        case 51: return [cmd ? "deleteToBeginningOfLine" : alt ? "deleteWordBackward" : "deleteBackward"]
        case 117: return [alt ? "deleteWordForward" : "deleteForward"]
        case 36, 76: return [alt ? "insertNewlineIgnoringFieldEditor" : "insertNewline"]
        case 48: return [shift ? "insertBacktab" : "insertTab"]
        case 123: return [cmd ? "moveToLeftEndOfLine\(sel)" : alt ? "moveWordLeft\(sel)" : "moveLeft\(sel)"]
        case 124: return [cmd ? "moveToRightEndOfLine\(sel)" : alt ? "moveWordRight\(sel)" : "moveRight\(sel)"]
        case 126: return [cmd ? "moveToBeginningOfDocument\(sel)" : alt ? "moveToBeginningOfParagraph\(sel)" : "moveUp\(sel)"]
        case 125: return [cmd ? "moveToEndOfDocument\(sel)" : alt ? "moveToEndOfParagraph\(sel)" : "moveDown\(sel)"]
        default: return []
        }
    }

    private func editing(_ command: String) {
        stream?.send("Input.dispatchKeyEvent", ["type": "rawKeyDown", "commands": [command]])
        stream?.send("Input.dispatchKeyEvent", ["type": "keyUp"])
    }

    override func performKeyEquivalent(with event: NSEvent) -> Bool {
        guard window?.firstResponder === self, event.modifierFlags.contains(.command) else { return super.performKeyEquivalent(with: event) }
        let shift = event.modifierFlags.contains(.shift)
        switch event.charactersIgnoringModifiers?.lowercased() {
        case "a": editing("selectAll")
        case "c": editing("copy")
        case "x": editing("cut")
        case "v": editing("paste")
        case "z": editing(shift ? "redo" : "undo")
        case "r": stream?.send("Page.reload")
        case "[": stream?.send("Runtime.evaluate", ["expression": "history.back()"])
        case "]": stream?.send("Runtime.evaluate", ["expression": "history.forward()"])
        default: return super.performKeyEquivalent(with: event)
        }
        return true
    }

    private func key(_ event: NSEvent, down: Bool) {
        let (code, vk) = KeyNames.lookup(event.keyCode)
        var params: [String: Any] = [
            "code": code, "windowsVirtualKeyCode": vk, "nativeVirtualKeyCode": Int(event.keyCode),
            "modifiers": Self.modifiers(event), "key": KeyNames.key(event, code: code),
        ]
        if down {
            let commands = Self.editCommands(event)
            let chars = event.characters ?? ""
            // Arrow keys and the like carry private-use characters, not text.
            let printable = !chars.isEmpty && !event.modifierFlags.contains(.command)
                && chars.unicodeScalars.allSatisfy { !(0xF700...0xF8FF).contains($0.value) && $0.value != 0x7F && $0.value != 0x1B && $0.value != 0x09 }
            params["type"] = printable ? "keyDown" : "rawKeyDown"
            if printable {
                params["text"] = chars
                params["unmodifiedText"] = event.charactersIgnoringModifiers ?? chars
            }
            if !commands.isEmpty { params["commands"] = commands }
            params["autoRepeat"] = event.isARepeat
        } else {
            params["type"] = "keyUp"
        }
        stream?.send("Input.dispatchKeyEvent", params)
    }

    override func keyDown(with event: NSEvent) { key(event, down: true) }
    override func keyUp(with event: NSEvent) { key(event, down: false) }

    // MARK: Dialogs

    /// The page's dialog, drawn over the page under its site's name
    /// (WebDialog): never an alert of Threadbear's own, which a page could
    /// word as Threadbear asking for a password (Daybreak, 7 Nov).
    private(set) var dialogView: NSView?
    private(set) var shownDialog: WebDialog?
    private var dialogPace = WebDialogPace()
    /// Where an answer goes; the stream, but a test can listen.
    var answerDialog: ([String: Any]) -> Void = { _ in }

    func closeDialog() {
        dialogView?.removeFromSuperview()
        dialogView = nil
        shownDialog = nil
    }

    func showDialog(_ params: [String: Any]) {
        guard dialogView == nil else { return }
        let send: ([String: Any]) -> Void = { [weak self] answer in
            guard let self else { return }
            if let stream = self.stream { stream.send("Page.handleJavaScriptDialog", answer) } else { self.answerDialog(answer) }
        }
        // One after another, as fast as each is closed: past a few, the
        // rest are answered no without showing.
        guard dialogPace.allow() else { return send(["accept": false]) }
        let dialog = WebDialog(type: params["type"] as? String, url: params["url"] as? String,
                               message: params["message"] as? String, defaultPrompt: params["defaultPrompt"] as? String)
        let view = NSHostingView(rootView: WebDialogCard(dialog: dialog) { [weak self] accept, text in
            // Closed by closeDialog meanwhile (the agent answered): done.
            guard let self, self.dialogView != nil else { return }
            self.closeDialog()
            var answer: [String: Any] = ["accept": accept]
            if dialog.kind == .prompt, accept { answer["promptText"] = text }
            send(answer)
        })
        view.frame = bounds
        view.autoresizingMask = [.width, .height]
        addSubview(view)
        dialogView = view
        shownDialog = dialog
    }

    // MARK: Chrome's own window

    /// Chrome's own sheets (a passkey, a permission, a password manager's
    /// popup) aren't in the page, so they aren't in the picture. This brings the
    /// real window up to answer them, and a second press parks it again.
    func showRealWindow() {
        realWindowShown.toggle()
        let shown = realWindowShown
        if bridgeTab != nil {
            stream?.showWindow(shown) { [weak self] in
                DispatchQueue.main.async {
                    guard let self, !shown else { return }
                    self.streamed = .zero
                    self.resizePage()
                }
            }
            return
        }
        let screen = window?.screen?.visibleFrame ?? NSScreen.main?.visibleFrame ?? .zero
        let main = NSScreen.screens.first?.frame.height ?? 0
        stream?.send("Browser.getWindowForTarget") { [weak self] reply in
            guard let id = reply["windowId"] else { return }
            let bounds: [String: Any] = shown
                ? ["left": Int(screen.midX - 640), "top": Int(main - screen.maxY + 40)]
                : ["left": -100000, "top": 100000]
            self?.stream?.send("Browser.setWindowBounds", ["windowId": id, "bounds": bounds])
        }
        AgentBrowserModel.shared.realWindowShown = shown
    }
}

/// The names Chrome wants for a Mac key: the physical key's `code`, and the old
/// Windows key number that plenty of sites still read.
enum KeyNames {
    private static let table: [UInt16: (String, Int)] = {
        var map: [UInt16: (String, Int)] = [
            36: ("Enter", 13), 76: ("NumpadEnter", 13), 48: ("Tab", 9), 49: ("Space", 32), 51: ("Backspace", 8), 53: ("Escape", 27),
            117: ("Delete", 46), 123: ("ArrowLeft", 37), 124: ("ArrowRight", 39), 125: ("ArrowDown", 40), 126: ("ArrowUp", 38),
            115: ("Home", 36), 119: ("End", 35), 116: ("PageUp", 33), 121: ("PageDown", 34),
            27: ("Minus", 189), 24: ("Equal", 187), 33: ("BracketLeft", 219), 30: ("BracketRight", 221), 42: ("Backslash", 220),
            41: ("Semicolon", 186), 39: ("Quote", 222), 43: ("Comma", 188), 47: ("Period", 190), 44: ("Slash", 191), 50: ("Backquote", 192),
        ]
        let letters: [(UInt16, String)] = [
            (0, "A"), (11, "B"), (8, "C"), (2, "D"), (14, "E"), (3, "F"), (5, "G"), (4, "H"), (34, "I"), (38, "J"), (40, "K"), (37, "L"), (46, "M"),
            (45, "N"), (31, "O"), (35, "P"), (12, "Q"), (15, "R"), (1, "S"), (17, "T"), (32, "U"), (9, "V"), (13, "W"), (7, "X"), (16, "Y"), (6, "Z"),
        ]
        for (code, letter) in letters { map[code] = ("Key\(letter)", Int(letter.unicodeScalars.first!.value)) }
        let digits: [(UInt16, Int)] = [(29, 0), (18, 1), (19, 2), (20, 3), (21, 4), (23, 5), (22, 6), (26, 7), (28, 8), (25, 9)]
        for (code, digit) in digits { map[code] = ("Digit\(digit)", 48 + digit) }
        return map
    }()

    static func lookup(_ keyCode: UInt16) -> (String, Int) { table[keyCode] ?? ("", 0) }

    /// For the automation's typing.
    static func code(forCharacter text: String) -> UInt16 {
        if text == " " { return 49 }
        let name = text.first?.isNumber == true ? "Digit\(text)" : "Key\(text.uppercased())"
        return table.first { $0.value.0 == name }?.key ?? 0
    }

    static func key(_ event: NSEvent, code: String) -> String {
        switch code {
        case "Enter", "NumpadEnter": return "Enter"
        case "Tab", "Backspace", "Escape", "Delete", "ArrowLeft", "ArrowRight", "ArrowDown", "ArrowUp", "Home", "End", "PageUp", "PageDown": return code
        case "Space": return " "
        default: return event.characters ?? ""
        }
    }
}

/// A page's dialog over the page (AgentSurfaceView.showDialog), the way a
/// browser draws one: the site's name above its words, OK and Cancel, and
/// for a prompt where what's typed goes. The page behind is dimmed, as
/// nothing on it moves until it's answered.
struct WebDialogCard: View {
    let dialog: WebDialog
    let answer: (Bool, String) -> Void
    @State private var text: String
    @FocusState private var focused: Bool

    init(dialog: WebDialog, answer: @escaping (Bool, String) -> Void) {
        self.dialog = dialog
        self.answer = answer
        _text = State(initialValue: dialog.defaultPrompt)
    }

    var body: some View {
        ZStack(alignment: .top) {
            Color.black.opacity(0.18)
                .contentShape(Rectangle())
                .onTapGesture {}
            VStack(alignment: .leading, spacing: 10) {
                Label(dialog.heading, systemImage: "globe")
                    .font(.system(size: 13, weight: .semibold))
                    .lineLimit(1)
                    .truncationMode(.middle)
                if !dialog.message.isEmpty {
                    ScrollView {
                        Text(dialog.message)
                            .font(.system(size: 13))
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .textSelection(.enabled)
                    }
                    .frame(maxHeight: 160)
                    .fixedSize(horizontal: false, vertical: true)
                }
                if dialog.kind == .prompt {
                    TextField("", text: $text)
                        .textFieldStyle(.roundedBorder)
                        .focused($focused)
                        .onSubmit { answer(true, text) }
                    Text(dialog.sendsTo)
                        .font(.system(size: 11))
                        .foregroundStyle(.secondary)
                }
                HStack {
                    Spacer()
                    if dialog.kind != .alert {
                        Button("Cancel") { answer(false, text) }
                            .keyboardShortcut(.cancelAction)
                            .tip("Answer the page no")
                    }
                    Button(dialog.kind == .beforeunload ? "Leave" : "OK") { answer(true, text) }
                        .keyboardShortcut(.defaultAction)
                        .tip(dialog.kind == .prompt ? "Send what's in the box to \(dialog.site)" : "Answer the page yes")
                }
            }
            .padding(14)
            .frame(width: 400)
            // The shadow on the card's shape alone, not on what's inside it.
            .background(RoundedRectangle(cornerRadius: 8).fill(Color(nsColor: .textBackgroundColor)).shadow(color: .black.opacity(0.25), radius: 12, y: 4))
            .overlay(RoundedRectangle(cornerRadius: 8).stroke(Color.primary.opacity(0.15)))
            .padding(.top, 24)
        }
        .onAppear { focused = dialog.kind == .prompt }
    }
}
