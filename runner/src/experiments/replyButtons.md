---
id: replyButtons
name: Reply buttons
title: Reply buttons: agents can put buttons in a reply that start a thread with a brief, or message a thread, when pressed
added: 2026-11-07
on: false
reminder: 08ab02d8
---

## What it does

An agent can put buttons partway through its reply, beside the line they're about, so you can set jobs off as you read without typing: one starts a new thread with a brief the agent wrote ("Fill in the form"), another sends a message to a thread that's already going. Hover over a button to see the brief and where it runs. Nothing happens until you press it, and it only runs once: after that it turns green and opens the thread it started. It works the same on your phone and the website. A thread without Full access can't make a button that does more than it could itself, and that's checked again when you press it.

## Lives in

`runner/src/runner/buttons.ts`; `add_button` (`buttonTools`) in `threadbear-mcp.ts`; `buttons.*` in `rpc.ts`; the `button.updated` event; the app's `ThreadbearCore/Protocol/ReplyButton.swift` and the pills in `MarkdownRenderer.swift`; the phone's `ReplyButtons.swift` and `ReplyButtonPill.swift`; the website's `reply-button.tsx`; the `press` command and message `buttons` in `convex/`

## Taking it out

Self-contained: delete `buttons.ts` and `buttonTools`; the apps draw an unknown `button:` link as plain text. Leave the Convex field if rows have it.
