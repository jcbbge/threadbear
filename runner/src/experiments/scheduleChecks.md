---
id: scheduleChecks
name: Schedule checks
title: Schedule checks: a shell command runs before each scheduled run, and a run whose check prints nothing is skipped
added: 2026-11-06
on: false
reminder: 6328eeda
---

## What it does

A schedule can have a check: a shell command that runs first, in its folder, each time it's due. If the check prints nothing, that run is skipped and no agent starts, so a schedule that looks for new Sentry issues every five minutes only uses a login when there's something to look at. What it prints is added to the message. If the check itself fails, the run goes ahead with the error, so you hear about it. A check has a minute to finish, or up to five if its schedule says so, for one that reads something slow like Slack. What a check prints is kept until a run carrying it has been sent, so a runner restart in between doesn't lose it. Ask a thread to "only run when there's something new" and it writes the check. Run now skips it. It's bound to what it runs: if a script it reaches changes, it doesn't run until the same check is passed to the schedule again, and the thread is told once.

## Lives in

`runner/src/schedule-check.ts`; `checked` and the `check` field in `runner/src/schedules.ts`; `checkArg` in `threadbear-mcp.ts`; `check` on `schedules` in `convex/schema.ts` and `convex/sync.ts`

## Taking it out

Self-contained: delete the file and those lines. Leave the Convex field if rows have it.
