import SwiftUI
import ThreadbearKit

struct ThreadView: View {
    @Environment(AppModel.self) private var model
    @Environment(QuickAskModel.self) private var quick
    @Environment(\.dismiss) private var dismiss
    /// In a quick ask's thread, the keyboard's been asked for in place of the big mic.
    @State private var typing = false
    let threadId: String
    @State private var detail: ThreadDetail?
    @State private var loaded = false
    @State private var draft = ""
    /// The last command sent from here, until the runner has taken it.
    @State private var sent: (id: String, status: CommandStatus?)?
    /// From API 57: every message from the phone the runner hasn't applied
    /// yet, from here or another phone, each shown dimmed with a Cancel.
    @State private var waiting: [WaitingSend] = []
    /// Cancels on their way, so the button can't be tapped twice.
    @State private var cancelling: Set<String> = []
    /// Ones that have left the waiting list, kept faded as "Sending…" until
    /// their message is in the transcript (30 s at most), as the transcript
    /// can come a moment later, or until settle() finds they failed.
    @State private var gone: [WaitingSend] = []
    @State private var hibernateTarget: PhoneThread?
    @State private var markedSeen = false
    /// The oldest seq when "Load earlier" was tapped, until older messages
    /// arrive (the oldest seq changes) or the runner says it couldn't.
    /// (A backend before API 2.)
    @State private var loadingBefore: Int?
    /// From API 2: the newest `limit` messages and tool lines, from Convex.
    @State private var page: MessagePage?
    @State private var limit = ThreadView.firstPage
    /// The rows on screen when older ones were asked for, to stay on once they
    /// arrive above them.
    @State private var keepAbove: [Int]?
    /// Answers picked on the open card of asks (ask index to choice), until
    /// they're sent; the composer sends them along with what's typed.
    @State private var picks: [Int: Int] = [:]
    @State private var pickedFor: Double?
    /// Follow-ups ticked on the done card, and the reply it's under.
    @State private var nextPicks: Set<Int> = []
    @State private var nextPickedFor: Int?
    /// A card's answer is on its way to the backend: it spins and can't be
    /// pressed again. Uploading first can take a while.
    @State private var sendingCard = false
    /// That answer's command, watched to its end, as an older backend's
    /// refusal comes after `taken`, when `sent` has already gone.
    @State private var answeredCommand: String?
    /// The card of asks, and the reply under a done card, that's been answered
    /// from here. `sent` goes when the runner takes the message, which is before
    /// the thread's row says so, and the card coming back live for that moment
    /// could be pressed twice.
    @State private var answeredAsks: Double?
    @State private var answeredDone: Int?
    /// The working a work: link opened.
    @State private var workLink: ThreadLinks.Hit?
    @Environment(\.pushThread) private var pushThread
    static let firstPage = 80
    static let morePerPage = 200

