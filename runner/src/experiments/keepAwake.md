---
id: keepAwake
name: Keep the Mac awake
title: Keep the Mac awake: macOS's caffeinate stops idle sleep while a thread is working
added: 2026-11-06
on: false
reminder: 12503e21
---

## What it does

While any thread is working, and for three minutes after, your Mac won't go to sleep on its own, so a long turn, or one you started from your phone, isn't cut off halfway. The screen still dims and locks as usual. It stops below 15% battery when you're not plugged in, and closing the lid on battery still puts the Mac to sleep.

## Lives in

`runner/src/keep-awake.ts`; `workingThreads` in `runner.ts`; built in `main.ts`

## Taking it out

Self-contained: delete the file and its lines in `main.ts`.
