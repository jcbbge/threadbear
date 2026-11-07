---
id: looseEnds
name: Loose ends on the done card
title: Loose ends on the done card: the runner checks a finished thread's branch, worktree, the threads it started and its check-ins, so Archive is safe without asking
added: 2026-11-07
on: false
reminder: 7904a70e
---

## What it does

When a thread finishes with nothing for you to do, Threadbear checks what's still open before you archive it: commits on its worktree's branch that aren't on main, files in its worktree that aren't committed, threads it started that are still working or waiting for you, and check-ins it booked. If there's nothing, the done card says "Nothing left open" beside Done, so Archive is safe without asking the agent first. If there is, it lists them under "Still open" (a thread opens from its line; Land is the chip above the message box). A check-in alone shows under "Coming back", as the thread comes back by itself when it runs. It checks again when you open the thread, after an action like Land, and when a thread it started finishes. The phone's done card doesn't show it yet.

## Lives in

`runner/src/loose-ends.ts`, `runner/src/runner/loose-ends.ts`; the calls in `completeTurn` and `update` (`runner.ts`), `runAction` (`runner/patches.ts`) and `threads.subscribe` (`rpc.ts`); `schedulesFor` set in `main.ts`; app `looseEndsText` in `RowRenderer.swift`, `setLooseEnds` in `TranscriptReducer.swift`

## Taking it out

Self-contained: delete the two files and those calls; the app draws nothing without the field.
