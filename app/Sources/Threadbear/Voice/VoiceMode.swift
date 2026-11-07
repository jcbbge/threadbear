import AppKit
import Observation
import ThreadbearCore

/// Voice mode: talking with a thread out loud. It's another way in and
/// out of the same thread, not another agent: what Mike says is sent as
/// his message (into the running turn if there is one, as typing during a
/// turn is), and the agent's replies are read out. So the thread keeps its
/// memory, tools and approvals, and goes on working while he talks.
/// Talking over the agent stops it speaking. One thread at a time.
@MainActor
@Observable
final class VoiceMode {
    static let shared = VoiceMode()

    enum Phase: Equatable {
        case off
        /// Downloading or starting the engine, or asking for the microphone.
        case starting(String)
        case listening
        /// He's talking: the words so far.
        case hearing(String)
        /// Sent; the agent is working on it.
        case thinking
        case speaking
        case failed(String)
    }

    private(set) var phase: Phase = .off
    private(set) var threadId: String?
    /// 0...1: him while listening, the agent while it speaks.
    private(set) var level: Float = 0

    @ObservationIgnored private var audio: VoiceAudio?
    @ObservationIgnored private var tracker = UtteranceTracker(pause: 1.0)
    @ObservationIgnored private var endpointTimer: Timer?
    @ObservationIgnored private var base: URL?
    /// Replies already spoken, so a catch-up doesn't say one twice.
    @ObservationIgnored private var spoken: Set<String> = []
    @ObservationIgnored private var startedAt = Date()
    /// The agent's turn is running.
    @ObservationIgnored private var working = false
    /// The turn's newest message, said when it ends unless a final reply came.
    @ObservationIgnored private var lastMessage: (String, String, String)?
    /// The approval cards waiting, and the one read out to him, which is
    /// the only one a spoken yes or no can answer (SpokenApprovals).
    @ObservationIgnored private var approvals = SpokenApprovals()
    /// The newest start: one that's been overtaken (he turned it off and on
    /// again, or changed the language) gives way to it.
    @ObservationIgnored private var startId = UUID()
    /// Without echo cancellation: ignore the microphone until then.
    @ObservationIgnored private var quietUntil: CFTimeInterval = 0

    /// Running, or getting ready to. A failure is off (the button's blue
    /// again), with its message showing until he closes it.
    var isOn: Bool {
        switch phase {
        case .off, .failed: false
        default: true
        }
    }

    func isOn(for threadId: String) -> Bool { isOn && self.threadId == threadId }

    /// The thread id Voice uses for a new thread's composer: what he says
    /// first starts the thread (AppModel.startThreadSpoken), and Voice
    /// carries on in it. "new" is the new thread's draft key too.
    static let newThread = "new"

    /// The experiment (runner/src/experiments/voiceMode.md), on in this
    /// Mac's runner.json. Off: no button, no Voice settings, nothing
    /// downloaded and no microphone prompt.
    static let experiment = "voiceMode"
    static var available: Bool { AppModel.shared.experiments.contains(experiment) }

    /// Settings > Voice's switch. Off hides every waveform button.
    static let enabledKey = "voiceEnabled"
    static var enabled: Bool { UserDefaults.standard.object(forKey: enabledKey) as? Bool ?? true }

    /// What he said while the new thread was being made, sent once it exists.
    @ObservationIgnored private var waitingWords: [String] = []
    @ObservationIgnored private var makingThread = false

    func toggle(threadId: String) {
        if isOn(for: threadId) { stop() } else { start(threadId: threadId) }
    }

