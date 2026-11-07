import AVFoundation
import Observation
import SwiftUI
import ThreadbearKit
import UIKit
import os

/// Quick ask: press the Action button, say a question, hear the answer from the Agent Archive
/// server, as Mike's old Quick Ask app did (and with its listening, early sending, speaking and
/// timing, in QuickAskCore). Then the question and answer go to the runner as a thread
/// (phone:quickAsk), so a follow-up is an ordinary reply there.
///
/// Unlike Quick Ask, Threadbear is mostly an inbox, so this only listens when it's asked to: the
/// intent (Action button, Siri, Shortcuts) or the inbox's mic button.
///
/// Once the answer's kept, the screen gives way to that thread, in voice mode (Mike, 29 Oct): a
/// big mic at the bottom asks a follow-up there, which goes to the agent as an ordinary reply,
/// and the agent's answer is read out when its turn ends.
@Observable
final class QuickAskModel {
    enum Phase: Equatable {
        case idle(notice: String?)
        case needsPermission(Permissions.State)
        case listening
        /// Sent; waiting for the first byte of the answer
        case thinking
        case answering
        case done
        case failed(AskFailure)
    }

    /// The quick ask screen is up.
    var isPresented = false
    private(set) var phase: Phase = .idle(notice: nil)
    /// What the recogniser has heard so far, while listening.
    private(set) var transcript = ""
    private(set) var question = ""
    var answer: String { progress.text }
    private(set) var progress = AnswerProgress()
    var waitingStage: AnswerStage? { progress.waiting }
    private(set) var sources: [AnswerSource] = []
    /// 0...1, smoothed, for the listening rings.
    private(set) var level: Double = 0
    private(set) var timing: QuestionTiming?
    private(set) var isSpeaking = false
    /// The thread this answer was kept in, once the runner has made it.
    private(set) var threadId: String?
    /// Keeping it failed (no runner reachable, an old backend). The answer's still on screen.
    private(set) var keepProblem: String?
    /// The thread in voice mode: the one the last quick ask was kept in.
    var voiceThreadId: String?
    /// Listening for a follow-up to this thread, rather than a new quick ask.
    private(set) var listeningFor: String?
    /// A follow-up's been sent to this thread; its reply is read out once it's there.
    private(set) var awaitingReply: (threadId: String, afterSeq: Int)?
    /// Sending a follow-up failed.
    private(set) var followUpProblem: String?
    /// A follow-up's on its way to Convex.
    private(set) var followUpSending = false

    let settings = QuickAskSettings()
    let timings = QuickAskTimings()
    /// Hands the finished ask to the backend and waits for its thread. Set by the app.
    @ObservationIgnored var keep: ((QuickAskRecord) async throws -> String?)?
    /// Sends a follow-up to a thread (phone:send). Set by the app.
    @ObservationIgnored var sendFollowUp: ((_ threadId: String, _ text: String) async throws -> Void)?
    /// The answer's been kept: the app opens its thread. Set by the app.
    @ObservationIgnored var onKept: ((String) -> Void)?
    @ObservationIgnored private var pendingAfterSeq = 0

    @ObservationIgnored private let audio = AudioInput()
    @ObservationIgnored private let classic = ClassicTranscriber()
    @ObservationIgnored private var analyzer: (any Transcriber)?
    @ObservationIgnored private let speaker = Speaker()
    @ObservationIgnored private let client = AskClient()
    @ObservationIgnored private let haptics = UIImpactFeedbackGenerator(style: .light)

