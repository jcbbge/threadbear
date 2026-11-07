---
id: richBlocks
name: Diagrams and pages in replies
title: Diagrams and pages in replies: agents are told the apps draw ```mermaid and ```html blocks
added: 2026-11-06
on: false
reminder: 72b91442
---

## What it does

Tells agents that Threadbear draws ```` ```mermaid ```` and ```` ```html ```` blocks (Reading a reply, above), so they use one when a picture explains better than words. The apps draw those blocks either way; this is only whether agents are told.

## Lives in

app `Transcript/RichBlocks.swift`, `RichRenderer.swift`, `Views/PreviewSandbox.swift`, Core `Markdown/RichBlock.swift`, `Resources/Rich/pele.js`; phone `ios/Threadbear/RichBlockView.swift`, `ios/Threadbear/Rich/`, `.rich` in ThreadbearKit `MarkdownBlocks.swift`; `RICH_BLOCKS_LINE` in `threadbear-mcp.ts`

## Taking it out

Self-contained: the `richBlock` case in `MarkdownRenderer.swift`, `richStamp` in `RowRenderer.swift`, `richChanged` in `TranscriptController.swift` and the rich parts of `TextKit.swift`; on the phone the `.rich` case. `PreviewSandbox` stays, the side pane uses it.
