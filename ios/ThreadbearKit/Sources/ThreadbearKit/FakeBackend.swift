import CoreGraphics
import Foundation
import ImageIO

/// An in-memory backend for the simulator, screenshots and previews, so the
/// app can be built and looked at without a runner or a deployment. It
/// plays the runner's part too: a sent message starts a short turn that
/// ends with a canned reply.
public final class FakeBackend: Backend, @unchecked Sendable {
    private let lock = NSLock()
    private var threadsById: [String: PhoneThread]
    private var messagesById: [String: [PhoneMessage]]
    private var runnerList: [PhoneRunner]
    private var scheduleList: [PhoneSchedule]
    private var pocketCards = FakeBackend.samplePocket
    private var commands: [String: CommandStatus] = [:]
    /// Messages sent while the runner's offline (`runnerOnline: false`),
    /// by thread, as phone:waiting lists them.
    private var waitingByThread: [String: [WaitingSend]] = [:]
    private var listeners: [UUID: @Sendable () -> Void] = [:]
    /// How long a fake turn takes. Zero in tests.
    private let turnDelay: Duration
    /// How long a new thread takes to start (AppModel's -ThreadbearSlowStart
    /// makes it long, so the inbox's Starting row stays for a screenshot).
    public var startDelay: Duration = .seconds(1.5)
    /// How long an answer to a card waits for the "runner" to take it, to see
    /// the card waiting. Nothing changes until then, as on a real one.
    public var answerDelay: Duration = .zero
    /// And then it refuses them, to see a card coming back.
    public var answersFail = false
    /// How long the thread lists take to answer the first time, to see the
    /// app's loading rows (`-ThreadbearSlowLoad`). Zero normally.
    private let listDelay: Duration
    private var imagesById: [String: [MessageImage]] = [:]

    /// `runners`: the Mac asleep and two more runners online (`-ThreadbearRunners`),
    /// for the new thread sheet's runner picker. Left out of the usual samples.
    /// `queued`: with the runner offline, a3 already has two messages
    /// waiting for it, for the screenshots.
    public init(now: Date = .now, turnDelay: Duration = .seconds(2), runnerOnline: Bool = true, listDelay: Duration = .zero, pictures: Bool = false, long: Bool = false, secret: Bool = false, diagrams: Bool = false, runners: Bool = false, queued: Bool = false) {
        let sample = Self.sample(now: now)
        threadsById = Dictionary(uniqueKeysWithValues: sample.threads.map { ($0.threadId, $0) })
        messagesById = sample.messages
        // Left out of the usual samples, which the App Store shots are of.
        if pictures {
            let thread = Self.pictureThread(now: now)
            threadsById[thread.thread.threadId] = thread.thread
            messagesById[thread.thread.threadId] = thread.messages
            imagesById[thread.thread.threadId] = thread.images
        }
        if long {
            let thread = Self.longThread(now: now)
            threadsById[thread.thread.threadId] = thread.thread
            messagesById[thread.thread.threadId] = thread.messages
            imagesById[thread.thread.threadId] = thread.images
        }
        if diagrams {
            let thread = Self.diagramThread(now: now)
            threadsById[thread.thread.threadId] = thread.thread
            messagesById[thread.thread.threadId] = thread.messages
        }
        if secret {
            let thread = Self.secretThread(now: now)
            threadsById[thread.thread.threadId] = thread.thread
            messagesById[thread.thread.threadId] = thread.messages
        }
        scheduleList = sample.schedules
        runnerList = [PhoneRunner(runnerId: "mac", name: "MacBook Pro", version: "0.1.0",
                                  lastSeenAt: runnerOnline && !runners ? now : now.addingTimeInterval(-3 * 3600), placed: runners ? true : nil, main: true)]
        if runners {
            runnerList += [PhoneRunner(runnerId: "mini", name: "Mac mini", version: "0.1.0", lastSeenAt: now, placed: true),
                           PhoneRunner(runnerId: "cloud", name: "Cloud", version: "0.1.0", lastSeenAt: now, placed: true)]
        }
        self.turnDelay = turnDelay
        self.listDelay = listDelay
        if queued {
            let at = now.timeIntervalSince1970 * 1000
            waitingByThread["a3"] = [
                WaitingSend(commandId: "cmd_q1", state: .pending, text: "Yes, ship it", createdAt: at - 120_000),
                WaitingSend(commandId: "cmd_q2", state: .pending, text: "And check it on the iPad too while you're there", createdAt: at - 60_000),
            ]
            for send in waitingByThread["a3"]! { commands[send.commandId] = CommandStatus(state: .pending) }
        }
    }

    // MARK: A thread asking for a secret

    /// `-ThreadbearSecret`: one thread waiting on a secret card. Left out of
    /// the usual samples, which the App Store shots are of. The key is a
    /// made-up one (the seal test's), so the demo never pins a real runner's.
    static let sampleSecretKey = "pOCSkrZRwni5dyxWn1+puxPZBrRqtoyd+dwrRAn4ogk="
    /// What the demo keeps as if a pairing link had carried it, so its
    /// secret card can be answered (the thread is on the default "mac").
    public static let sampleRunnerKeys = ["mac": sampleSecretKey]