    @ObservationIgnored private var detector = EndOfSpeechDetector()
    @ObservationIgnored private var transcriber: (any Transcriber)?
    @ObservationIgnored private var ticker: Task<Void, Never>?
    @ObservationIgnored private var answerStream: AnswerStream?
    @ObservationIgnored private var early = EarlySend()
    @ObservationIgnored private var earlyStream: AnswerStream?
    @ObservationIgnored private var idleTask: Task<Void, Never>?
    @ObservationIgnored private var keepTask: Task<Void, Never>?
    @ObservationIgnored private var splitter = SentenceSplitter()
    @ObservationIgnored private var muted = false
    @ObservationIgnored private var streamFinished = false
    /// This answer has gone to the backend (or there was nothing worth keeping).
    @ObservationIgnored private var kept = false
    @ObservationIgnored private var askedAt = Date()
    @ObservationIgnored private var listenStartedAt: Double = 0
    @ObservationIgnored private var inBackground = true
    @ObservationIgnored private var comingForwardAt: Double?
    @ObservationIgnored private var hasActivated = false
    @ObservationIgnored private var recentIntentAt: Double?
    @ObservationIgnored private var analyzerFailed = false
    @ObservationIgnored private var backgroundTask: UIBackgroundTaskIdentifier = .invalid
    @ObservationIgnored private var loudestDB: Float = -100
    @ObservationIgnored private let processStart = QuickAskModel.processStartTime()
    @ObservationIgnored private let isPrewarm = ProcessInfo.processInfo.environment["ActivePrewarm"] == "1"

    /// Give up listening if nothing's been heard for this long.
    private let noSpeechTimeout: Double = 8
    /// Send whatever's been heard after this long, however it's going.
    private let maxListening: Double = 45
    /// Let the mic go (and other apps' audio carry on) after this long with nothing happening.
    private let idleShutdown: Duration = .seconds(30)

    init() {
        // Previews and the demo never get here with a server set, so nothing below runs for them.
        QuickAskIntentBridge.handler = { [weak self] time in self?.intentRan(at: time) }
        if let time = QuickAskIntentBridge.lastPerformedAt { recentIntentAt = time }
        guard settings.isReady else { return }
        prepare()
    }