    func start(threadId: String) {
        guard Self.available else { return }
        stop()
        let startId = UUID()
        self.startId = startId
        self.threadId = threadId
        startedAt = Date()
        phase = .starting("Getting ready…")
        let defaults = UserDefaults.standard
        let language = VoiceCatalog.language(defaults.string(forKey: VoiceCatalog.languageKey))
        let mic = VoiceAudio.microphone(uid: defaults.string(forKey: VoiceCatalog.microphoneKey))
        VoiceServer.shared.onStatus = { [weak self] status in
            if case .starting = self?.phase { self?.phase = .starting(status) }
        }
        Task {
            do {
                let base = try await VoiceServer.shared.ready(language: language.id)
                guard self.startId == startId else { return }
                self.base = base
                let audio = VoiceAudio()
                audio.onResult = { [weak self] in self?.heard($0) }
                audio.onInputLevel = { [weak self] level in
                    guard let self, !(self.audio?.isSpeaking ?? false) else { return }
                    self.show(level: level)
                }
                audio.onOutputLevel = { [weak self] level in
                    guard let self, self.audio?.isSpeaking ?? false else { return }
                    self.show(level: level)
                }
                audio.onSpeaking = { [weak self] on in
                    guard let self, self.isOn else { return }
                    // A moment for sound still on its way out, longer
                    // when the microphone can hear it.
                    if !on { self.quietUntil = CACurrentMediaTime() + ((self.audio?.echoCancels ?? false) ? 0.4 : 0.8) }
                    if on { self.phase = .speaking } else if case .speaking = self.phase { self.phase = self.working ? .thinking : .listening }
                }
                self.audio = audio
                self.phase = .starting("Asking for the microphone…")
                try await audio.start(locale: Locale(identifier: language.locale), microphone: mic)
                guard self.startId == startId else { audio.stop(); return }
                self.phase = .listening
                self.endpointTimer = Timer.scheduledTimer(withTimeInterval: 0.2, repeats: true) { [weak self] _ in
                    MainActor.assumeIsolated { self?.checkPause() }
                }
                VoiceLog.write("on for \(threadId)")
            } catch {
                guard self.startId == startId else { return }
                self.fail(error.localizedDescription)
            }
        }
    }

    /// The language changed in Settings: the engine and the recogniser are
    /// per language, so Voice starts over in the new one, on the same thread.
    func languageChanged() {
        guard isOn, let threadId else { return }
        start(threadId: threadId)
    }

    /// Levels reach the button and the bear a few times a second, in tenths:
    /// Core Animation eases between them, and the app redraws only for a
    /// change it could show.
    private func show(level new: Float) {
        let rounded = (new * 10).rounded() / 10
        if rounded != level { level = rounded }
    }

    func stop() {
        dismissFailure()
        // A start still under way gives way, whatever else is going on.
        startId = UUID()
        guard isOn || audio != nil else { return }
        let flushedAt = spokenAt()
        if let threadId, let text = tracker.flush() { send(text, to: threadId, spokenAt: flushedAt) }
        endpointTimer?.invalidate()
        endpointTimer = nil
        audio?.stop()
        audio = nil
        tracker = UtteranceTracker(pause: 1.0)
        phase = .off
        level = 0
        working = false
        approvals.clear()
        makingThread = false
        waitingWords = []
        if let threadId { VoiceLog.write("off for \(threadId)") }
        threadId = nil
        VoiceServer.shared.stopSoon()
    }

    private func fail(_ message: String) {
        VoiceLog.write("failed: \(message)")
        startId = UUID()
        approvals.clear()
        makingThread = false
        waitingWords = []
        endpointTimer?.invalidate()
        endpointTimer = nil
        audio?.stop()
        audio = nil
        phase = .failed(message)
    }

    /// The error under the composer goes when he closes it.
    func dismissFailure() {
        if case .failed = phase { phase = .off; threadId = nil }
    }

    // MARK: Hearing him

    private func heard(_ result: UtteranceTracker.Result) {
        guard isOn else { return }
        // Without echo cancellation the microphone hears the agent: what
        // it hears while speaking, and just after, is its own voice.
        // Headphones don't leak, so he can still talk over it there.
        // By when the words were captured as well as now: the recogniser can
        // hand over what the microphone heard a while ago.
        if let audio, !audio.echoCancels, !VoiceAudio.outputIsHeadphones() {
            let capturedAt = audio.hostTime(ofAudio: result.start)
            if audio.isSpeaking || CACurrentMediaTime() < quietUntil || capturedAt.map({ $0 < quietUntil }) ?? true { return }
        }
        if tracker.add(result, now: CACurrentMediaTime()) {
            // He's talking: the agent stops.
            if audio?.isSpeaking == true { audio?.stopSpeaking() }
            phase = .hearing(tracker.pending)
        }
    }