    private static func secretThread(now: Date) -> (thread: PhoneThread, messages: [PhoneMessage]) {
        let ago = { (minutes: Double) in now.addingTimeInterval(-minutes * 60) }
        let thread = PhoneThread(
            threadId: "secret", title: "Deploy the docs site", cwd: "~/code/website", status: .waiting, needsYou: true,
            preview: "I need a deploy token to go on.", lastActivityAt: ago(1),
            pendingApproval: .secret(id: "sec1", label: "Hosting deploy token",
                                     reason: "To deploy the docs site. Make one under Account, then API tokens, with deploy access.",
                                     placeholder: nil, key: sampleSecretKey))
        let messages = [
            PhoneMessage(seq: 1, role: .user, text: "Deploy the docs site when the build's green", at: ago(6)),
            PhoneMessage(seq: 2, role: .tool, text: "Run the docs build", toolKind: "command", at: ago(4)),
            PhoneMessage(seq: 3, role: .assistant, text: "The build's green. I need a deploy token to go on.", at: ago(1)),
        ]
        return (thread, messages)
    }

    // MARK: A thread with a diagram and a page

    /// `-ThreadbearDiagrams`: a reply with a mermaid diagram and an html
    /// block, drawn as what they show (RichBlockView).
    private static func diagramThread(now: Date) -> (thread: PhoneThread, messages: [PhoneMessage]) {
        let ago = { (minutes: Double) in now.addingTimeInterval(-minutes * 60) }
        let thread = PhoneThread(threadId: "diagrams", title: "Make uploads resume after a crash", cwd: "~/dev/photo-sync",
                                 preview: "Here's how resuming works now.", lastActivityAt: ago(1))
        let messages = [
            PhoneMessage(seq: 1, role: .user, text: "How does resuming work now? Draw it for me", at: ago(4)),
            PhoneMessage(seq: 2, role: .assistant, text: """
            Here's how resuming works now. Each chunk saves its offset, so a crash picks up where it left off:

            ```mermaid
            flowchart TD
              A[Upload starts] --> B{Saved offset?}
              B -- yes --> C[Resume from offset]
              B -- no --> D[Start at zero]
              C --> E[Send chunk]
              D --> E
              E --> F{More chunks?}
              F -- yes --> E
              F -- no --> G[Mark done]
            ```

            And the speed difference from the test run:

            ```html
            <div style="font:15px -apple-system;padding:14px;background:#fafafa;color:#222;border-radius:8px">
              <b>Upload time, before and after</b>
              <div style="margin-top:8px">Before</div>
              <div style="height:14px;background:#e5e5e5;border-radius:4px"><div style="width:92%;height:100%;background:#3b82f6;border-radius:4px"></div></div>
              <div style="margin-top:8px">After</div>
              <div style="height:14px;background:#e5e5e5;border-radius:4px"><div style="width:34%;height:100%;background:#22c55e;border-radius:4px"></div></div>
            </div>
            ```
            """, at: ago(1)),
        ]
        return (thread, messages)
    }

    // MARK: A thread with pictures

    /// `-ThreadbearPictures`: one thread with each way a picture can come:
    /// wide in a reply, tall in a reply, animated, pinned, and one only on the
    /// Mac.
    private static func pictureThread(now: Date) -> (thread: PhoneThread, messages: [PhoneMessage], images: [MessageImage]) {
        let ago = { (minutes: Double) in now.addingTimeInterval(-minutes * 60) }
        let thread = PhoneThread(threadId: "pics", title: "Back panel screw layout", cwd: "~/dev/workbench", preview: "Here's where the screws go.", lastActivityAt: ago(2))
        let wide = "/Users/you/guide/back-screws.png", tall = "/Users/you/guide/case-side.png", moving = "/Users/you/guide/which-way.gif"
        let messages = [
            PhoneMessage(seq: 1, role: .user, text: "Where do the back screws go?", at: ago(9)),
            PhoneMessage(seq: 2, role: .tool, text: "Wrote guide/back-screws.png", toolKind: "write", at: ago(7)),
            PhoneMessage(seq: 3, role: .tool, text: "threadbear: pin", toolKind: "mcp", at: ago(6)),
            PhoneMessage(seq: 4, role: .assistant, text: """
            Here's where the screws go, all round the outside edge:

            ![Back screw layout](\(wide))

            - **Top and bottom:** 5 screws each.
            - **Each side:** 2 screws.

            The side view, which is tall:

            ![Side view](\(tall))

            Which way it turns:

            ![Which way it turns](\(moving))

            And the first go, which I haven't got any more:

            ![First attempt](/Users/you/guide/first-go.png)
            """, at: ago(2)),
        ]
        let images = [
            MessageImage(seq: 3, pinned: true, url: samplePicture("pinned", width: 900, height: 900, hue: 0.33), width: 900, height: 900),
            MessageImage(seq: 4, src: wide, url: samplePicture("wide", width: 1600, height: 900, hue: 0.58), width: 1600, height: 900),
            MessageImage(seq: 4, src: tall, url: samplePicture("tall", width: 800, height: 2000, hue: 0.08), width: 800, height: 2000),
            MessageImage(seq: 4, src: moving, url: sampleAnimation("moving", width: 720, height: 480), width: 720, height: 480),
        ]
        return (thread, messages, images)
    }

    // MARK: A long thread

