---
id: standingInstructions
name: Standing instructions
title: Standing instructions: text you write in Settings that every thread's agent is given, on every login
added: 2026-11-07
on: false
reminder: 918ac030
---

## What it does

An Instructions box in Settings > General, for what every agent should always keep in mind: who you are, how you like things written, what you build with. Every new session gets it, on every login, Claude and Codex alike, and a chat that's already going hears a change before your next message, with a line in the thread saying so. It saves as you type; empty is none. A login's own `CLAUDE.md` or `AGENTS.md` still applies, and is the place for what's particular to that login or provider: this is for what goes for all of them, without keeping several files in step. Only what you save in Settings counts. If anything else changes the file (an agent, say), no agent is given it, Threadbear warns you, and the box shows what the file holds so you can keep it or clear it. Agents can't change this for you, so ask one to draft them and paste it in yourself. On Full access an agent that goes after the runner's own key could still get past this, as it could with anything on your Mac.

## Lives in

`runner/src/instructions.ts`, built in `main.ts`; `instructionsNews`, `sendWithInstructionsNews`, `briefFor` and `standingText` in `runner.ts`, its line in `runner/editing.ts`, `instructionsTold` in `store.ts`; app `Views/InstructionsSettings.swift`, `InstructionsModel.swift`, Core `Protocol/Instructions.swift`, the `standingInstructions` case in `RPCClient.swift` and `AppModel+Connection.swift`, `InstructionsSection()` in `SettingsView.swift`

## Taking it out

Self-contained: delete those files and lines. `instructions.md` and `instructions.sig` in the data dir are then ignored, and can go.