    private func checkPause() {
        let at = spokenAt()
        guard let threadId, let text = tracker.take(now: CACurrentMediaTime()) else { return }
        send(text, to: threadId, spokenAt: at)
    }

    /// When he started saying what's waiting, on the clock approvals use.
    /// Not known counts as long ago, which can't answer a card.
    private func spokenAt() -> Double {
        tracker.pendingStart.flatMap { audio?.hostTime(ofAudio: $0) } ?? -.infinity
    }

    private func send(_ text: String, to threadId: String, spokenAt: Double) {
        // A new thread's composer: the first words start the thread.
        if threadId == Self.newThread {
            working = true
            phase = .thinking
            if makingThread { waitingWords.append(text); return }
            makingThread = true
            let startId = self.startId
            AppModel.shared.startThreadSpoken(text) { [weak self] id in
                // Only the Voice that asked: stopped and started again since,
                // this thread is nothing to do with what's on now.
                guard let self, self.startId == startId else { return }
                self.makingThread = false
                guard self.threadId == Self.newThread else { return }
                guard let id else {
                    // Nothing could be made: say so, rather than sit on
                    // "working" with nothing behind it.
                    self.fail("That thread couldn't be started. Try again, or type it.")
                    return
                }
                // Before it's selected, so selecting it doesn't end Voice.
                self.threadId = id
                VoiceLog.write("started \(id) by voice")
                let rest = self.waitingWords
                self.waitingWords = []
                for words in rest { AppModel.shared.sendSpoken(threadId: id, text: words) }
            }
            return
        }
        // A yes or a no on its own answers the card he heard, and only that
        // one (SpokenApprovals says why).
        let quietSince = audio?.isSpeaking == true ? Double.infinity : quietUntil
        switch approvals.take(text, spokenAt: spokenAt, quietSince: quietSince) {
        case .answer(let card, let decision):
            let session = AppModel.shared.session(for: threadId)
            // Last look at what the thread itself shows: live events can't
            // reach Voice while it's reconnecting, so a card settled from the
            // phone meanwhile, or changed, is only known here.
            guard session.openApproval(card.approvalId) == card else {
                VoiceLog.write("an approval answered by voice had gone; not answered")
                speakNow("That request has gone, so I didn't answer it.")
                idle()
                return
            }
            session.respond(approvalId: card.approvalId, decision: decision, answers: nil, message: nil)
            VoiceLog.write("answered an approval by voice: \(decision.rawValue)")
            speakNow(decision == .deny ? "OK, I won't." : "OK, going ahead.")
            working = true
            phase = .thinking
            // Another card still waiting: its turn to be heard.
            if let next = approvals.open.last { readOut(next) }
        case .readAgain(let card):
            VoiceLog.write("heard an answer to an approval not read out yet; reading it")
            idle()
            readOut(card)
        case .onScreen:
            speakNow("That one's on screen for you to answer.")
            idle()
        case .message:
            AppModel.shared.sendSpoken(threadId: threadId, text: text)
            working = true
            phase = .thinking
        }
    }

    /// Back from hearing him, with nothing sent.
    private func idle() {
        phase = working ? .thinking : .listening
    }

    // MARK: The agent's side

