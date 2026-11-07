# Bringing in Mike's updates (for an agent)

You're an agent in a thread started by Bring Them In (the app's Updates
panel, From Mike), by the runner on its timer (`runner/src/bring-in.ts`:
every 5 days by default, or straight away for an important release), or
someone asked you to bring in Mike's latest release. A thread the runner
started does the merge and the checks before it asks, so the person
reading it has one decision: land it or not. If they say they don't want
these threads, or want them less often, change `releases.bringIn` in
`runner.json` (a number of days, `"important"` or `"off"`).
A thread started by Let's Discuss uses section 1 to talk the release
through first, and goes on to section 2 only once they say to.
This copy of Threadbear is their fork of `mikecann/threadbear`: `origin` is
theirs and `upstream` is Mike's. Their `main` has their own changes on it,
and your job is to add Mike's release to it without losing any of theirs.
docs/setup-and-updates.md section 2.3 explains the thinking behind it.

## 1. See what's coming

- `tb updates` names the newest release (`release/YYYY-MM-DD`), its
  commit id, and what's in it that main doesn't have. `tb updates check`
  fetches first. The runner only lists releases signed with the key setup
  pinned, and the commit id is the one the signature was checked for.
  Merge that commit id (it's in the message that started this thread
  too), never `upstream/main` (Mike's main can be halfway through
  something) and never anything under `refs/threadbear/upstream-incoming/`,
  which is where an older runner put what upstream served before it was
  checked. If `tb updates` no
  longer lists the release, or names a different commit for it, stop and
  say so rather than merging anything.
- Mike's changes: `git log --no-merges main..<commit>`. His commit
  messages say why, not just what.
- Their changes since they last brought a release in:
  `git log --no-merges <commit>..main`. This is what you must keep.

## 2. Merge, in this thread's own worktree

Threads in this repo get a worktree of their own (docs/thread-worktrees.md),
so main doesn't move until you land. Do it there:

```sh
git merge --no-ff -m "Bring in Mike's release <date>" <commit>
```

Always a merge, never a rebase or a cherry-pick: Mike's commits have to
keep their ids, or the runner never sees this copy as up to date with his
release again. `tb land` knows not to rebase a branch with a merge on it.

## 3. Clashes: keep what each side meant

Git does most of a merge. Where it can't, or where the merge is clean but
the result doesn't make sense, work out what each side was for, from both
sides' commit messages and diffs, and write code that does both:

- If Mike's change now does what theirs did, keep Mike's and drop theirs,
  and say so.
- If theirs changed something Mike has since moved or rewritten, put their
  change back onto Mike's new code rather than keeping the old shape.
- If you can't do both, stop and ask them which they'd rather have, with
  what each does.

Their patches (`.threadbear/patches/`, `~/.threadbear/patches/`) and
settings (`runner.json`) aren't part of the merge. Check they still work
against Mike's changes (docs/protocol.md, "Patches", says what a patch can
use), and fix them if not.

## 4. Check it

- `./check.sh --all` runs every check (several minutes; up to ten for the
  app in a folder that has never built it). All of it must pass before you
  land.
- If the release looks halfway through something (a feature half there, a
  commit that says it's temporary, tests skipped), say so and ask whether
  to land it now or wait for the next release.
- A change to `runner/launcher/` only takes effect after
  `runner/scripts/install-runner.sh`, which they have to run from a
  terminal. Tell them if the release has one.

## 5. Ask, then land

Tell them in a few lines what Mike's release brings, which of their own
changes you had to rework or drop and why, and that the checks passed.
Ask before landing. When they say yes, `tb land`. The runner, the backend
and the app then update themselves from main, as they do for any change.

If something goes wrong afterwards, `git revert -m 1 <merge commit>` on
main takes the whole release back out in one go.

## 6. Offer to push it

`tb land` never pushes, so their own copy on GitHub (`origin`) is still on
the old main: if this Mac went, the merge and anything of theirs not yet
pushed would go with it. Once it's landed, if `git log origin/main..main`
lists anything, say so and ask whether to push it. Run `git push origin
main` only when they say yes. If `origin` isn't on GitHub, or they'd rather
keep main to this Mac, leave it.