    var body: some View {
        Group {
            if let detail {
                content(detail)
            } else if loaded {
                ContentUnavailableView("This thread's gone", systemImage: "questionmark.folder",
                                       description: Text("It may have been deleted on the Mac."))
            } else {
                ProgressView()
            }
        }
        .navigationTitle(detail?.thread.title ?? "")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            if let thread = detail?.thread {
                // The Mac's header: the project's icon (or a folder) before the title.
                ToolbarItem(placement: .principal) {
                    HStack(spacing: 6) {
                        ProjectIconView(project: thread.projects?.first.flatMap { model.project($0.id) }, title: thread.projects?.first?.title, size: 20)
                        Text(thread.title.isEmpty ? "Untitled" : thread.title)
                            .font(.headline)
                            .lineLimit(1)
                    }
                    .accessibilityElement(children: .combine)
                }
                menu(thread)
            }
        }
        .hibernateDialog(for: $hibernateTarget, leaving: { dismiss() })
        // model.connection in each id: a fresh Convex client after the app
        // comes back from the background, so these follow it, not the old one.
        .task(id: "\(threadId):\(model.connection)") { await follow() }
        .task(id: "\(threadId):\(limit):\(model.hasMessagePages):\(model.connection)") { await followMessages() }
        .task(id: "\(sent?.id ?? ""):\(model.connection)") { await followCommand() }
        .task(id: answeredCommand) {
            guard let id = answeredCommand, let status = await model.commandOutcome(id), status.state == .failed,
                  answeredCommand == id else { return }
            // Refused, even after the runner took it: its card comes back.
            answeredAsks = nil
            answeredDone = nil
        }
        .task(id: "\(threadId):\(model.canSeeWaiting):\(model.connection)") { await followWaiting() }
    }

    private func content(_ detail: ThreadDetail) -> some View {
        let thread = detail.thread
        // From API 2 the page from phone:messages (tool lines included);
        // until it arrives, and on an older backend, phone:thread's messages.
        let messages = page?.messages ?? detail.messages
        let items = Turns.fold(messages, busy: thread.isBusy)
        let pictures = ThreadPictures(page?.images ?? [])
        let pins = pictures.pinned(in: items)
        let paged = model.hasMessagePages && page != nil
        let canLoadMore = paged ? page?.hasMore == true : thread.hasEarlier(than: detail.messages.first?.seq)
        // Paged: a bigger page has been asked for and hasn't arrived yet.
        let loadingMore = paged ? (page?.hasMore == true && messages.count < limit) : loadingBefore == detail.messages.first?.seq
        return ScrollViewReader { proxy in
            ScrollView {
                // Not a LazyVStack. Opening a long thread left the screen blank
                // until a scroll, on the phone (1 Nov): a lazy stack guesses the
                // height of rows it hasn't built and works out which to build
                // from that, and these rows run from one line to several
                // screens. Here every row is measured, so the bottom anchor is
                // always on something real. A page is a few dozen rows once
                // folded, and pictures wait until they're on screen.
                VStack(alignment: .leading, spacing: 14) {
                    if canLoadMore {
                        EarlierButton(loading: loadingMore, fromMac: !paged) {
                            keepAbove = items.map(\.id)
                            loadMore(thread, detail: detail, paged: paged)
                        }
                        // Scrolling up to it loads by itself, like any chat.
                        // Not on a short thread, where it's on screen at
                        // once and nobody asked. Rows, not messages: one long
                        // finished turn is dozens of messages folded into a
                        // line, and loading more threw the view off its reply.
                        // Not onAppear, which a VStack fires straight away
                        // wherever the row is.
                        .onScrollVisibilityChange { visible in
                            guard visible, items.count >= 20 else { return }
                            keepAbove = items.map(\.id)
                            loadMore(thread, detail: detail, paged: paged)
                        }
                    }
                    ForEach(items) { item in
                        switch item {
                        case let .message(message): MessageView(message: message, pinned: pins.under[message.seq] ?? [])
                        case let .tools(run): ToolRunView(items: run)
                        case let .worked(worked): WorkedView(worked: worked)
                        case let .gap(gap): GapView(gap: gap)
                        }
                    }
                    ForEach(pins.trailing) { PinnedPicture(image: $0) }
                    let offline = model.offlineRunner(of: thread)
                    let shown = WaitingSends.shown(waiting + gone, messages: messages)
                    ForEach(shown) { send in
                        // Why they're waiting goes under the last one only, not repeated down the column.
                        WaitingMessageView(send: send, offlineRunner: offline, says: send.id == shown.last?.id,
                                           cancelling: cancelling.contains(send.id)) { cancel(send) }
                    }
                    if let pending = thread.pendingApproval {
                        PendingCard(threadId: thread.threadId, runnerId: thread.runnerId, pending: pending) { sent = ($0, nil) }
                            // Its own state per question: a tapped button doesn't carry over to the next.
                            .id(pending.id)
                            .transition(Juice.cardGoes)
                    } else if thread.isBusy || thread.working != nil {
                        WorkingLine(text: thread.working)
                            .id("working:\(thread.status == .running)")
                    } else if let asks = thread.asks, !asks.isEmpty, showsAsks(thread) {
                        AsksCard(asks: asks, picks: $picks, busy: sendingCard) {
                            sendCard(thread, lastSeq: messages.last?.seq)
                        }
                        .onChange(of: thread.asksSeq, initial: true) {
                            // A new card starts with nothing picked.
                            if pickedFor != thread.asksSeq { picks = [:]; pickedFor = thread.asksSeq }
                        }
                        .transition(Juice.cardGoes)
                    } else if thread.status == .error {
                        Label("The last turn failed. Send a message to try again.", systemImage: "exclamationmark.triangle")
                            .font(.subheadline)
                            .foregroundStyle(.secondary)
                    } else if isDone(thread, messages: messages) {
                        // Ticked follow-ups go from the card's Send on their
                        // own; anything typed stays in the box for later.
                        DoneCard(next: thread.next ?? [], picked: $nextPicks, busy: sendingCard) {
                            sendCard(thread, lastSeq: messages.last?.seq)
                        } archive: {
                            archive()
                        }
                        .onChange(of: messages.last?.seq, initial: true) {
                            // A new reply's card starts with nothing ticked.
                            if nextPickedFor != messages.last?.seq { nextPicks = []; nextPickedFor = messages.last?.seq }
                        }
                        .transition(Juice.cardGoes)
                    }
                    if let note = sentNote {
                        Text(note).font(.footnote).foregroundStyle(.secondary).frame(maxWidth: .infinity, alignment: .trailing)
                    }
                    Color.clear.frame(height: 1).id("bottom")
                }
                .padding(.horizontal)
                .padding(.top, 8)
                // Only when the card changes: the rest of what comes in just appears.
                .animation(Juice.card, value: cardShowing(thread, messages: messages))
            }
            .defaultScrollAnchor(.bottom)
            .scrollDismissesKeyboard(.interactively)
            .environment(\.threadPictures, pictures)
            .environment(\.picturesWaitUntilSeen, true)
            .environment(\.threadLink) { url, seq in follow(url, from: seq, in: items) }
            .environment(\.buttonThreadId, threadId)
            .sheet(item: $workLink) { WorkingSheet(link: $0).environment(\.threadPictures, pictures) }
            .onChange(of: messages.last?.seq) { proxy.scrollTo("bottom", anchor: .bottom) }
            // The first page takes over from phone:thread's newest text
            // messages, usually at a different height. Stay on the newest.
            .onChange(of: page != nil) { proxy.scrollTo("bottom", anchor: .bottom) }
            // Older rows have arrived above: back to the row that was at the
            // top. The first one still here, as a turn cut off by the page's
            // edge gets a new id once more of it has come.
            .onChange(of: items.first?.id) {
                guard let keep = keepAbove else { return }
                keepAbove = nil
                let now = Set(items.map(\.id))
                if let row = keep.first(where: now.contains) { proxy.scrollTo(row, anchor: .top) }
            }
            // A voice follow-up's reply is read out once the turn's over, so it's the answer and
            // not a line the agent wrote on the way.
            .onChange(of: "\(messages.last?.seq ?? 0):\(thread.isBusy)", initial: true) {
                guard !thread.isBusy, let reply = messages.last(where: { $0.role == .assistant }) else { return }
                quick.replyArrived(in: threadId, seq: reply.seq, text: reply.text)
            }
            .safeAreaInset(edge: .bottom) {
                if quick.voiceThreadId == threadId, !typing {
                    VoiceBar(threadId: threadId, afterSeq: messages.last?.seq ?? 0, working: thread.isBusy) { typing = true }
                } else {
                    Composer(text: $draft, placeholder: composerPlaceholder(thread), links: thread.links ?? []) { text, photos in
                        await send(text, photos: photos, to: thread)
                    }
                }
            }
        }
    }

    /// A link in a message. A work: link opens the turn's working over the
    /// thread with the step lit. The Mac opens it in place; on this small
    /// screen a sheet leaves your place in the reply alone. A review only opens
    /// on the Mac, so that one says so rather than doing nothing.
    private func follow(_ url: URL, from seq: Int?, in items: [ThreadItem]) -> OpenURLAction.Result {
        switch ThreadLinks.target(of: url) {
        case nil:
            // A relative link (`[plan](shorts-plan/candidates.md)`) is a
            // file in the thread's folder on the Mac; iOS can't open it.
            guard url.scheme != nil, !url.isFileURL else {
                model.report(TransportError.server("That file opens on the Mac."))
                return .handled
            }
            // A web page, or another app's link only once Mike says yes.
            return LinkGate.shared.decide(url)
        case let .thread(id):
            // Agents may give only the start of the id.
            pushThread(model.inbox.first { $0.threadId.hasPrefix(id) }?.threadId ?? id)
        case .review:
            model.report(TransportError.server("That review opens on the Mac."))
        case let .button(id):
            // One partway through a line, drawn as a link (ReplyButtons.trailing
            // only takes the ones at the end). An id the row doesn't carry is
            // just its words.
            let buttons = (page?.messages ?? detail?.messages ?? []).first { $0.seq == seq }?.buttons ?? []
            guard let button = buttons.first(where: { $0.id == id }) else { return .discarded }
            model.tap(button, in: threadId, pushThread: pushThread)
        case let .step(quote):
            guard let hit = ThreadLinks.find(quote: quote, from: seq, in: items) else { return .discarded }
            workLink = hit
        }
        return .handled
    }

    /// "Waiting for the Mac" while a command sits in the queue, so a
    /// message sent with the lid shut doesn't look lost. From API 57 the
    /// waiting messages say that themselves, so this is only for a failure.
    private var sentNote: String? {
        guard let sent else { return nil }
        switch sent.status?.state {
        // An answer to a card is tracked here too, so a failure always shows.
        case .failed: return "Didn't go through: \(sent.status?.note ?? "the runner refused it")"
        case .done, .taken: return nil
        default:
            // Each waiting message says how it's getting on itself.
            if model.canSeeWaiting { return nil }
            guard let thread = detail?.thread, let name = model.offlineRunner(of: thread) else { return "Sending…" }
            return "Waiting for \(name) to come back"
        }
    }

    /// Says the runner's offline before anything's typed, so it's no
    /// surprise that the message waits.
    private func composerPlaceholder(_ thread: PhoneThread) -> String {
        if let name = model.offlineRunner(of: thread) { return "\(name) is offline, this will wait" }
        return thread.isBusy ? "Steer the agent" : "Reply"
    }

    private func followWaiting() async {
        guard model.canSeeWaiting, let backend = model.backend else { waiting = []; return }
        do {
            for try await list in backend.waiting(threadId) {
                // Off the list: done, failed, or cancelled from another phone.
                // One being cancelled here is this phone's own doing.
                let left = waiting.filter { old in !list.contains { $0.id == old.id } && !cancelling.contains(old.id) }
                // Kept in place while settle() finds out which, so it doesn't blink out.
                gone += left.map { var s = $0; s.state = .taken; return s }
                waiting = list
                for send in left { Task { await settle(send) } }
            }
        } catch {
            model.report(error)
        }
    }

    /// How a send that's left the waiting list ended. Done: it stays faded
    /// until its message is in the transcript. Failed after the runner took
    /// it (a photo it couldn't fetch, the thread gone): say why and put the
    /// words back in the box, rather than letting it vanish.
    private func settle(_ send: WaitingSend) async {
        var status: CommandStatus?
        if let backend = model.backend {
            do {
                for try await value in backend.command(send.commandId) { status = value; break }
            } catch {}
        }
        if status?.state == .failed {
            gone.removeAll { $0.id == send.id }
            // Refused after the runner took it: a card it answered comes back.
            answeredAsks = nil
            answeredDone = nil
            guard status?.note != "Cancelled" else { return }
            // The last one sent from here already says so under the transcript.
            if sent?.id != send.commandId {
                model.report(TransportError.server("Didn't go through: \(status?.note ?? "the runner refused it")"))
            }
            if draft.isEmpty { draft = send.text }
            return
        }
        // Done (or unreadable, pruned while the phone was away): until its
        // message is in the transcript, which takes it out of `shown` first.
        try? await Task.sleep(for: .seconds(30))
        gone.removeAll { $0.id == send.id }
    }

    /// Takes a waiting message back. Its words go back in the box if that's
    /// empty, so a change of mind is an edit rather than typing it again.
    private func cancel(_ send: WaitingSend) {
        guard let backend = model.backend, !cancelling.contains(send.id) else { return }
        cancelling.insert(send.id)
        Task {
            defer { cancelling.remove(send.id) }
            do {
                if try await backend.cancel(send.commandId) {
                    // Gone from the list straight away rather than on the next update.
                    waiting.removeAll { $0.id == send.id }
                    if sent?.id == send.commandId { sent = nil }
                    // Taken back, so a card it answered is there again.
                    answeredAsks = nil
                    answeredDone = nil
                    if draft.isEmpty { draft = send.text }
                } else {
                    model.report(TransportError.server("Too late to cancel: it's already gone to the Mac."))
                }
            } catch {
                model.report(error)
            }
        }
    }

    @ToolbarContentBuilder private func menu(_ thread: PhoneThread) -> some ToolbarContent {
        ToolbarItem(placement: .topBarTrailing) {
            Menu {
                if thread.archivedAt != nil {
                    Button { change(.unarchive) } label: { Label("Back to the inbox", systemImage: "tray.and.arrow.up") }
                } else {
                    if thread.snoozedUntil != nil || thread.snoozedUntilRestart == true {
                        Button { change(.wake) } label: { Label("Wake", systemImage: "sun.max") }
                    } else {
                        Button { hibernateTarget = thread } label: { Label("Hibernate…", systemImage: "moon.zzz") }
                    }
                    Button { archive() } label: { Label("Archive", systemImage: "archivebox") }
                    if model.canStar {
                        let starred = thread.starredAt != nil
                        Button { change(.star(!starred)) } label: {
                            Label(starred ? "Remove Star" : "Star", systemImage: starred ? "star.slash" : "star")
                        }
                    }
                }
                Section {
                    // To point another thread at this one: pasted into a
                    // message here or on the Mac, it goes in as a link to it.
                    Button { UIPasteboard.general.string = thread.threadId } label: { Label("Copy Thread ID", systemImage: "number") }
                }
                Section {
                    Label(thread.cwd, systemImage: "folder")
                    Label([thread.accountId, thread.model].compactMap { $0 }.joined(separator: " · "), systemImage: "person.crop.circle")
                    if let cost = thread.costUsd, cost > 0 {
                        Label(String(format: "$%.2f so far", cost), systemImage: "dollarsign.circle")
                    }
                }
            } label: {
                Image(systemName: "ellipsis.circle")
            }
        }
    }

    private func follow() async {
        guard let backend = model.backend else { return }
        // A thread made from the phone can open a moment before the Mac has
        // written its row. Until it's been seen once, "not found" means "not
        // yet": ask again each second for a while before calling it gone.
        var waited = 0
        do {
            while !Task.isCancelled {
                for try await value in backend.thread(threadId) {
                    if value == nil, detail == nil, waited < 15 { continue }
                    detail = value
                    loaded = true
                    if let thread = value?.thread, thread.unread || thread.needsYou, !InboxSections.needsAnswer(thread), !markedSeen {
                        // Opening it reads it, as on the Mac. Once per visit, so a
                        // reply arriving while it's open is read too but not spammed.
                        markedSeen = true
                        _ = try? await backend.update(threadId: threadId, change: .markSeen)
                    } else if value?.thread.unread == false {
                        markedSeen = false
                    }
                }
                guard !loaded else { return }
                waited += 1
                try? await Task.sleep(for: .seconds(1))
            }
        } catch {
            model.report(error)
        }
    }

    /// API 2: the thread's newest `limit` messages, live from Convex.
    private func followMessages() async {
        guard model.hasMessagePages, let backend = model.backend else { return }
        do {
            for try await value in backend.messages(threadId, limit: limit) { page = value }
        } catch {
            model.report(error)
        }
    }

    /// Older messages: from API 2 a bigger page from Convex (works with the
    /// Mac asleep); before that, the runner pages them in.
    private func loadMore(_ thread: PhoneThread, detail: ThreadDetail, paged: Bool) {
        if paged {
            guard let page, page.hasMore, page.messages.count >= limit else { return }
            limit += ThreadView.morePerPage
        } else {
            loadEarlier(thread, before: detail.messages.first?.seq)
        }
    }

    private func followCommand() async {
        guard let id = sent?.id, let backend = model.backend else { return }
        do {
            for try await status in backend.command(id) {
                guard sent?.id == id else { return }
                sent?.status = status
                if status?.state == .failed {
                    // Its card comes back, with why under it.
                    answeredAsks = nil
                    answeredDone = nil
                }
                if status?.state == .done || status?.state == .taken { sent = nil; return }
            }
        } catch {}
    }

    /// Nothing's on its way that would replace a card. A refused one doesn't
    /// count: it says why under the transcript, and the card's there to try again.
    private var nothingOnItsWay: Bool {
        (sent == nil || sent?.status?.state == .failed) && waiting.isEmpty
    }

    private func showsAsks(_ thread: PhoneThread) -> Bool {
        nothingOnItsWay && (answeredAsks == nil || answeredAsks != thread.asksSeq)
    }

    /// A finished turn that needs nothing from Mike: the done card's place.
    private func isDone(_ thread: PhoneThread, messages: [PhoneMessage]) -> Bool {
        thread.status == .idle && !thread.needsYou && thread.archivedAt == nil && thread.working == nil
            && messages.last?.role == .assistant && nothingOnItsWay
            && (answeredDone == nil || answeredDone != messages.last?.seq)
    }

    /// Which card is showing, so it's only that changing that animates.
    private func cardShowing(_ thread: PhoneThread, messages: [PhoneMessage]) -> String {
        if let pending = thread.pendingApproval { return pending.id }
        if thread.isBusy || thread.working != nil { return "working" }
        if !(thread.asks ?? []).isEmpty, showsAsks(thread) { return "asks" }
        return isDone(thread, messages: messages) ? "done" : "none"
    }

    /// A tap on a card of asks' answer, or Send on either card. Spinning from
    /// the tap, and a single ask's chip goes back if it couldn't be sent.
    private func sendCard(_ thread: PhoneThread, lastSeq: Int?) {
        guard !sendingCard else { return }
        sendingCard = true
        Task {
            // No deadline here, unlike an approval: a second tap after one
            // would send the message twice, as nothing on the backend joins
            // them up. Leaving the thread and coming back resets it.
            defer { sendingCard = false }
            if await send("", to: thread) {
                answeredAsks = thread.asksSeq
                answeredDone = lastSeq
                answeredCommand = sent?.id
            } else if thread.asks?.count == 1 {
                picks = [:]
            }
        }
    }

    /// Sends what's typed, with any answers picked on the card of asks
    /// before it (the Mac's one message: each picked ask, then the rest),
    /// or the follow-ups ticked on the done card.
    private func send(_ text: String, photos: [PickedPhoto] = [], to thread: PhoneThread) async -> Bool {
        guard let backend = model.backend else { return false }
        let asks = thread.asks ?? []
        let answers = AskAnswer.answers(asks: asks, picks: picks).map(\.answer)
        let next = thread.next ?? []
        // Only while the card they were ticked on is the last reply's.
        let lastSeq = (page?.messages ?? detail?.messages)?.last?.seq
        let followUps = nextPickedFor == lastSeq ? next.indices.filter { nextPicks.contains($0) }.map { next[$0] } : []
        let message = !followUps.isEmpty ? AskAnswer.followUpMessage(followUps, extra: text)
            : answers.isEmpty ? text : AskAnswer.message(asks: asks, picks: picks, extra: text)
        guard !message.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || !photos.isEmpty else { return false }
        do {
            let images = try await model.upload(photos)
            let id = try await backend.send(threadId: thread.threadId, text: message, answers: answers, images: images)
            model.sent(photos)
            sent = (id, nil)
            picks = [:]
            nextPicks = []
            return true
        } catch {
            model.report(error)
            return false
        }
    }

    private func loadEarlier(_ thread: PhoneThread, before seq: Int?) {
        guard let seq, let backend = model.backend, loadingBefore != seq else { return }
        loadingBefore = seq
        Task {
            do {
                let id = try await backend.loadEarlier(threadId: thread.threadId, beforeSeq: seq)
                // The messages turn up in the thread's own query; this only
                // watches for a failure, or the Mac being asleep.
                for try await status in backend.command(id) {
                    if status?.state == .failed {
                        model.report(TransportError.server(status?.note ?? "The Mac couldn't send older messages."))
                        loadingBefore = nil
                        return
                    }
                    if status?.state == .done { break }
                }
            } catch {
                model.report(error)
            }
            // Done (or gone): if nothing older arrived, let it be tapped again.
            try? await Task.sleep(for: .seconds(2))
            if loadingBefore == seq { loadingBefore = nil }
        }
    }

    /// Back to the inbox, where the thread's row slides away.
    private func archive() {
        model.archive(threadId, leavingThread: true)
        dismiss()
    }

    private func change(_ change: ThreadChange) {
        Task {
            guard let backend = model.backend else { return }
            do { _ = try await backend.update(threadId: threadId, change: change) } catch { model.report(error) }
        }
    }
}