    /// `-ThreadbearLong`: a build-along thread, "long": hundreds of rows of
    /// long replies, tool lines and pictures, for opening a big thread.
    private static func longThread(now: Date) -> (thread: PhoneThread, messages: [PhoneMessage], images: [MessageImage]) {
        let ago = { (minutes: Double) in now.addingTimeInterval(-minutes * 60) }
        let thread = PhoneThread(threadId: "long", title: "Drawer build along", cwd: "~/dev/workbench", preview: "On to the runners.", lastActivityAt: ago(1))
        let picture = samplePicture("long", width: 1600, height: 1200, hue: 0.12)
        var messages: [PhoneMessage] = []
        var images: [MessageImage] = []
        var seq = 0
        let turns = 150
        for turn in 0 ..< turns {
            let at = ago(Double(turns - turn))
            seq += 1
            messages.append(PhoneMessage(seq: seq, role: .user, text: "Step \(turn): how does this look?", at: at))
            for tool in 0 ..< 3 {
                seq += 1
                messages.append(PhoneMessage(seq: seq, role: .tool, text: "Read guide/step-\(turn)-\(tool).md", toolKind: "read", at: at))
            }
            seq += 1
            let src = "/Users/you/guide/step-\(turn).png"
            let body = String(repeating: "Keep the pieces clamped tight, then drill until the cone has cut a recess about as wide as the screw head. ", count: 4)
            messages.append(PhoneMessage(seq: seq, role: .assistant, text: """
            **Step \(turn).** \(body)

            ![Step \(turn)](\(src))

            - **Glue:** leave the clamps on for about an hour.
            - **Screws:** evenly spaced and sitting flush.

            \(body)
            """, at: at))
            images.append(MessageImage(seq: seq, src: src, url: picture, width: 1600, height: 1200))
        }
        return (thread, messages, images)
    }

