---
id: voiceMode
name: Voice mode
title: Voice mode: talk with a thread out loud in the Mac app, and hear its replies
added: 2026-11-07
on: false
reminder: 25b1c3a4
---

## What it does

A waveform button beside Send in the Mac app, to talk with a thread out loud and have its replies read out ("Talking with a thread" in the guide). It lives in the app, which reads the switch when it connects to the runner, so turning it on or off takes effect when the app next connects (quit and reopen it). While it's off there's no button and no Voice tab in Settings, nothing downloads and macOS never asks for the microphone.

## Lives in

app `Voice/` (`VoiceMode`, `VoiceAudio`, `VoiceServer`, `VoiceButton`, `VoiceBear`), `Views/VoiceSettings.swift`; Core `Voice/`; `sendSpoken` and `startThreadSpoken` in `AppModel+ThreadActions.swift`, `openApproval` and a line in `receive` in `ThreadSession.swift`, a line each in `AppModel.select`, `AppModel.newThread`, `AppModel+Connection.swift` and `ThreadbearApp.swift`; the stage in `ComposerView.swift`, the button in `ComposerControls.swift`, the tab in `SettingsView.swift`, `voice-stage` in `Automation.swift`; the microphone and speech strings in `app/Resources/Info.plist`. The app learns it's on from `experiments` in `hello` (`experimentsOn` in `experiments.ts`)

## Taking it out

Self-contained: drop those folders and lines. Keep `experiments` in `hello` if another experiment in the app uses it.