/// The bottom of a quick ask's thread: a big mic for a follow-up out loud, in place of the text
/// box (which the keyboard button brings back). What you say goes to the agent when you stop, and
/// its answer is read out when its turn ends. Tap while it's talking to stop it.
private struct VoiceBar: View {
    @Environment(QuickAskModel.self) private var quick
    let threadId: String
    let afterSeq: Int
    let working: Bool
    var showKeyboard: () -> Void

    private var listening: Bool { quick.phase == .listening && quick.listeningFor == threadId }

    var body: some View {
        VStack(spacing: 10) {
            if listening {
                Text(quick.transcript.isEmpty ? "Listening" : quick.transcript)
                    .font(.title3.weight(.medium))
                    .foregroundStyle(quick.transcript.isEmpty ? .tertiary : .primary)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, 24)
                    .animation(.easeOut(duration: 0.12), value: quick.transcript)
            } else if let note = note {
                Text(note).font(.footnote).foregroundStyle(.secondary)
            }
            HStack {
                Button(action: showKeyboard) {
                    Image(systemName: "keyboard")
                        .font(.system(size: 17))
                        .foregroundStyle(.secondary)
                        .frame(width: 44, height: 44)
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Type instead")
                Spacer()
                Button(action: tap) {
                    ZStack {
                        if listening {
                            Circle().fill(Color.accentColor.opacity(0.14)).frame(width: 66, height: 66)
                                .scaleEffect(1.15 + quick.level * 0.6)
                        }
                        Circle().fill(Color.accentColor).frame(width: 66, height: 66)
                        Image(systemName: listening ? "waveform" : quick.isSpeaking ? "stop.fill" : "mic.fill")
                            .font(.system(size: 26, weight: .semibold))
                            .foregroundStyle(.white)
                    }
                    .frame(width: 110, height: 90)
                    .animation(.easeOut(duration: 0.12), value: quick.level)
                }
                .buttonStyle(.plain)
                .accessibilityLabel(listening ? "Send" : quick.isSpeaking ? "Stop talking" : "Ask a follow-up")
                Spacer()
                // Balances the keyboard button, so the mic sits in the middle.
                Color.clear.frame(width: 44, height: 44)
            }
            .padding(.horizontal)
        }
        .padding(.top, 8)
        .background(.bar)
    }