    /// Every live event of the voice thread (ThreadSession.receive).
    func receive(_ event: Event) {
        guard isOn, event.threadId == threadId else { return }
        switch event.payload {
        case .turnStarted:
            working = true
            lastMessage = nil
            if case .listening = phase { phase = .thinking }
        case .turnCompleted:
            working = false
            // A thread without one reply: its last message was the reply.
            if let (id, text, ts) = lastMessage { say(text, id: id, at: ts) }
            lastMessage = nil
            if case .thinking = phase { phase = .listening }
        case .assistantText(let itemId, let text, let summary, let narration, _, let final):
            guard !summary, !narration else { return }
            if final {
                // One reply's message after end_turn: the reply, said now.
                lastMessage = nil
                say(text, id: itemId, at: event.ts)
            } else {
                lastMessage = (itemId, text, event.ts)
            }
        case .approvalRequested(let request):
            approvals.requested(request)
            guard !isBeforeVoice(event.ts), spoken.insert("approval-\(event.seq)").inserted else { return }
            readOut(request)
        case .approvalResolved(let resolution):
            approvals.resolved(resolution.approvalId)
        case .questionRequested:
            say("I've got a question for you on screen.", id: "question-\(event.seq)", at: event.ts)
        default:
            break
        }
    }

    /// A card's request, whole, then what to say to it. It can be answered
    /// from when all that has played to its end, so one he talked over or
    /// hasn't got to yet can't take his yes. A card the words can't cover is
    /// named, and left for the screen.
    private func readOut(_ card: ApprovalRequest) {
        guard let reading = SpokenApprovals.reading(of: card) else {
            speak(SpokenText.sentences("I need your OK on screen: \(card.title)."))
            return
        }
        let ask = card.options.contains(.allowAlways) ? "Say yes, no, or always allow." : "Say yes or no."
        speak(["I need your OK.", reading, ask], played: { [weak self] in self?.approvals.readOut(card, at: CACurrentMediaTime()) })
    }

    /// A short line of its own, said straight away (an answer's "OK").
    private func speakNow(_ line: String) {
        speak([line])
    }

    private func say(_ markdown: String, id: String, at ts: String) {
        guard !isBeforeVoice(ts), spoken.insert(id).inserted else { return }
        speak(SpokenText.sentences(markdown))
    }

    /// Only what came after Voice was turned on is said.
    private func isBeforeVoice(_ ts: String) -> Bool {
        guard let date = ISO8601DateFormatter.withFractions.date(from: ts) ?? ISO8601DateFormatter().date(from: ts) else { return false }
        return date < startedAt
    }

    private func speak(_ sentences: [String], played: (() -> Void)? = nil) {
        guard let audio, let base else { return }
        let defaults = UserDefaults.standard
        let voice = VoiceCatalog.voice(defaults.string(forKey: VoiceCatalog.voiceKey))
        let speed = VoiceCatalog.speed(defaults.object(forKey: VoiceCatalog.speedKey) as? Double)
        audio.speak(sentences, voice: voice.engineVoice, speed: speed, base: base, played: played)
    }

    #if DEBUG
    /// The automation hook's `voice-stage`: a phase to look at, nothing running.
    func stage(_ phase: Phase, threadId: String?, level: Float) {
        self.phase = phase
        self.threadId = threadId
        self.level = level
    }
    #endif

    // MARK: Settings' Try button

    @ObservationIgnored private var previewAudio: VoiceAudio?
    private(set) var previewStatus: String?

    func preview(voice: VoiceOption, speed: Double) {
        guard Self.available else { return }
        let language = VoiceCatalog.language(UserDefaults.standard.string(forKey: VoiceCatalog.languageKey))
        previewStatus = "Getting the voice ready…"
        VoiceServer.shared.onStatus = { [weak self] in self?.previewStatus = $0 }
        Task {
            do {
                let base = try await VoiceServer.shared.ready(language: language.id)
                let audio = previewAudio ?? VoiceAudio()
                previewAudio = audio
                try audio.preview("Hi, I'm \(voice.name). Ask me anything, and I'll keep working while we talk.", voice: voice.engineVoice, speed: speed, base: base)
                previewStatus = nil
                // Not out from under a conversation that's using the engine.
                if !isOn { VoiceServer.shared.stopSoon() }
            } catch {
                previewStatus = error.localizedDescription
            }
        }
    }
}

extension ISO8601DateFormatter {
    static let withFractions: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f
    }()
}
