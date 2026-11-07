---
id: labReview
name: Review by another lab
title: Review by another lab: a code change is checked by the other provider before the thread finishes
added: 2026-11-06
on: false
reminder: 16b56f61
---

## What it does

When a turn that changed code (five lines or more, not counting docs) finishes with nothing for you to do, Threadbear starts a review thread in the same folder on your other provider: Codex reviews a Claude thread's change, and Claude a Codex one's. It's told to try to break the change and not to edit anything. It runs with the same permissions as the thread it reviews: a Full access thread's review has full access, and one in Ask before edits or Auto asks or checks the same way, so a change made from text you don't trust can't get its tests run with no card. The thread says who is reviewing, and hibernates until the review finishes. Then it wakes with the findings, fixes what holds up, and says in its reply what was found and what it did. The review thread is archived when it's done, so it stays out of your inbox; the link in the note opens it. A thread gets at most two reviews between your messages. With no login of another provider, a fresh session of the same one reviews, and the note says it isn't another lab. A folder a pool is kept for (Accounts, pools and Usage, above) is only ever reviewed on that pool's logins.

## Lives in

`runner/src/runner/lab-review.ts`; `waitOnReview` and `deliverReview` in `runner/src/runner/hibernation.ts`; the call in `completeTurn` (`runner.ts`)

## Taking it out

Self-contained: delete the file and those three hooks.