    /// Plain words for what's going on, when it isn't obvious from the thread.
    private var note: String? {
        if let problem = quick.followUpProblem { return "Didn't go through: \(problem)" }
        if case .idle(let notice?) = quick.phase { return notice }
        if quick.followUpSending { return "Sending…" }
        if quick.awaitingReply?.threadId == threadId, !working { return "Sent. The answer will be read out." }
        return nil
    }

    private func tap() {
        if listening {
            quick.micButton()
        } else if quick.isSpeaking {
            quick.stopSpeakingReply()
        } else {
            quick.listenForFollowUp(in: threadId, afterSeq: afterSeq)
        }
    }
}

/// At the top of a thread: older messages, from Convex (API 2) or from the
/// Mac on request (before).
struct EarlierButton: View {
    @Environment(AppModel.self) private var model
    var loading: Bool
    var fromMac = true
    var action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: 8) {
                if loading { ProgressView().controlSize(.small) }
                Text(loading ? (fromMac && model.offlineText != nil ? "Waiting for the Mac to wake up" : "Loading…") : "Load earlier messages")
            }
            .font(.footnote)
            .frame(maxWidth: .infinity)
            .padding(.vertical, 6)
        }
        .buttonStyle(.borderless)
        .disabled(loading)
    }
}

/// A message the runner hasn't taken yet: the bubble dimmed, and under it
/// why it's waiting and a Cancel while it can still be stopped.
struct WaitingMessageView: View {
    var send: WaitingSend
    var offlineRunner: String?
    /// Whether the line says why it's waiting (the last one), or only has its Cancel.
    var says = true
    var cancelling: Bool
    var cancel: () -> Void

