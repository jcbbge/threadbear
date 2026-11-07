# Threadbear for iPhone

The phone side of Threadbear: the inbox, a thread's last messages, replies
(typed, with photos taken or chosen), approvals, questions and secrets
(sealed to the runner's key before they leave the phone, so the mirror only
carries ciphertext: `ThreadbearKit/.../Secrets.swift`), Hibernate and the Den, new
threads and push. It reads the Convex mirror the runner writes
(`docs/convex-backend.md`, `convex/phone.ts`) and never talks to the runner
directly, so it works with the Mac asleep: whatever you send waits in
`commands` until the runner is back.

- `ThreadbearKit/`: the rows, the inbox order (same rules as the Mac
  sidebar), the Convex transport, a `FakeBackend` with sample data. `swift
  test` runs on the Mac, and `./check.sh` runs it whenever `ios/` changed.
- Every mic tap goes through `Threadbear/MicTap.swift`, which waits for the
  mic's format to settle (a tap too early crashed Ask);
  `MicTapTests` fails on an `installTap` anywhere else.
- The rows look like the Mac sidebar's (`Threadbear/Look.swift`): the
  project's tile with its picture (from `phone:projects`, backend API 5,
  fetched once and kept in `ProjectPictures`), its symbol or first
  letter, a second tile's edge behind it for a thread in two projects, the
  unread dot or done tick in the gutter, the status in the Mac's colours
  (accent while working, orange for Needs you, red for Failed) and the
  same section headings. The accent is the system blue the Mac's accent
  is.