    /// The slow parts that don't touch audio, ahead of the first question: picking the voice and
    /// SpeechAnalyzer's model. This runs on every launch, for anyone just opening the inbox, so
    /// nothing here may prepare the audio engine or render speech. Those did until 1 Nov, and a
    /// playing podcast stopped on opening the app: the log showed Ask's session being interrupted
    /// when it had never turned the mic on. `startListening` does them instead.
    @ObservationIgnored private var prepared = false
    private func prepare() {
        guard !prepared else { return }
        prepared = true
        audio.onInterrupted = { [weak self] in
            Task { @MainActor in self?.interrupted() }
        }
        speaker.selectVoiceInBackground(id: settings.voiceIdentifier)
        speaker.onFirstWord = { [weak self] time in self?.firstWordSpoken(at: time) }
        speaker.onIdle = { [weak self] in self?.speakerIdle() }
        if #available(iOS 26.0, *) {
            let analyzer = AnalyzerTranscriber()
            self.analyzer = analyzer
            analyzer.checkAssets {}
        }
    }

    // MARK: - App lifecycle

    func scenePhaseChanged(to scenePhase: ScenePhase) {
        switch scenePhase {
        case .active: becameActive()
        case .inactive: comingForward()
        case .background: enteredBackground()
        default: break
        }
    }

    /// On the way to the front, before it's active: if the Action button sent it, the mic starts
    /// now, overlapping the slow session start with the app appearing. What it hears meanwhile is
    /// kept for the recogniser.
    private func comingForward() {
        guard inBackground, comingForwardAt == nil, intentIsFresh, settings.isReady, Permissions.state == .granted else { return }
        prepare()
        comingForwardAt = Stopwatch.now
        audio.resetSession()
        audio.startEarly()
    }

    private var intentIsFresh: Bool {
        guard let recentIntentAt else { return false }
        return Stopwatch.now - recentIntentAt < 3
    }

    private func becameActive() {
        guard inBackground else { return }
        inBackground = false
        let now = Stopwatch.now
        let startedEarly = comingForwardAt
        comingForwardAt = nil
        #if DEBUG
        if let question = debugQuestion {
            debugQuestion = nil
            askDebugQuestion(question)
            return
        }
        #endif
        if intentIsFresh, let intentAt = recentIntentAt {
            var pressAt = min(startedEarly ?? now, intentAt)
            if !hasActivated, !isPrewarm, let start = processStart, now - start < 10 { pressAt = min(pressAt, start) }
            recentIntentAt = nil
            let trigger: QuestionTiming.Trigger = hasActivated ? .resume : .launch
            hasActivated = true
            open(trigger: trigger, pressAt: pressAt)
        } else {
            hasActivated = true
            endBackgroundTask()
        }
        // Started early but not listening after all: don't leave the mic on.
        if startedEarly != nil, phase != .listening { audio.stop(deactivate: true) }
    }

    private func enteredBackground() {
        inBackground = true
        comingForwardAt = nil
        idleTask?.cancel()
        if phase == .listening {
            stopListening()
            phase = .idle(notice: nil)
        }
        if phase == .thinking || phase == .answering {
            // Asked, then locked the phone: it's going back in a pocket, so it stops talking now
            // and the rest of this answer stays quiet. The text carries on arriving in iOS's
            // background grace period, and is kept as a thread when it's done.
            backgroundTask = UIApplication.shared.beginBackgroundTask(withName: "Quick ask") { [weak self] in
                self?.endBackgroundTask()
            }
            muted = true
            speaker.stop()
            isSpeaking = false
            finishIfDone()
            audio.stop(deactivate: true)
        } else if prepared {
            saveTiming()
            audio.stop(deactivate: true)
        }
    }

    private func endBackgroundTask() {
        guard backgroundTask != .invalid else { return }
        UIApplication.shared.endBackgroundTask(backgroundTask)
        backgroundTask = .invalid
    }

    #if DEBUG
    /// `-QuickAskDebugQuestion "…"`: asks it at launch with no mic, for trying the server and the
    /// thread it's kept in from the simulator.
    @ObservationIgnored private var debugQuestion = UserDefaults.standard.string(forKey: "QuickAskDebugQuestion")

    private func askDebugQuestion(_ text: String) {
        isPresented = true
        prepare()
        var timing = QuestionTiming(trigger: .debug, pressAt: Stopwatch.now)
        timing.transcriber = "None (debug question)"
        let now = Stopwatch.now
        timing.endOfSpeechAt = now
        timing.sendDecidedAt = now
        timing.pauseEndedAt = now
        self.timing = timing
        audio.resetSession()
        audio.prewarm()
        switch makeStream(for: text, decidedAt: now) {
        case .failure(let failure):
            question = text
            fail(failure)
        case .success(let stream):
            stream.start()
            showAnswer(to: text, from: stream)
        }
    }
    #endif

    /// The intent ran (Action button, Siri, Spotlight, Shortcuts).
    private func intentRan(at time: Double) {
        Log.app.info("Quick ask intent ran")
        if phase == .listening, Stopwatch.now - listenStartedAt < 3 {
            // Opened by the intent and already listening; just note the earlier press.
            if let pressAt = timing?.pressAt { timing?.pressAt = min(pressAt, time) }
            return
        }
        recentIntentAt = time
        // Already in front: the press means "ask something new".
        if !inBackground, hasActivated {
            recentIntentAt = nil
            open(trigger: .intent, pressAt: time)
        }
    }

    /// Puts the screen up and listens. Without a server there's nothing to ask, so the screen
    /// says so (Settings has the fields).
    func open(trigger: QuestionTiming.Trigger = .followUp, pressAt: Double = Stopwatch.now) {
        listeningFor = nil
        awaitingReply = nil
        isPresented = true
        guard settings.isReady else {
            phase = .idle(notice: "Add your Ask server in Settings to use Ask.")
            return
        }
        prepare()
        startListening(trigger: trigger, pressAt: pressAt)
    }

    /// The close button: everything stops; an answer that's arrived is still kept.
    func close() {
        if phase == .listening { stopListening() }
        if phase == .thinking || phase == .answering {
            // Stopped part way: keep what came, as the server would have cut it anyway.
            answerStream?.cancel()
            answerStream = nil
            streamFinished = true
            keepAnswer()
        }
        cancelAnswer()
        saveTiming()
        isPresented = false
        phase = .idle(notice: nil)
        audio.stop(deactivate: true)
    }

    private func interrupted() {
        Log.audio.info("Audio interrupted")
        if phase == .listening {
            stopListening()
            phase = .idle(notice: "Listening was interrupted. Tap the mic to try again.")
        }
        if isSpeaking { stopSpeaking() }
    }

    // MARK: - Permissions

    func requestPermissions() {
        Task {
            let state = await Permissions.request()
            if state == .granted {
                audio.resetSession()
                startListening(trigger: .followUp, pressAt: Stopwatch.now)
            } else {
                phase = .needsPermission(state)
            }
        }
    }

    func openSystemSettings() {
        if let url = URL(string: UIApplication.openSettingsURLString) { LinkGate.shared.openOwn(url) }
    }

    // MARK: - Buttons and taps

    /// Anywhere on the screen: send while listening, otherwise stop the speaking.
    func tapAnywhere() {
        switch phase {
        case .listening: sendNow()
        case .thinking, .answering: stopSpeaking()
        default: if isSpeaking { stopSpeaking() }
        }
    }

    /// The big mic button: send while listening, otherwise a new question.
    func micButton() {
        if phase == .listening {
            sendNow()
        } else {
            startListening(trigger: .followUp, pressAt: Stopwatch.now)
        }
    }

    func stopSpeaking() {
        muted = true
        // Stopping during a quiet web or deeper wait also cancels the paid work on the server.
        if !streamFinished {
            answerStream?.cancel()
            answerStream = nil
            streamFinished = true
            keepAnswer()
        }
        endStageWait()
        speaker.stop()
        isSpeaking = false
        if phase == .thinking { phase = .answering }
        finishIfDone()
    }

    func settingsChanged() {
        if settings.isReady { prepare() }
        speaker.selectVoice(id: settings.voiceIdentifier)
        if let baseURL = settings.baseURL { client.ping(AskAPI.pingRequest(baseURL: baseURL)) }
    }

    func playVoiceSample() {
        prepare()
        speaker.selectVoice(id: settings.voiceIdentifier)
        audio.resetSession()
        audio.prewarm()
        speaker.beginAnswer()
        speaker.speak("Here's how answers will sound.")
    }

    // MARK: - Listening

    private func chooseTranscriber() -> any Transcriber {
        if #available(iOS 26.0, *), !analyzerFailed, let analyzer = analyzer as? AnalyzerTranscriber, analyzer.readiness == .ready {
            return analyzer
        }
        return classic
    }

    func startListening(trigger: QuestionTiming.Trigger, pressAt: Double) {
        let permission = Permissions.state
        guard permission == .granted else {
            phase = .needsPermission(permission)
            return
        }
        guard settings.isReady else {
            phase = .idle(notice: "Add your Ask server in Settings to use Ask.")
            return
        }
        if phase == .listening { stopListening() }
        cancelAnswer()
        idleTask?.cancel()
        if let baseURL = settings.baseURL { client.pingIfStale(AskAPI.pingRequest(baseURL: baseURL)) }

        // The mic first, since it's the slow part when it isn't already running; what it hears
        // while the recogniser's being set up is kept and handed over.
        if comingForwardAt == nil { audio.resetSession() }
        audio.startEarly()
        // Someone's asking, so the audio's ours now: load the voice for the answer.
        speaker.warmUpVoice()
        let transcriber = chooseTranscriber()
        self.transcriber = transcriber
        var timing = QuestionTiming(trigger: trigger, pressAt: pressAt)
        timing.transcriber = transcriber.name
        self.timing = timing
        transcript = ""
        question = ""
        progress = AnswerProgress()
        sources = []
        threadId = nil
        keepProblem = nil
        level = 0
        detector = EndOfSpeechDetector(config: .init(silence: Double(settings.silenceMs) / 1000))
        early = EarlySend()
        loudestDB = -100
        listenStartedAt = Stopwatch.now
        phase = .listening
        haptics.prepare()

        let sink = transcriber.begin(
            onText: { [weak self] text in self?.heard(text) },
            onError: { [weak self] error in self?.transcriberFailed(error) }
        )
        startAudio(sink: sink)
        ticker = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(for: .milliseconds(40))
                self?.checkEndOfSpeech()
            }
        }
        Log.app.info("Listening (\(trigger.rawValue, privacy: .public), \(transcriber.name, privacy: .public))")
    }

    private func startAudio(sink: @escaping AudioSink) {
        audio.start(
            sink: sink,
            level: { [weak self] db, time in Task { @MainActor in self?.levelChanged(db, at: time) } },
            firstBuffer: { [weak self] time in Task { @MainActor in self?.micLive(at: time) } },
            failure: { [weak self] failure in Task { @MainActor in self?.audioFailed(failure) } }
        )
    }

    private func micLive(at time: Double) {
        guard phase == .listening, timing?.micLiveAt == nil else { return }
        timing?.micLiveAt = time
        haptics.impactOccurred()
        if let ms = timing?.pressToMic { Log.timing.info("Press to mic live: \(Int(ms)) ms") }
    }

    private func heard(_ text: String) {
        guard phase == .listening else { return }
        if transcript.isEmpty, !text.isEmpty { Log.speech.info("First words heard") }
        transcript = text
        detector.transcriptChanged(text, at: Stopwatch.now)
        checkEndOfSpeech()
    }

    private func levelChanged(_ db: Float, at time: Double) {
        guard phase == .listening else { return }
        detector.audioLevel(db, at: time)
        loudestDB = max(loudestDB, db)
        // -60 dB (a quiet room) to -15 dB (talking close) maps to 0...1
        let target = min(max((Double(db) + 60) / 45, 0), 1)
        level = target > level ? target : level * 0.8 + target * 0.2
        checkEndOfSpeech()
    }

    private func checkEndOfSpeech() {
        guard phase == .listening else { return }
        let now = Stopwatch.now
        if let endedAt = detector.endOfSpeech(at: now) {
            send(endOfSpeechAt: endedAt, decidedAt: now)
            return
        }
        sendEarlyIfPaused(at: now)
        let listened = now - (timing?.micLiveAt ?? listenStartedAt)
        if transcript.trimmingCharacters(in: .whitespaces).isEmpty, listened > noSpeechTimeout {
            stopListening()
            Log.app.info("Heard nothing for \(Int(listened)) s; stopped listening")
            phase = .idle(notice: "Didn't hear anything. Tap the mic to try again.")
        } else if now - listenStartedAt > maxListening {
            if EndOfSpeechDetector.isMeaningful(transcript) {
                send(endOfSpeechAt: now, decidedAt: now)
            } else {
                stopListening()
                phase = .idle(notice: "Didn't catch a question. Tap the mic to try again.")
            }
        }
    }

    /// A tap while listening: send what's been heard, or stop if there's nothing worth sending.
    private func sendNow() {
        let now = Stopwatch.now
        if EndOfSpeechDetector.isMeaningful(transcript) {
            send(endOfSpeechAt: now, decidedAt: now)
        } else {
            stopListening()
            phase = .idle(notice: transcript.isEmpty ? nil : "That was too short to send. Tap the mic to try again.")
        }
    }

    /// Also drops any request sent early; `send` takes the one it's using first.
    private func stopListening() {
        if ticker != nil {
            Log.audio.info("Stopped listening. Loudest \(Int(self.loudestDB)) dB, noise floor \(Int(self.detector.noiseFloorDB)) dB, heard \(self.transcript.count) characters")
        }
        ticker?.cancel()
        ticker = nil
        listeningFor = nil
        transcriber?.end()
        audio.pause()
        level = 0
        earlyStream?.cancel()
        earlyStream = nil
        early = EarlySend()
    }

    // MARK: - Sending early

    /// At a short pause the question goes out, before the full pause says you've finished; if the
    /// words change after that, it's dropped (and goes again at the next short pause).
    private func sendEarlyIfPaused(at now: Double) {
        // A follow-up goes to the thread's agent, once, when you've finished.
        guard listeningFor == nil else { return }
        for step in early.update(transcript: transcript, paused: EarlySend.isPaused(detector, at: now)) {
            switch step {
            case .cancel:
                earlyStream?.cancel()
                earlyStream = nil
                Log.net.info("Dropped the early request: the words changed")
            case .send(let text):
                guard case .success(let stream) = makeStream(for: text, decidedAt: now) else { continue }
                stream.start()
                earlyStream = stream
                Log.net.info("Sent early (\(self.early.sendCount) this question)")
            }
        }
    }

    private func takeEarlyStream(for text: String) -> AnswerStream? {
        guard let stream = earlyStream, early.matches(text), !stream.hasFailed else { return nil }
        earlyStream = nil
        return stream
    }

    private func transcriberFailed(_ error: TranscriberError) {
        guard phase == .listening else { return }
        // SpeechAnalyzer didn't work out: carry on with SFSpeechRecognizer, and stick with it.
        if let failed = transcriber, failed !== classic, transcript.isEmpty {
            Log.speech.error("\(failed.name, privacy: .public) failed (\(error.message, privacy: .public)); using SFSpeechRecognizer")
            analyzerFailed = true
            failed.end()
            transcriber = classic
            timing?.transcriber = classic.name
            let sink = classic.begin(
                onText: { [weak self] text in self?.heard(text) },
                onError: { [weak self] error in self?.transcriberFailed(error) }
            )
            startAudio(sink: sink)
            return
        }
        if EndOfSpeechDetector.isMeaningful(transcript) {
            send(endOfSpeechAt: Stopwatch.now, decidedAt: Stopwatch.now)
        } else {
            stopListening()
            phase = .idle(notice: error.message)
        }
    }

    private func audioFailed(_ failure: AudioInput.Failure) {
        guard phase == .listening else { return }
        stopListening()
        phase = .idle(notice: failure.message)
    }

    // MARK: - Asking

    private func send(endOfSpeechAt endedAt: Double, decidedAt: Double) {
        let text = transcript.trimmingCharacters(in: .whitespacesAndNewlines)
        if let threadId = listeningFor {
            stopListening()
            phase = .idle(notice: nil)
            sendToThread(text, threadId: threadId)
            return
        }
        Log.timing.info("End of speech: waited \(Int((decidedAt - endedAt) * 1000)) ms (setting \(self.settings.silenceMs) ms)")
        let sentEarly = takeEarlyStream(for: text)
        stopListening()
        timing?.endOfSpeechAt = min(endedAt, decidedAt)
        timing?.pauseEndedAt = decidedAt
        if let sentEarly {
            timing?.sendDecidedAt = sentEarly.decidedAt
            showAnswer(to: text, from: sentEarly)
        } else {
            timing?.sendDecidedAt = decidedAt
            switch makeStream(for: text, decidedAt: decidedAt) {
            case .failure(let failure):
                question = text
                fail(failure)
            case .success(let stream):
                // Out before the screen changes for "thinking".
                stream.start()
                showAnswer(to: text, from: stream)
            }
        }
    }

    /// One request to the archive server. Follow-ups happen in the thread, so there's never any
    /// history.
    private func makeStream(for text: String, decidedAt: Double) -> Result<AnswerStream, AskFailure> {
        guard let baseURL = settings.baseURL else { return .failure(.badBaseURL) }
        guard let token = settings.token, !token.isEmpty else { return .failure(.noToken) }
        let body = AskAPI.body(question: text, history: [], timeZone: .current, now: Date())
        do {
            let request = try AskAPI.askRequest(baseURL: baseURL, token: token, body: body)
            let stream = AnswerStream(request: request, question: text, history: [], decidedAt: decidedAt, session: client.session)
            stream.freshSession = { [client] in client.freshSession() }
            return .success(stream)
        } catch {
            return .failure(.badRequest(error.localizedDescription))
        }
    }

    private func showAnswer(to text: String, from stream: AnswerStream) {
        cancelAnswer()
        idleTask?.cancel()
        question = text
        askedAt = Date()
        progress = AnswerProgress()
        sources = []
        splitter = SentenceSplitter()
        muted = !settings.speakAnswers || inBackground
        streamFinished = false
        kept = false
        timing?.question = text
        timing?.spoke = settings.speakAnswers
        speaker.beginAnswer()
        phase = .thinking
        answerStream = stream
        stream.attach { [weak self, weak stream] event in
            guard let self, let stream, stream === self.answerStream else { return }
            self.handle(event)
        }
    }

    private func handle(_ event: AnswerStream.Event) {
        switch event {
        case .responded(let sentAt, let at):
            timing?.requestSentAt = sentAt
            timing?.responseAt = at
        case .headers(let sources, let serverTiming):
            self.sources = sources
            timing?.serverTiming = serverTiming
        case .firstByte(let at):
            timing?.firstByteAt = at
            phase = .answering
        case .stage(let stage):
            progress.begin(stage)
            // A stage line ends the filler's sentence; what's said after it is the answer, so the
            // filler can be cut short once the answer's first sentence is ready.
            if let rest = splitter.finish() { speak(rest) }
            splitter = SentenceSplitter()
            speaker.stageBegan()
            UIApplication.shared.isIdleTimerDisabled = true
        case .stageText(let stage, let at):
            switch stage {
            case .web: if timing?.firstWebTextAt == nil { timing?.firstWebTextAt = at }
            case .deep: if timing?.firstDeepTextAt == nil { timing?.firstDeepTextAt = at }
            }
        case .sources(let incoming):
            sources = AnswerSource.merging(sources, incoming)
        case .text(let text):
            guard !text.isEmpty else { return }
            if progress.waiting != nil { UIApplication.shared.isIdleTimerDisabled = false }
            progress.append(text)
            for sentence in splitter.append(text) { speak(sentence) }
        case .finished(let at):
            endStageWait()
            if let rest = splitter.finish() { speak(rest) }
            timing?.completeAt = at
            streamFinished = true
            if phase == .thinking { phase = .answering }
            if answer.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { return fail(.emptyAnswer) }
            keepAnswer()
            finishIfDone()
        case .failed(let failure):
            fail(failure)
        case .cutOff:
            endStageWait()
            if let rest = splitter.finish() { speak(rest) }
            streamFinished = true
            keepAnswer()
            progress.append("\n\n" + AskFailure.cutOff.message)
            finishIfDone()
        }
    }

    private func speak(_ sentence: String) {
        guard !muted else { return }
        speaker.speak(sentence)
        isSpeaking = true
    }

    private func firstWordSpoken(at time: Double) {
        guard timing?.firstSpokenAt == nil, timing?.spoke == true else { return }
        timing?.firstSpokenAt = time
        if let ms = timing?.endToFirstWord { Log.timing.info("End of speech to first spoken word: \(Int(ms)) ms") }
    }

    private func speakerIdle() {
        isSpeaking = false
        finishIfDone()
    }

    private func finishIfDone() {
        guard streamFinished, !isSpeaking, phase == .answering else { return }
        phase = .done
        saveTiming()
        scheduleIdleShutdown()
    }

    private func fail(_ failure: AskFailure) {
        Log.app.error("Quick ask failed: \(failure.message, privacy: .public)")
        cancelAnswer()
        phase = .failed(failure)
        saveTiming()
        scheduleIdleShutdown()
    }

    // MARK: - Keeping it as a thread

    /// Once per answer, when it's finished or stopped: the question and what came of the answer
    /// go to the runner, which makes a thread of them.
    private func keepAnswer() {
        guard !kept else { return }
        kept = true
        let record = QuickAskRecord(
            question: question, answer: answer,
            sources: sources.map { .init(title: $0.title, url: $0.url) },
            askedAt: askedAt
        )
        guard record.isWorthKeeping, let keep else { return }
        keepTask?.cancel()
        keepTask = Task { [weak self] in
            do {
                let id = try await keep(record)
                guard !Task.isCancelled, let self, self.question == record.question else { return }
                self.threadId = id
                Log.app.info("Kept as thread \(id ?? "none", privacy: .public)")
                // Into the thread, in voice mode; the answer carries on being spoken.
                if let id, self.isPresented, self.phase != .listening {
                    self.voiceThreadId = id
                    self.isPresented = false
                    self.onKept?(id)
                }
            } catch {
                guard !Task.isCancelled, let self, self.question == record.question else { return }
                self.keepProblem = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
                Log.app.error("Couldn't keep the quick ask: \(error.localizedDescription, privacy: .public)")
            }
        }
    }

    // MARK: - Follow-ups in the thread

    /// The thread's big mic: listen for a follow-up. `afterSeq` is the thread's newest message
    /// now, so the reply read out is one that comes after it.
    func listenForFollowUp(in threadId: String, afterSeq: Int) {
        speaker.stop()
        isSpeaking = false
        followUpProblem = nil
        prepare()
        Log.app.info("Listening for a follow-up to \(threadId, privacy: .public) after seq \(afterSeq)")
        startListening(trigger: .followUp, pressAt: Stopwatch.now)
        // After startListening, which clears it via stopListening.
        if phase == .listening {
            listeningFor = threadId
            pendingAfterSeq = afterSeq
        }
    }

    private func sendToThread(_ text: String, threadId: String) {
        guard EndOfSpeechDetector.isMeaningful(text), let sendFollowUp else {
            Log.app.error("Follow-up not sent (\(text.count) characters, sender set: \(self.sendFollowUp != nil))")
            phase = .idle(notice: "Didn't catch that. Tap the mic to try again.")
            return
        }
        awaitingReply = (threadId, pendingAfterSeq)
        followUpSending = true
        let started = Stopwatch.now
        Log.app.info("Sending a follow-up to \(threadId, privacy: .public): \(text, privacy: .public)")
        Task { [weak self] in
            do {
                try await sendFollowUp(threadId, text)
                Log.app.info("Follow-up sent in \(Int((Stopwatch.now - started) * 1000)) ms")
            } catch {
                Log.app.error("Follow-up failed: \(error.localizedDescription, privacy: .public)")
                self?.awaitingReply = nil
                self?.followUpProblem = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
            }
            self?.followUpSending = false
        }
    }

    /// The thread's view saw the agent finish with this reply: read it out, if it's the one a
    /// voice follow-up is waiting for.
    func replyArrived(in threadId: String, seq: Int, text: String) {
        guard let awaiting = awaitingReply, awaiting.threadId == threadId, seq > awaiting.afterSeq else { return }
        awaitingReply = nil
        Log.app.info("Reading out the reply (seq \(seq), \(text.count) characters)")
        speakReply(text)
    }

    func stopSpeakingReply() {
        speaker.stop()
        isSpeaking = false
    }

    private func speakReply(_ text: String) {
        let spoken = SpokenReply.text(from: text)
        guard !spoken.isEmpty, settings.speakAnswers, !inBackground else { return }
        prepare()
        audio.resetSession()
        audio.prewarm()
        speaker.beginAnswer()
        var splitter = SentenceSplitter()
        for sentence in splitter.append(spoken) { speaker.speak(sentence) }
        if let rest = splitter.finish() { speaker.speak(rest) }
        isSpeaking = true
        scheduleIdleShutdown()
    }

    // MARK: -

    private func endStageWait() {
        progress.finish()
        UIApplication.shared.isIdleTimerDisabled = false
    }

    private func cancelAnswer() {
        endStageWait()
        answerStream?.cancel()
        answerStream = nil
        speaker.stop()
        isSpeaking = false
    }

    private func saveTiming() {
        guard let timing, timing.requestSentAt != nil else { return }
        timings.record(timing)
    }

    private func scheduleIdleShutdown() {
        idleTask?.cancel()
        if inBackground {
            audio.stop(deactivate: true)
            endBackgroundTask()
            return
        }
        idleTask = Task { [weak self, idleShutdown] in
            try? await Task.sleep(for: idleShutdown)
            guard !Task.isCancelled, let self, self.phase != .listening, !self.isSpeaking else { return }
            self.audio.stop(deactivate: true)
        }
    }

    /// When the process started: the nearest the app gets to the press on a cold launch.
    private static func processStartTime() -> Double? {
        var info = kinfo_proc()
        var size = MemoryLayout<kinfo_proc>.stride
        var mib: [Int32] = [CTL_KERN, KERN_PROC, KERN_PROC_PID, getpid()]
        guard sysctl(&mib, u_int(mib.count), &info, &size, nil, 0) == 0 else { return nil }
        let start = info.kp_proc.p_starttime
        return Double(start.tv_sec) + Double(start.tv_usec) / 1_000_000
    }
}