    var body: some View {
        VStack(alignment: .trailing, spacing: 4) {
            MessageView(message: PhoneMessage(seq: -1, role: .user, text: text, at: Date(timeIntervalSince1970: send.createdAt / 1000)))
                .opacity(0.55)
            HStack(spacing: 5) {
                if says || !send.canCancel {
                    Image(systemName: offlineRunner != nil && send.canCancel ? "clock" : "arrow.up.circle")
                    Text(WaitingSends.note(send, offlineRunner: offlineRunner))
                    if send.canCancel { Text("·") }
                }
                if send.canCancel {
                    if cancelling {
                        ProgressView().controlSize(.mini)
                    } else {
                        Button("Cancel", action: cancel)
                            .buttonStyle(.borderless)
                            // The one thing on the line to tap.
                            .foregroundStyle(.tint)
                            .accessibilityHint("Takes this message back before it's sent")
                    }
                }
            }
            .font(.caption)
            .foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity, alignment: .trailing)
    }

    private var text: String { WaitingSends.mirrored(send) }
}

struct MessageView: View {
    var message: PhoneMessage
    /// Pictures the agent pinned during the turn this replies to.
    var pinned: [MessageImage] = []
    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.displayScale) private var displayScale

    var body: some View {
        switch message.role {
        case .user where message.agentHeader != nil:
            AgentMessageCard(header: message.agentHeader!, seq: message.seq)
        case .user:
            VStack(alignment: .trailing, spacing: 4) {
                userText
                    .textSelection(.enabled)
                    .padding(.horizontal, 14)
                    .padding(.vertical, 10)
                    .background(BubbleBackground().clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous)))
                if message.origin == "phone" {
                    PhoneMark()
                } else if let origin = originText {
                    Text(origin).font(.caption2).foregroundStyle(.tertiary)
                }
            }
            .frame(maxWidth: .infinity, alignment: .trailing)
            .padding(.leading, 40)
        case .assistant:
            VStack(alignment: .leading, spacing: 8) {
                MarkdownText(message.text, seq: message.seq, buttons: message.buttons)
                    .textSelection(.enabled)
                ForEach(pinned) { PinnedPicture(image: $0) }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        case .tool:
            ToolRunView(items: [message])
        }
    }

    /// An answer to a review reads as the Mac shows it: the review's icon
    /// and title small, then what he picked and his notes (Mike, 29 Oct).
    @ViewBuilder private var userText: some View {
        if let review = ReviewAnswer.parse(message.text) {
            VStack(alignment: .leading, spacing: 8) {
                ForEach(Array(review.lines.enumerated()), id: \.offset) { i, line in
                    VStack(alignment: .leading, spacing: 2) {
                        // The same symbol as the Mac's review card and button.
                        // A reply under its pick has no label of its own.
                        if i == 0 || !line.label.isEmpty {
                            (i == 0 ? Text("\(Image(systemName: "rectangle.on.rectangle")) \(line.label)") : Text(line.label))
                                .font(.footnote)
                                .foregroundStyle(.secondary)
                        }
                        Text(line.text)
                    }
                }
            }
        } else {
            // Its [Picture N] markers as chips, as the Mac draws them.
            PhotoChip.text(message.text, font: .preferredFont(forTextStyle: .body), traits: UITraitCollection { traits in
                traits.userInterfaceStyle = colorScheme == .dark ? .dark : .light
                traits.displayScale = displayScale
            })
        }
    }

    private var originText: String? {
        switch message.origin {
        case "schedule": "Scheduled"
        case "runner": "From the runner"
        default: nil
        }
    }
}