- The mic on new threads and replies (`Threadbear/Dictation.swift`,
  `DictateButton.swift`) uses Apple's speech
  recognition or Whisper, asked on the first tap (Settings › Dictation
  after). Whisper is whisper.cpp's prebuilt framework (`WhisperBinary/`,
  the release Voice Type on the Mac runs) with large-v3-turbo q8_0, an
  874 MB background download into Application Support
  (`Threadbear/Whisper/`), on the GPU. It records while listening and types
  it all out on stop; Apple's fills in until the download's done. Whisper gets a
  word list as its prompt, as Voice Type does ("Convex, Claude."):
  `DictationWords` has defaults, Settings › Dictation › Words edits them,
  and `-ThreadbearAddWords "A, B"` at launch adds some. Debug builds take `-WhisperTestWAV
  <path>` to transcribe a file at launch and print it (the simulator runs
  it on the CPU, as its Metal can't map the model: about 50 s a clip).
- `Threadbear/`: the SwiftUI app. iOS 18, so the XS Max runs it too.
- `scripts/sim-shots.sh [dir] [--dark]`: screenshots on sample data in the
  simulator (`-ThreadbearFake`, `-ThreadbearOpen <threadId>`,
  `-ThreadbearCompose <text>`, `-ThreadbearSearch <text>`, `-ThreadbearLong` for a very long thread, "long", `-ThreadbearSecret` for one waiting on a secret card, "secret", `-ThreadbearShortInbox` for one row in the inbox and one of each put away, `-ThreadbearEmptyInbox` for none, `-ThreadbearFinishSoon` for the running thread's turn to end after 14 s, `-ThreadbearSlowAnswers` for answers to cards to take 3 s to land, `-ThreadbearRefuseAnswers` for them then to be refused), on a 6.9" iPhone, so they're App Store sized.
- `scripts/sim.sh [boot|stop]`: this worktree's own simulator, for
  `sim-shots.sh` and any repro of your own. It prints the id; use that
  rather than picking a simulator from `simctl list`, and `stop` it when
  you're done. It refuses to boot a third.
- `appstore/` and `scripts/appstore-*`: the App Store listing and release,
  in `appstore/RELEASE.md`.
- `scripts/install-phone.sh`: build, install over wifi, launch.
- `scripts/make-icon.swift`: the icon, from the same mascot as the Mac's.

## The demo

"Look around with sample threads", at the bottom of the pair screen, runs
the app on `FakeBackend`'s made-up threads, on the phone only. It's how App
Review sees the app working without a token into anyone's deployment, so
the sample data must never name Mike's own projects or machines
(`sampleDataHasNothingPersonal`). The menu and Settings have "Leave the
demo", back to pairing. It isn't remembered across launches.

## Pairing

The phone carries a phone token (`convex/tokens.ts`), never the runner key.
The Mac app makes one: Settings › Phone & browser › "Show the code" shows
the pairing QR code (the runner issues the token, docs/protocol.md
"Devices"), and the same tab lists paired phones with Revoke. By hand,
`npx convex run tokens:issue '{"name":"iphone","days":90}'` (`--prod` for
prod) makes one, to get onto the phone as a link:

    threadbear://pair?url=<https://….convex.cloud>&token=<tb_…>

(the Mac's code adds `&key=<runnerId>:<key>`, the runner's secret-box
key, without which the phone pairs but won't answer secret cards;
docs/protocol.md, "Trusting the key")

shown as a QR code that Threadbear's Scan the code (or the Camera) reads. `swift ios/scripts/pair-qr.swift` does all of this, never printing the token or leaving the image on disk, or pasted from the phone's own
clipboard ("Paste a pairing link"). Not through the Mac clipboard: Quick
Ask's key leaked that way. The app checks the token with `phone:me` before
keeping it, in the Keychain keyed by deployment. Debug builds also take
`http://127.0.0.1:3210`, the local `npx convex dev` backend, for the
simulator.

## Push

`phone:registerDevice` with the APNs token. Builds from `install-phone.sh`
are development-signed, so they're `sandbox`; App Store builds (Release,
`THREADBEAR_APS_ENVIRONMENT = production`) are `production`. In 1.0 the
pushes come straight from the paired deployment with Mike's key
(`convex/push.ts`); the relay in docs/setup-and-updates.md 2.4 is later. Tapping a notification opens
its `threadId`.

## Ask (quick ask in the code)

The old Quick Ask app, folded in (29 Oct 2026). Shown as "Ask" so it isn't
taken for that retired app; the code still says quick ask. The Action
button runs `QuickAskIntent` (Settings › Action Button › Shortcut ›
Threadbear › Ask), which opens the screen already listening. The question goes
straight to the Agent Archive server's `/api/quick/ask` over Tailscale
(contract in `~/dev/me/agent-archive/docs/quick-ask.md`), and the answer is
spoken a sentence at a time as it streams in. When it's finished, or stopped,
`phone:quickAsk` (backend API 10) has the runner keep it as a thread, so a
follow-up is an ordinary reply there; ↗ opens it.

- `Threadbear/QuickAskCore/`: the logic with no UIKit (end of speech, early
  sending, the NDJSON stream, sentences, the filler cut, timings), from
  Quick Ask's `QuickAskCore` without its OpenRouter path. The app compiles it;
  `ThreadbearKit/Sources/QuickAskCore` is a link to it so `swift test` runs
  its tests (`Tests/QuickAskCoreTests`).
- `Threadbear/QuickAsk/`: the mic, speech recognition (SpeechAnalyzer on iOS
  26, else SFSpeechRecognizer), the voice, the screen, Settings › Quick ask.
- It only listens when asked (the intent or the inbox's waveform button), and
  nothing shows until a server and token are set, so App Store users without
  an archive never see it.
- The server and token: a QR code of `threadbear://quickask?url=<server>&token=<aa_…>`,
  or typed into Settings. The token is an archive phone token issued on
  Bruce (agent-archive's `scripts/phone-token.mjs`, `--bruce`). Get it onto
  the phone as a QR code, never through the Mac clipboard: Quick Ask's
  OpenRouter key leaked that way.
- Debug builds take `-QuickAskServer <url> -QuickAskToken <token>
  -QuickAskDebugQuestion "…"` (and `-quickAsk.speakAnswers NO`) to ask from
  the simulator with no mic. The simulator reaches the server through the
  Mac's Tailscale.