    /// A drawn picture with a grid and a cross, so zooming and fitting show.
    private static func samplePicture(_ name: String, width: Int, height: Int, hue: CGFloat) -> String {
        let file = FileManager.default.temporaryDirectory.appendingPathComponent("sample-\(name).png")
        let space = CGColorSpace(name: CGColorSpace.sRGB)!
        guard let c = CGContext(data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: 0, space: space, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { return file.absoluteString }
        c.setFillColor(CGColor(red: 0.2 + hue, green: 0.55, blue: 1.1 - hue, alpha: 1))
        c.fill(CGRect(x: 0, y: 0, width: width, height: height))
        c.setStrokeColor(CGColor(red: 1, green: 1, blue: 1, alpha: 0.7))
        c.setLineWidth(3)
        for x in stride(from: 0, through: width, by: 100) { c.strokeLineSegments(between: [CGPoint(x: x, y: 0), CGPoint(x: x, y: height)]) }
        for y in stride(from: 0, through: height, by: 100) { c.strokeLineSegments(between: [CGPoint(x: 0, y: y), CGPoint(x: width, y: y)]) }
        c.setLineWidth(12)
        c.strokeLineSegments(between: [.zero, CGPoint(x: width, y: height), CGPoint(x: width, y: 0), CGPoint(x: 0, y: height)])
        if let image = c.makeImage(), let out = CGImageDestinationCreateWithURL(file as CFURL, "public.png" as CFString, 1, nil) {
            CGImageDestinationAddImage(out, image, nil)
            CGImageDestinationFinalize(out)
        }
        return file.absoluteString
    }

    /// A GIF of a bar crossing the frame, holding longer on its last frame, so
    /// it shows whether a picture plays and keeps each frame's own time.
    private static func sampleAnimation(_ name: String, width: Int, height: Int) -> String {
        let file = FileManager.default.temporaryDirectory.appendingPathComponent("sample-\(name).gif")
        let frames = 12
        guard let out = CGImageDestinationCreateWithURL(file as CFURL, "com.compuserve.gif" as CFString, frames, nil) else { return file.absoluteString }
        CGImageDestinationSetProperties(out, [kCGImagePropertyGIFDictionary: [kCGImagePropertyGIFLoopCount: 0]] as CFDictionary)
        let space = CGColorSpace(name: CGColorSpace.sRGB)!
        for frame in 0..<frames {
            guard let c = CGContext(data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: 0, space: space, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { continue }
            c.setFillColor(CGColor(red: 0.16, green: 0.3, blue: 0.5, alpha: 1))
            c.fill(CGRect(x: 0, y: 0, width: width, height: height))
            c.setFillColor(CGColor(red: 1, green: 0.8, blue: 0.2, alpha: 1))
            c.fill(CGRect(x: (width - 80) * frame / (frames - 1), y: 0, width: 80, height: height))
            guard let image = c.makeImage() else { continue }
            let delay = frame == frames - 1 ? 0.8 : 0.1
            CGImageDestinationAddImage(out, image, [kCGImagePropertyGIFDictionary: [kCGImagePropertyGIFDelayTime: delay]] as CFDictionary)
        }
        CGImageDestinationFinalize(out)
        return file.absoluteString
    }

    // MARK: Live reads

    private func watch<T: Sendable>(_ read: @escaping @Sendable () -> T) -> AsyncThrowingStream<T, Error> {
        AsyncThrowingStream { continuation in
            let id = UUID()
            let push: @Sendable () -> Void = { continuation.yield(read()) }
            lock.withLock { listeners[id] = push }
            push()
            continuation.onTermination = { [weak self] _ in
                guard let self else { return }
                self.lock.withLock { _ = self.listeners.removeValue(forKey: id) }
            }
        }
    }

    private func changed() {
        let all = lock.withLock { Array(listeners.values) }
        for push in all { push() }
    }

    private func mutate(_ body: (FakeBackend) -> Void) {
        lock.withLock { body(self) }
        changed()
    }

    /// Only these sample threads, for screenshots of a short inbox.
    public func keepOnly(_ ids: Set<String>) {
        mutate { s in s.threadsById = s.threadsById.filter { ids.contains($0.key) } }
    }

    /// The running sample thread's turn ends by itself after a while, to watch
    /// its row move to the inbox.
    public func finishRunningThread(after delay: Duration) {
        Task { [weak self] in
            try? await Task.sleep(for: delay)
            self?.mutate { s in
                s.threadsById["a5"]?.status = .idle
                s.threadsById["a5"]?.working = nil
                s.threadsById["a5"]?.unread = true
                s.threadsById["a5"]?.lastActivityAt = .now
            }
        }
    }

    public func me() async throws -> PhoneIdentity {
        // Always a current backend, so the demo never says the Mac needs updating.
        PhoneIdentity(name: "iphone", expiresAt: Date.now.addingTimeInterval(90 * 86_400),
                      apiVersion: BackendCompatibility.currentAPIVersion)
    }

    public func runners() -> AsyncThrowingStream<[PhoneRunner], Error> {
        watch { [unowned self] in lock.withLock { runnerList } }
    }

    public func pocket() -> AsyncThrowingStream<[PocketCard], Error> {
        watch { [unowned self] in lock.withLock { pocketCards } }
    }

    public func removePocketCard(id: String) async throws {
        mutate { s in s.pocketCards.removeAll { $0.id == id } }
    }

    public func projects() -> AsyncThrowingStream<[PhoneProject], Error> {
        watch { Self.sampleProjects }
    }

    public func inboxChanges() -> AsyncThrowingStream<[PhoneThread], Error> { threads(.inbox) }

    public func threads(_ view: ThreadsView) -> AsyncThrowingStream<[PhoneThread], Error> {
        let live = liveThreads(view)
        guard listDelay > .zero else { return live }
        let delay = listDelay
        return AsyncThrowingStream { continuation in
            let task = Task {
                try? await Task.sleep(for: delay)
                do {
                    for try await value in live { continuation.yield(value) }
                    continuation.finish()
                } catch {
                    continuation.finish(throwing: error)
                }
            }
            continuation.onTermination = { _ in task.cancel() }
        }
    }

    public func search(_ text: String) async throws -> [PhoneThread] {
        let query = text.trimmingCharacters(in: .whitespacesAndNewlines)
        return lock.withLock { Array(threadsById.values) }
            .filter { $0.archivedAt != nil && ThreadSearch.matches($0, query) }
            .sorted { $0.lastActivityAt > $1.lastActivityAt }
    }

    private func liveThreads(_ view: ThreadsView) -> AsyncThrowingStream<[PhoneThread], Error> {
        watch { [unowned self] in
            let all = lock.withLock { Array(threadsById.values) }
            let now = Date.now
            return all.filter { t in
                switch view {
                case .den: t.archivedAt != nil
                case .hibernating: t.archivedAt == nil && t.starredAt == nil && InboxSections.isSnoozed(t, now: now)
                case .inbox: t.archivedAt == nil && (t.starredAt != nil || !InboxSections.isSnoozed(t, now: now))
                }
            }.sorted { $0.lastActivityAt > $1.lastActivityAt }
        }
    }

    public func schedules() -> AsyncThrowingStream<[PhoneSchedule], Error> {
        watch { [unowned self] in lock.withLock { scheduleList } }
    }

    public func counts() -> AsyncThrowingStream<PhoneCounts, Error> {
        watch { [unowned self] in
            let all = lock.withLock { Array(threadsById.values) }
            let now = Date.now
            return PhoneCounts(hibernating: all.filter { $0.archivedAt == nil && $0.starredAt == nil && InboxSections.isSnoozed($0, now: now) }.count,
                               den: all.filter { $0.archivedAt != nil }.count)
        }
    }

    public func thread(_ threadId: String) -> AsyncThrowingStream<ThreadDetail?, Error> {
        watch { [unowned self] in
            lock.withLock {
                threadsById[threadId].map { thread in
                    let all = messagesById[threadId] ?? []
                    // As phone:thread answers: only the newest text messages.
                    return ThreadDetail(thread: thread, messages: threadId == "long" ? Array(all.filter { $0.role != .tool }.suffix(20)) : all)
                }
            }
        }
    }

    public func messages(_ threadId: String, limit: Int) -> AsyncThrowingStream<MessagePage, Error> {
        let page = watch { [unowned self] in
            let all = lock.withLock { messagesById[threadId] ?? [] }
            let images = lock.withLock { imagesById[threadId] ?? [] }
            return MessagePage(messages: Array(all.suffix(limit)), hasMore: all.count > limit, images: images)
        }
        guard threadId == "long" else { return page }
        // The long thread's page comes after phone:thread's answer, as it
        // does over the network, so the view goes through the same swap.
        return AsyncThrowingStream { continuation in
            let task = Task {
                try? await Task.sleep(for: .milliseconds(700))
                do {
                    for try await value in page { continuation.yield(value) }
                    continuation.finish()
                } catch {
                    continuation.finish(throwing: error)
                }
            }
            continuation.onTermination = { _ in task.cancel() }
        }
    }

    public func command(_ commandId: String) -> AsyncThrowingStream<CommandStatus?, Error> {
        watch { [unowned self] in lock.withLock { commands[commandId] } }
    }

    public func waiting(_ threadId: String) -> AsyncThrowingStream<[WaitingSend], Error> {
        watch { [unowned self] in lock.withLock { waitingByThread[threadId] ?? [] } }
    }

    public func cancel(_ commandId: String) async throws -> Bool {
        var cancelled = false
        mutate { s in
            for (threadId, list) in s.waitingByThread where list.contains(where: { $0.commandId == commandId && $0.canCancel }) {
                s.waitingByThread[threadId] = list.filter { $0.commandId != commandId }
                s.commands[commandId] = CommandStatus(state: .failed, note: "Cancelled")
                cancelled = true
            }
        }
        return cancelled
    }

    public func connectionStates() -> AsyncStream<Bool> {
        AsyncStream { $0.yield(true) }
    }

    // MARK: Commands

    private func newCommand(threadId: String? = nil) -> String {
        let id = "cmd_" + UUID().uuidString.prefix(8)
        lock.withLock { commands[id] = CommandStatus(state: .done, threadId: threadId) }
        return id
    }

    private func append(_ threadId: String, role: PhoneMessage.Role, text: String, origin: String? = nil) {
        var list = messagesById[threadId] ?? []
        list.append(PhoneMessage(seq: (list.last?.seq ?? 0) + 1, role: role, text: text, origin: origin, at: .now))
        messagesById[threadId] = list
    }

    private func runTurn(_ threadId: String, reply: String) {
        let delay = turnDelay
        Task { [weak self] in
            try? await Task.sleep(for: delay)
            self?.mutate { s in
                s.append(threadId, role: .assistant, text: reply)
                s.threadsById[threadId]?.status = .idle
                s.threadsById[threadId]?.working = nil
                s.threadsById[threadId]?.needsYou = true
                s.threadsById[threadId]?.unread = true
                s.threadsById[threadId]?.preview = reply
                s.threadsById[threadId]?.lastActivityAt = .now
            }
        }
    }

    public func uploadPhoto(_ jpeg: Data) async throws -> String { UUID().uuidString }
    public func discardPhoto(_ storageId: String) async throws {}

    /// What the runner's mirror shows for a message with pictures (sync.ts
    /// toMessageDoc): a line for the ones no [Picture N] marker places.
    private static func withPictures(_ text: String, _ images: [String]) -> String {
        let count = InlinePictures.unplaced(text, count: images.count)
        guard count > 0 else { return text }
        let note = count == 1 ? "[1 picture]" : "[\(count) pictures]"
        return text.isEmpty ? note : "\(text)\n\n\(note)"
    }

    public func send(threadId: String, text: String, answers: [AskAnswer], images: [String]) async throws -> String {
        // The runner's offline: it waits, as it would in Convex.
        let runnerId = lock.withLock { threadsById[threadId]?.runnerId }
        if let runnerId, WaitingSends.offlineRunner(runnerId, in: lock.withLock { runnerList }, at: .now) != nil {
            let id = "cmd_" + UUID().uuidString.prefix(8)
            mutate { s in
                s.commands[id] = CommandStatus(state: .pending)
                s.waitingByThread[threadId, default: []].append(WaitingSend(commandId: id, state: .pending, text: text, photos: images.count,
                                                                            createdAt: Date.now.timeIntervalSince1970 * 1000))
            }
            return id
        }
        let text = Self.withPictures(text, images)
        let id = answered { fake in
            fake.mutate { s in
                s.waitingByThread[threadId] = nil
                s.append(threadId, role: .user, text: text, origin: "phone")
                // The next turn closes the card, as on the runner.
                s.threadsById[threadId]?.asks = nil
                s.threadsById[threadId]?.asksSeq = nil
                s.threadsById[threadId]?.next = nil
                s.threadsById[threadId]?.status = .running
                s.threadsById[threadId]?.working = "Bear with me"
                s.threadsById[threadId]?.needsYou = false
                s.threadsById[threadId]?.unread = false
                s.threadsById[threadId]?.lastActivityAt = .now
            }
            fake.runTurn(threadId, reply: "Done. I've made that change and the checks pass.")
        }
        // Slow, it waits faded in the transcript as a real one does.
        if answerDelay > .zero, !answersFail {
            mutate { s in
                s.waitingByThread[threadId, default: []].append(WaitingSend(commandId: id, state: .pending, text: text, photos: images.count,
                                                                            createdAt: Date.now.timeIntervalSince1970 * 1000))
            }
        }
        return id
    }

    /// Marks the button pressed on its message, as the runner's row would
    /// come back, with the first other thread as the one it started.
    public func press(threadId: String, buttonId: String) async throws -> String {
        var started: String?
        mutate { s in
            started = s.threadsById.keys.sorted().first { $0 != threadId }
            guard var list = s.messagesById[threadId] else { return }
            for i in list.indices {
                guard let b = list[i].buttons?.firstIndex(where: { $0.id == buttonId }) else { continue }
                list[i].buttons![b].pressedThreadId = started
                list[i].buttons![b].failed = nil
            }
            s.messagesById[threadId] = list
        }
        return newCommand(threadId: started)
    }

    /// Runs `land` when the runner would take the answer: now, or after
    /// `answerDelay`, or never if it's refusing them.
    private func answered(_ land: @escaping @Sendable (FakeBackend) -> Void) -> String {
        guard answerDelay > .zero else {
            land(self)
            return newCommand()
        }
        let id = "cmd_" + UUID().uuidString.prefix(8)
        lock.withLock { commands[id] = CommandStatus(state: .pending) }
        let (delay, fails) = (answerDelay, answersFail)
        Task { [weak self] in
            try? await Task.sleep(for: delay)
            guard let self else { return }
            if !fails { land(self) }
            self.mutate { s in s.commands[id] = fails ? CommandStatus(state: .failed, note: "the runner refused it") : CommandStatus(state: .done) }
        }
        return id
    }

    public func respond(threadId: String, approvalId: String, decision: ApprovalOption) async throws -> String {
        answered { fake in
            fake.mutate { s in
                s.threadsById[threadId]?.pendingApproval = nil
                s.threadsById[threadId]?.status = decision == .deny ? .idle : .running
                s.threadsById[threadId]?.working = decision == .deny ? nil : "Running the command"
            }
            if decision != .deny { fake.runTurn(threadId, reply: "That ran fine. Everything's green.") }
        }
    }

    public func answer(threadId: String, approvalId: String, answers: [String: String], summary: String) async throws -> String {
        answered { fake in
            fake.mutate { s in
                s.append(threadId, role: .user, text: summary, origin: "phone")
                s.threadsById[threadId]?.pendingApproval = nil
                s.threadsById[threadId]?.status = .running
                s.threadsById[threadId]?.working = "Bear with me"
            }
            fake.runTurn(threadId, reply: "Thanks, going with that.")
        }
    }

    public func secret(threadId: String, approvalId: String, answer: SecretAnswer) async throws -> String {
        let declined = answer == .decline
        mutate { s in
            s.threadsById[threadId]?.pendingApproval = nil
            s.threadsById[threadId]?.status = declined ? .idle : .running
            s.threadsById[threadId]?.working = declined ? nil : "Signing in"
            s.threadsById[threadId]?.needsYou = false
        }
        if !declined { runTurn(threadId, reply: "Thanks, that worked. I'm signed in now.") }
        return newCommand()
    }

    public func update(threadId: String, change: ThreadChange) async throws -> String {
        mutate { s in
            switch change {
            case let .snooze(until): s.threadsById[threadId]?.snoozedUntil = until
            case .snoozeUntilRestart: s.threadsById[threadId]?.snoozedUntilRestart = true
            case .wake:
                s.threadsById[threadId]?.snoozedUntil = nil
                s.threadsById[threadId]?.snoozedUntilRestart = nil
            case .archive, .archiveWithVerdict: s.threadsById[threadId]?.archivedAt = .now
            case .unarchive: s.threadsById[threadId]?.archivedAt = nil
            case .markSeen:
                s.threadsById[threadId]?.unread = false
                s.threadsById[threadId]?.needsYou = false
            case let .rename(title): s.threadsById[threadId]?.title = title
            case let .star(on):
                let starredAt = s.threadsById[threadId]?.starredAt
                s.threadsById[threadId]?.starredAt = on ? (starredAt ?? .now) : nil
            }
        }
        return newCommand()
    }

    public func accounts() -> AsyncThrowingStream<[PhoneAccount], Error> {
        watch { Self.sampleAccounts }
    }

    /// Two logins, so the demo's new thread sheet has models to pick.
    static let sampleAccounts = [
        PhoneAccount(id: "claude-main", provider: "claude", title: "Claude", models: [
            PhoneModelChoice(id: "opus", title: "Opus 5.5", effortLevels: ["low", "medium", "high", "xhigh", "max"]),
            PhoneModelChoice(id: "sonnet", title: "Sonnet 5.5", effortLevels: ["low", "medium", "high", "xhigh", "max"]),
            PhoneModelChoice(id: "haiku", title: "Haiku 5.5"),
        ]),
        PhoneAccount(id: "codex-main", provider: "codex", title: "Codex", models: [
            PhoneModelChoice(id: "gpt-6-astra", title: "GPT-6 Astra", effortLevels: ["low", "medium", "high", "xhigh", "ultra"]),
        ]),
    ]

    public func create(text: String, runnerId: String?, cwd: String?, images: [String], settings: NewThreadSettings) async throws -> String {
        let id = UUID().uuidString.lowercased()
        let title = text.isEmpty ? "Untitled" : String(text.prefix(48))
        let text = Self.withPictures(text, images)
        // Pending for a moment, as a real runner takes a second or more to
        // make it, so the demo shows the inbox's Starting row.
        let commandId = "cmd_" + UUID().uuidString.prefix(8)
        lock.withLock { commands[commandId] = CommandStatus(state: .pending) }
        Task {
            try? await Task.sleep(for: startDelay)
            mutate { s in
                s.threadsById[id] = PhoneThread(threadId: id, title: title, cwd: cwd ?? "~/code/misc", status: .running,
                                                lastActivityAt: .now, working: "Bear with me")
                s.append(id, role: .user, text: text, origin: "phone")
                s.commands[commandId] = CommandStatus(state: .done, threadId: id)
            }
            runTurn(id, reply: "On it. Here's what I found.")
        }
        return String(commandId)
    }

    public func quickAsk(_ ask: QuickAskRecord) async throws -> String {
        let id = UUID().uuidString.lowercased()
        mutate { s in
            s.threadsById[id] = PhoneThread(threadId: id, title: String(ask.question.prefix(48)), cwd: "~/code/misc", status: .idle,
                                            lastActivityAt: .now)
            s.append(id, role: .user, text: ask.question, origin: "phone")
            s.append(id, role: .assistant, text: ask.answer)
        }
        return newCommand(threadId: id)
    }

    public func setNotifications(apnsToken: String, notify: NotifyMode) async throws {}

    public func setRunnerOrder(_ runnerIds: [String]) async throws {
        mutate { s in
            let rank = { (r: PhoneRunner) in runnerIds.firstIndex(of: r.runnerId) ?? runnerIds.count }
            s.runnerList = s.runnerList.enumerated().sorted { (rank($0.element), $0.offset) < (rank($1.element), $1.offset) }.map(\.element)
            for i in s.runnerList.indices { s.runnerList[i].placed = runnerIds.contains(s.runnerList[i].runnerId) ? true : nil }
        }
    }

    public func loadEarlier(threadId: String, beforeSeq: Int) async throws -> String {
        let delay = turnDelay
        Task { [weak self] in
            try? await Task.sleep(for: delay / 4)
            self?.mutate { s in
                let earliest = Int(s.threadsById[threadId]?.earliestSeq ?? 1)
                let seqs = Array(max(earliest, beforeSeq - 50)..<beforeSeq)
                let older = seqs.map { seq in
                    PhoneMessage(seq: seq, role: seq % 2 == 0 ? .assistant : .user,
                                 text: seq % 2 == 0 ? "An earlier reply, number \(seq)." : "An earlier ask, number \(seq).",
                                 at: Date.now.addingTimeInterval(Double(seq - beforeSeq) * 300))
                }
                s.messagesById[threadId] = older + (s.messagesById[threadId] ?? [])
            }
        }
        return newCommand()
    }

    public func registerDevice(apnsToken: String, environment: String, pushKey: String?) async throws {}

    // MARK: Sample data

    /// Made-up threads for the demo (App Review taps "Look around with
    /// sample threads"), the simulator and the screenshots. Nothing in here
    /// is from a real thread, and no real project or app is named:
    /// FakeBackendTests checks for the names that used to be here.
    /// The projects the sample threads are in, with symbols for icons (a
    /// picture would need a URL to fetch; the demo has no backend).
    public static let samplePocket = [
        PocketCard(id: "seeds to pick up", title: "Seeds to pick up", text: "Sweet peas\nRunner beans\nThe small terracotta pots", place: "garden centre", icon: "shopping", source: "Garden planner", updatedAt: "2026-10-20T09:00:00Z"),
        PocketCard(id: "train home", title: "Train home", text: "Booking ABC123\nCoach C, seat 42", icon: "ticket", source: "Trip", updatedAt: "2026-10-21T09:00:00Z"),
        PocketCard(id: "post the parcel", title: "Post the parcel", text: "Sam Taylor\n12 Harbour Street\nBristol BS1 4QA\nUK", icon: "parcel", threadId: "demo_upload", source: "Website", updatedAt: "2026-10-22T09:00:00Z"),
    ]

    public static let sampleProjects = [
        PhoneProject(id: "p_garden", title: "Garden planner", icon: PhoneProjectIcon(symbol: "leaf", by: "librarian")),
        PhoneProject(id: "p_site", title: "Website", icon: PhoneProjectIcon(symbol: "globe", by: "librarian")),
    ]

    static func sample(now: Date) -> (threads: [PhoneThread], messages: [String: [PhoneMessage]], schedules: [PhoneSchedule]) {
        func ago(_ minutes: Double) -> Date { now.addingTimeInterval(-minutes * 60) }
        let garden = [ProjectRef(id: "p_garden", title: "Garden planner")]
        let site = [ProjectRef(id: "p_site", title: "Website")]
        let threads = [
            PhoneThread(threadId: "a1", title: "Release 1.2 of the garden app", cwd: "~/code/garden-planner", status: .waiting,
                        needsYou: true, preview: "Everything passes. Ready to tag 1.2.0 and push it.",
                        lastActivityAt: ago(4), projects: garden,
                        pendingApproval: .approval(id: "ap1", name: "Bash", title: "Run a command",
                                                   options: [.allow, .allowAlways, .deny],
                                                   inputSummary: "git tag v1.2.0 && git push origin v1.2.0"),
                        links: [PhoneLink(title: "Website", url: "https://example.com/", icon: "safari"),
                                PhoneLink(title: "App Store Connect", url: "https://appstoreconnect.apple.com/apps", icon: "app.badge")]),
            PhoneThread(threadId: "a2", title: "Where should the settings live?", cwd: "~/code/garden-planner",
                        status: .waiting, needsYou: true, preview: "Two ways to do this.", lastActivityAt: ago(12),
                        projects: garden,
                        pendingApproval: .question(id: "q1", questions: [
                            Question(question: "Where should each person's settings live?", header: "Settings", options: [
                                .init(label: "In the database", description: "Follows them to a new phone"),
                                .init(label: "On the phone", description: "Simplest, nothing to sync"),
                            ]),
                        ])),
            PhoneThread(threadId: "a3", title: "Date picker on small screens", cwd: "~/code/website",
                        needsYou: true, unread: true,
                        preview: "Fixed in 4700e57. The picker fits on the smallest iPhone now.",
                        lastActivityAt: ago(25), costUsd: 1.84, projects: site, earliestSeq: 1,
                        asks: [PhoneAsk(action: "Ship the fix to the website now?",
                                        why: "It's on a preview while you look. I'll merge and deploy once you say so.",
                                        options: ["Ship it", "Not yet"], suggested: 0,
                                        links: [PhoneAskLink(title: "See the preview", url: "https://example.com")])],
                        asksSeq: 126),
            PhoneThread(threadId: "a4", title: "Tidy up old feature flags", cwd: "~/code/api",
                        preview: "Removed six flags nothing reads any more.", lastActivityAt: ago(190),
                        next: ["Remove the flag helpers too"]),
            PhoneThread(threadId: "a5", title: "Search box for the docs", cwd: "~/code/website", status: .running,
                        preview: "Adding the index.", lastActivityAt: ago(1), projects: site,
                        working: "Running npm test"),
            PhoneThread(threadId: "a6", title: "Upgrade the router", cwd: "~/code/website",
                        preview: "Picked the next three pages to move.", lastActivityAt: ago(60 * 20),
                        snoozedUntil: now.addingTimeInterval(3600 * 14)),
            PhoneThread(threadId: "a7", title: "Rename the settings screen", cwd: "~/code/garden-planner",
                        preview: "Done.", lastActivityAt: ago(60 * 30), archivedAt: ago(60 * 26)),
            // Booked itself a look tomorrow morning: it waits under Waiting.
            PhoneThread(threadId: "a8", title: "Watch the nightly build", cwd: "~/code/api",
                        preview: "All green tonight. I'll look again in the morning.", lastActivityAt: ago(45),
                        needs: "nothing"),
        ]
        let schedules = [
            PhoneSchedule(id: "s1", title: "Check the nightly build", whenText: "Every day at 8:00", threadId: "a8",
                          nextRunAt: now.addingTimeInterval(3600 * 9)),
        ]
        let messages: [String: [PhoneMessage]] = [
            "a1": [
                PhoneMessage(seq: 1, role: .user, text: "Get 1.2 ready to release", at: ago(30)),
                PhoneMessage(seq: 2, role: .tool, text: "Read CHANGELOG.md", toolKind: "read", at: ago(29)),
                PhoneMessage(seq: 3, role: .tool, text: "Bump the version to 1.2.0", toolKind: "command", at: ago(28)),
                PhoneMessage(seq: 4, role: .tool, text: "Edited CHANGELOG.md", toolKind: "edit", at: ago(27)),
                PhoneMessage(seq: 5, role: .tool, text: "Run the unit tests", toolKind: "command", at: ago(12)),
                PhoneMessage(seq: 6, role: .assistant, text: "Bumped the version to **1.2.0** and wrote up the changelog. All 214 tests pass.\n\nReady to tag 1.2.0 and push it.", at: ago(4)),
            ],
            "a2": [
                PhoneMessage(seq: 1, role: .user, text: "Let people pick metric or imperial in settings", at: ago(15)),
            ],
            "a3": [
                PhoneMessage(seq: 120, role: .user, text: "The date picker gets cut off on small phones, like this [Picture 1]. Can you fix it?", at: ago(50)),
                PhoneMessage(seq: 121, role: .tool, text: "Read src/DatePicker.tsx", toolKind: "read", at: ago(48)),
                PhoneMessage(seq: 122, role: .tool, text: "Edited src/DatePicker.tsx", toolKind: "edit", at: ago(40)),
                PhoneMessage(seq: 123, role: .assistant, text: "That fits now. Checking the other sizes.", at: ago(38)),
                PhoneMessage(seq: 124, role: .tool, text: "Screenshot at three phone sizes", toolKind: "command", at: ago(30)),
                PhoneMessage(seq: 125, role: .tool, text: "threadbear: end_turn", toolKind: "mcp", at: ago(25)),
                PhoneMessage(seq: 126, role: .assistant, text: "- Fixed in `4700e57`: the [picker fits](work:Edited src/DatePicker.tsx) on the smallest iPhone now\n- [Checked it in the simulator](work:Screenshot at three phone sizes) at three sizes\n- The [nightly build](thread:a8) is still green", summary: true, at: ago(25)),
            ],
            "a4": [
                PhoneMessage(seq: 1, role: .user, text: "Get rid of the feature flags nothing uses", turn: "f1", at: ago(200)),
                PhoneMessage(seq: 2, role: .tool, text: "Searched for isEnabled(", toolKind: "search", turn: "f1", at: ago(199)),
                PhoneMessage(seq: 3, role: .tool, text: "Edited src/flags.ts", toolKind: "edit", turn: "f1", at: ago(198)),
                PhoneMessage(seq: 4, role: .assistant, text: "Removed six flags. The full test run takes a while, so I've left it going and will look when it's done.", turn: "f1", at: ago(197)),
                // A wake-up as the test run finished: the divider marks the wait.
                PhoneMessage(seq: 5, role: .tool, text: "Read the test output", toolKind: "read", turn: "f2", wokeBy: [WokeTask(kind: "shell", description: "Run the full test suite")], at: ago(190)),
                PhoneMessage(seq: 6, role: .assistant, text: "All 214 tests pass with the flags gone.", turn: "f2", at: ago(190)),
            ],
            "a5": [
                PhoneMessage(seq: 1, role: .user, text: "Okay, let's go with it.", at: ago(8)),
            ],
            "a6": [
                PhoneMessage(seq: 1, role: .user, text: "Review: Router upgrade order (0f3c2a9e-5b1d-4e7a-9c64-2d8b1f0a7e35)\n\nPicked B. B: docs pages first.\n\nNotes on B (B: docs pages first): Leave the search page till last.", at: ago(60 * 21)),
                PhoneMessage(seq: 2, role: .assistant, text: "Going with the docs pages first, search last. Picked the next three pages to move.", at: ago(60 * 20)),
            ],
            "a8": [
                PhoneMessage(seq: 1, role: .user, text: "Keep an eye on the nightly build this week", at: ago(50)),
                PhoneMessage(seq: 2, role: .tool, text: "Read the build log", toolKind: "read", at: ago(48)),
                PhoneMessage(seq: 3, role: .assistant, text: "All green tonight. I'll look again in the morning.", at: ago(45)),
                // Another thread's agent writing in: drawn as a card, not Mike's bubble.
                PhoneMessage(seq: 4, role: .user, text: "[Sent by the agent in the thread \"Upgrade the router\" (a6)]\nThe router upgrade lands tonight and changes the build config. Watch for a slower build.", at: ago(44)),
                PhoneMessage(seq: 5, role: .assistant, text: "Noted. I'll compare tonight's build time with last week's.", at: ago(43)),
            ],
        ]
        return (threads, messages, schedules)
    }
}