/// A message an agent wrote, not Mike: another thread's (its send_message
/// or create_thread) or this thread's own before a move. Full width in a
/// quiet card with who sent it on top, as the Mac draws it, so it never
/// reads as his bubble.
struct AgentMessageCard: View {
    var header: AgentHeader
    var seq: Int

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Label {
                Text(from).lineLimit(2)
            } icon: {
                Image(systemName: header.movedTo == nil ? "arrow.turn.down.right" : "folder")
            }
            .font(.footnote)
            .foregroundStyle(.secondary)
            let body = header.body.trimmingCharacters(in: .whitespacesAndNewlines)
            if !body.isEmpty {
                MarkdownText(body, seq: seq)
                    .textSelection(.enabled)
            }
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Look.tile.opacity(0.5), in: RoundedRectangle(cornerRadius: 16, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 16, style: .continuous).strokeBorder(Look.tile))
    }

    private var from: String {
        if let folder = header.movedTo {
            return "Left by this thread's agent when it moved to \((folder as NSString).abbreviatingWithTildeInPath)"
        }
        return "From the agent in \(header.title.isEmpty ? header.threadId : header.title)"
    }
}

/// Under a message sent from the iPhone app: a small phone in place of a
/// line of text, as on the Mac, that says what it means when tapped.
private struct PhoneMark: View {
    @State private var showing = false

    var body: some View {
        Button { showing = true } label: {
            Image(systemName: "iphone")
                .font(.caption2)
                .foregroundStyle(.tertiary)
                .padding(6)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .padding(-6)
        .accessibilityLabel("Sent from the iPhone app")
        .popover(isPresented: $showing) {
            Text("Sent from the iPhone app")
                .font(.footnote)
                .padding(.horizontal, 12)
                .padding(.vertical, 8)
                .presentationCompactAdaptation(.popover)
        }
    }
}

/// Tool calls between two messages: up to three as small lines, more folded
/// into "12 tool calls" that opens to them. What they printed stays on the Mac.
struct ToolRunView: View {
    var items: [PhoneMessage]
    @State private var open = false
    @Environment(\.litStep) private var litStep

    var body: some View {
        if items.count <= 3 {
            lines
        } else {
            DisclosureGroup(isExpanded: $open) {
                lines.padding(.top, 4)
            } label: {
                Text("\(items.count) tool calls")
            }
            .font(.footnote)
            .foregroundStyle(.secondary)
            .tint(.secondary)
            .onChange(of: litStep, initial: true) {
                if items.contains(where: { $0.seq == litStep }) { open = true }
            }
        }
    }

    private var lines: some View {
        VStack(alignment: .leading, spacing: 4) {
            ForEach(items) { item in
                Label {
                    Text(item.text).lineLimit(1).truncationMode(.middle)
                } icon: {
                    Image(systemName: Self.symbol(item.toolKind)).imageScale(.small)
                }
                .font(.footnote)
                .foregroundStyle(.secondary)
                .step(item.seq)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    static func symbol(_ kind: String?) -> String {
        switch kind {
        case "command": "terminal"
        case "read": "doc.text"
        case "edit", "write": "pencil"
        case "search": "magnifyingglass"
        case "web": "globe"
        case "task": "person.2"
        default: "wrench.and.screwdriver"
        }
    }
}

/// Assistant text, block by block from ThreadbearKit's MarkdownBlock, so
/// paragraphs, lists, tables, quotes and code keep their shape as on the
/// Mac; inline markdown inside each.
struct MarkdownText: View {
    let blocks: [MarkdownBlock]
    /// The message's seq, which says which upload a picture's address means.
    var seq: Int?
    /// The reply buttons the message links (backend API 59). Nil: its button
    /// links are just their titles.
    var buttons: [MessageButton]?
    @Environment(\.threadPictures) private var pictures
    @Environment(\.threadLink) private var threadLink

    init(_ text: String, seq: Int? = nil, buttons: [MessageButton]? = nil) {
        blocks = MarkdownBlock.parse(text)
        self.seq = seq
        self.buttons = buttons
    }

    init(blocks: [MarkdownBlock], seq: Int? = nil, buttons: [MessageButton]? = nil) {
        self.blocks = blocks
        self.seq = seq
        self.buttons = buttons
    }

    /// A line's words, then the buttons it ends with as real buttons. A
    /// button link whose id the row doesn't carry is its title, as text.
    @ViewBuilder private func line(_ written: String) -> some View {
        let text = ReplyButtons.unlinking(written, except: Set((buttons ?? []).map(\.id)))
        let split = ReplyButtons.trailing(in: text)
        if split.links.isEmpty {
            Text(Self.inline(text))
        } else {
            VStack(alignment: .leading, spacing: 6) {
                if !split.text.isEmpty { Text(Self.inline(split.text)) }
                FlowLayout(spacing: 6) {
                    ForEach(split.links, id: \.id) { link in
                        if let button = buttons?.first(where: { $0.id == link.id }) {
                            ReplyButtonPill(button: button)
                        }
                    }
                }
            }
        }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            ForEach(Array(blocks.enumerated()), id: \.offset) { _, block in
                view(for: block)
            }
        }
        .environment(\.openURL, OpenURLAction { threadLink($0, seq) })
    }

    @ViewBuilder private func view(for block: MarkdownBlock) -> some View {
        switch block {
        case let .paragraph(text):
            line(text)
        case let .heading(level, text):
            Text(Self.inline(text)).font(level <= 2 ? .headline : .subheadline.weight(.semibold))
        case let .listItem(text, marker, depth, task):
            HStack(alignment: .firstTextBaseline, spacing: 6) {
                if let task {
                    Image(systemName: task ? "checkmark.square" : "square").foregroundStyle(.secondary)
                } else {
                    Text(marker).foregroundStyle(.secondary).monospacedDigit()
                }
                line(text)
            }
            .padding(.leading, CGFloat(depth) * 18)
        case let .code(text):
            ScrollView(.horizontal, showsIndicators: false) {
                Text(text).font(.system(.footnote, design: .monospaced)).padding(10)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Color(.secondarySystemBackground), in: RoundedRectangle(cornerRadius: 8))
        case let .rich(kind, source):
            RichBlockView(kind: kind, source: source)
        case let .draft(draft):
            DraftBlockView(draft: draft)
        case let .quote(inner):
            MarkdownText(blocks: inner, seq: seq, buttons: buttons)
                .foregroundStyle(.secondary)
                .padding(.leading, 12)
                .overlay(alignment: .leading) {
                    RoundedRectangle(cornerRadius: 1.5).fill(.quaternary).frame(width: 3)
                }
        case .rule:
            Divider().padding(.vertical, 4)
        case let .table(header, alignments, rows):
            MarkdownTable(header: header, alignments: alignments, rows: rows)
        case let .image(alt, src):
            if let image = pictures.image(src: src, seq: seq), let url = URL(string: image.url) {
                ReplyPicture(url: url, alt: alt, width: image.width, height: image.height)
            } else if let url = ThreadPictures.webURL(src) {
                ReplyPicture(url: url, alt: alt)
            } else {
                PictureOnMac(alt: alt)
            }
        }
    }

    static func inline(_ text: String) -> AttributedString {
        (try? AttributedString(markdown: ThreadLinks.escapeDestinations(text), options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace))) ?? AttributedString(text)
    }
}

/// A turn's working, from a work: link: scrolled to the step, which lights up
/// for a moment.
private struct WorkingSheet: View {
    let link: ThreadLinks.Hit
    @State private var lit: Int?
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            ScrollViewReader { proxy in
                ScrollView {
                    WorkedItems(worked: link.turn)
                        .padding()
                }
                .task {
                    guard let step = link.step else { return }
                    lit = step
                    // Once a folded run of tool calls has opened for it.
                    try? await Task.sleep(for: .milliseconds(150))
                    proxy.scrollTo(StepID(seq: step), anchor: .center)
                    try? await Task.sleep(for: .seconds(2))
                    withAnimation(.easeOut(duration: 0.6)) { lit = nil }
                }
            }
            .navigationTitle(link.turn.title)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Done") { dismiss() }
                }
            }
        }
        .environment(\.litStep, lit)
    }
}

/// A step of a turn's working as a work: link finds it.
private struct StepID: Hashable { var seq: Int }

extension View {
    /// Marks a line of a turn's working as step `seq`, for a work: link to
    /// scroll to and light up.
    func step(_ seq: Int) -> some View { modifier(StepLine(seq: seq)) }
}

private struct StepLine: ViewModifier {
    let seq: Int
    @Environment(\.litStep) private var litStep

    func body(content: Content) -> some View {
        content
            .id(StepID(seq: seq))
            .background {
                // Past the text's edges, so the words don't touch the colour.
                RoundedRectangle(cornerRadius: 6, style: .continuous)
                    .fill(.tint)
                    .opacity(litStep == seq ? 0.25 : 0)
                    .padding(.horizontal, -6)
                    .padding(.vertical, -3)
            }
    }
}

extension EnvironmentValues {
    /// What a tap on a link in message `seq` does, set by the open thread.
    /// Outside one, the system opens it.
    @Entry var threadLink: @MainActor (URL, Int?) -> OpenURLAction.Result = { url, _ in LinkGate.shared.decide(url) }
    @Entry var litStep: Int?
    /// Opens a thread on top of this one, so Back comes back here.
    @Entry var pushThread: @MainActor (String) -> Void = { _ in }
    /// The open thread, whose reply buttons a tap presses. Nil outside one.
    @Entry var buttonThreadId: String?
}

extension ThreadLinks.Hit: Identifiable {
    public var id: Self { self }
}

/// A picture the agent pinned rather than wrote into its reply.
struct PinnedPicture: View {
    var image: MessageImage

    var body: some View {
        if let url = URL(string: image.url) {
            ReplyPicture(url: url, alt: "", width: image.width, height: image.height)
        }
    }
}

/// A markdown table: a bold header row, lines between rows, and sideways
/// scrolling when it's wider than the phone, as tables are in Safari.
private struct MarkdownTable: View {
    let header: [String]
    let alignments: [MarkdownBlock.Alignment]
    let rows: [[String]]

    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            Grid(alignment: .leading, horizontalSpacing: 14, verticalSpacing: 6) {
                GridRow { cells(header).fontWeight(.semibold) }
                ForEach(Array(rows.enumerated()), id: \.offset) { _, row in
                    Divider().gridCellUnsizedAxes(.horizontal)
                    GridRow { cells(row) }
                }
            }
            .font(.subheadline)
            .padding(10)
        }
        .background(Color(.secondarySystemBackground), in: RoundedRectangle(cornerRadius: 8))
    }

    private func cells(_ texts: [String]) -> some View {
        ForEach(Array(texts.enumerated()), id: \.offset) { i, text in
            Text(MarkdownText.inline(text))
                // Cells wrap rather than run off forever; past this the row scrolls.
                .frame(maxWidth: 220, alignment: frameAlignment(i))
                .gridColumnAlignment(columnAlignment(i))
        }
    }

    private func alignment(_ i: Int) -> MarkdownBlock.Alignment {
        i < alignments.count ? alignments[i] : .leading
    }

    private func columnAlignment(_ i: Int) -> HorizontalAlignment {
        switch alignment(i) { case .leading: .leading; case .center: .center; case .trailing: .trailing }
    }

    private func frameAlignment(_ i: Int) -> Alignment {
        switch alignment(i) { case .leading: .leading; case .center: .center; case .trailing: .trailing }
    }
}
