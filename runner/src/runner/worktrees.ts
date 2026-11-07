// Thread worktrees: making one before a turn, its Land action, and cleaning up (docs/thread-worktrees.md).
// Part of the Runner (runner.ts), split out on 4 Nov 2026 as a plain move so a
// fork's change to one area doesn't clash with another's. Each method's `this`
// is the Runner; runner.ts puts them on its prototype.
import type { Runner } from '../runner.ts';
import type { RunnerPart } from './part.ts';
import type { Action, EventBody } from '../protocol.ts';
import type { ThreadRecord } from '../store.ts';
import { BIN_DIR, threadEnv } from '../restart.ts';
import { cleanUpWorktree, makeWorktree, sameSubfolder, worktreeGone } from '../worktrees.ts';
import { isDirectory } from '../fsutil.ts';
import { automaticTrust, findWorktreePatch, isInside, readWorktreePatch, runCommand, type PatchSet, worktreePatchFiles } from '../patches.ts';
import fs from 'node:fs';
import path from 'node:path';
import type { ThreadState } from '../runner.ts';

export const worktreesPart = {
  // ------------------------------------------------------------ worktrees
  // A worktree per thread (docs/thread-worktrees.md, worktrees.ts).

  // Whether a new thread in `cwd` might get a worktree: there's at least
  // one patch file in its own folder chain to read.
  mayWantWorktree(this: Runner, cwd: string): boolean {
    try {
      return worktreePatchFiles(cwd, this.panelsRoot).length > 0;
    } catch {
      return false;
    }
  },

  // Before a new thread's first turn: if its repo's patch asks for a
  // worktree, makes one, moves the thread into it and runs the patch's
  // setup there. Anything going wrong is said, and the thread starts
  // where it was asked to.
  async prepareWorktree(this: Runner, st: ThreadState, turnId: string): Promise<void> {
    const { rec, rt } = st;
    delete rec.worktreePending;
    this.markDirty(st);
    // A session already ran in the folder (a turn that failed later, say):
    // moving it now would leave that session behind.
    if (rec.sessionUsed || rec.worktree) return;
    let patch;
    try {
      patch = await findWorktreePatch(rec.cwd, this.panelsRoot, this.patchCache, undefined, this.patchTrust);
    } catch (e) {
      this.log.warn('could not read patches for a worktree', { threadId: rec.id, error: String(e) });
      return;
    }
    if (!patch || rt.deleted) return;
    const asked = rec.cwd;
    const made = await makeWorktree({ cwd: asked, threadId: rec.id, patch });
    if (rt.deleted) return;
    if (!made.ok) {
      this.log.warn('could not make a worktree', { threadId: rec.id, reason: made.reason });
      this.emit(st, { type: 'system.note', text: `Couldn't make a worktree for this thread: ${made.reason}. It starts in ${asked} instead.` }, turnId);
      return;
    }
    rec.worktree = made.worktree;
    rec.cwd = made.cwd;
    rec.updatedAt = this.isoNow();
    this.markDirty(st);
    this.log.info('made a worktree', { threadId: rec.id, path: made.worktree.path, branch: made.worktree.branch });
    this.emit(st, { type: 'system.note', text: `Working in a worktree of its own at ${made.worktree.path}, on the branch ${made.worktree.branch}. tb land puts it on main.` }, turnId);
    if (!patch.setup) return;
    const setup = await this.worktreeSetup(made.patchFile, patch.patch);
    if (rt.deleted) return;
    if ('skip' in setup) {
      this.log.warn("didn't run a worktree's setup", { threadId: rec.id, patch: made.patchFile, reason: setup.skip });
      this.emit(st, { type: 'system.note', text: `Didn't run the worktree's setup (${patch.setup}): ${setup.skip}` }, turnId);
      return;
    }
    if (!setup.command) return;
    // Bound to a hashed script, it runs from the worktree: the copy must
    // still hash to the version that approved it, read afresh just now.
    if (setup.run) {
      const by = automaticTrust(setup.run);
      if (!by || !this.patchTrust.verify(by.file, by.hash)) {
        this.emit(st, { type: 'system.note', text: `Didn't run the worktree's setup (${patch.setup}): its patch or a script it runs changed since it was checked.` }, turnId);
        return;
      }
    }
    const outcome = await runCommand(setup.run ?? setup.command, {
      cwd: made.worktree.path,
      env: { ...process.env, ...threadEnv(rec.id, this.cfg.home) },
      shell: this.actionShell,
      timeoutMs: this.actionTimeoutMs,
      background: this.backgroundJobs,
    });
    if (rt.deleted) return;
    const body: EventBody = {
      type: 'action.run',
      actionId: `${patch.patch}.worktree-setup`,
      patch: patch.patch,
      title: 'Set up the worktree',
      command: setup.command,
      ok: outcome.ok,
      text: outcome.text,
      truncated: outcome.truncated,
      durationMs: outcome.durationMs,
      trigger: 'worktree.setup',
    };
    if (outcome.exitCode !== undefined) body.exitCode = outcome.exitCode;
    this.emit(st, body, rt.turn?.turnId ?? turnId);
    this.markDirty(st);
  },

  // The setup to run in a new worktree, from the worktree's own copy of the
  // patch. The patch trusted in the main checkout isn't what runs there:
  // the worktree is main's commit, which can differ from the main
  // checkout's files (an uncommitted edit, a script changed on main), and
  // setup runs by itself. So that copy, with the scripts it names as they
  // are in the worktree, must be a version Mike trusted (Daybreak, 5 Nov).
  // Threadbear's own worktrees count as its checkout, so stay trusted.
  async worktreeSetup(this: Runner, copy: string, id: string): Promise<{ command?: string; run?: string } | { skip: string }> {
    let verdict;
    try {
      verdict = await this.patchTrust.check(copy, fs.statSync(copy).mtimeMs);
    } catch (e) {
      return { skip: `couldn't read its copy of the ${id} patch (${String((e as Error).message ?? e)}).` };
    }
    if (!verdict.trusted) {
      if (verdict.reason === 'unchecked') return { skip: `its copy of the ${id} patch can't be checked: ${verdict.problem}` };
      return { skip: `its copy of the ${id} patch isn't a version you've trusted. Trust it in Patches, then run the setup yourself if you want it.` };
    }
    let again;
    try {
      again = await readWorktreePatch(copy, this.patchCache, undefined, this.patchTrust);
    } catch (e) {
      return { skip: `couldn't load its copy of the ${id} patch (${String((e as Error).message ?? e)}).` };
    }
    // Refused as it loaded: a setup that isn't one hashed script, say.
    if (again && 'error' in again) return { skip: `its copy of the ${id} patch didn't load. ${again.error}` };
    // Trusted, but asking for no setup there: nothing to run.
    return { command: again?.setup, run: again?.setupRun };
  },

  // A thread whose worktree was removed (it was archived with everything
  // landed) and has now come back carries on in the main checkout. Returns
  // a line for the agent, whose system prompt still names the worktree.
  // The thread's worktree has gone since its CLI last ran, so its next
  // start moves it to the main checkout (leaveRemovedWorktree). A spare's
  // folder is still there, but it's another thread's (or will be), so the
  // thread never carries on in it.
  leavesRemovedWorktree(this: Runner, rec: ThreadRecord): boolean {
    const w = rec.worktree;
    return Boolean(w?.removedAt && isInside(rec.cwd, w.path) && (w.spare || !isDirectory(rec.cwd)));
  },

  leaveRemovedWorktree(this: Runner, st: ThreadState, turnId: string): string | undefined {
    const { rec } = st;
    const w = rec.worktree;
    if (!w || !this.leavesRemovedWorktree(rec)) return undefined;
    const from = rec.cwd;
    const to = sameSubfolder(from, w.path, w.mainCheckout);
    if (rec.sessionUsed) {
      if (this.adapters[rec.provider]?.movesFolders) rec.moved ??= { fromCwd: from };
      else rec.handoff ??= { fromCwd: from, fromAccountId: rec.accountId };
    }
    rec.cwd = to;
    rec.updatedAt = this.isoNow();
    this.markDirty(st);
    this.tellActivity({ kind: 'moved', threadId: rec.id, from, to });
    const went = w.spare ? 'was handed on to other threads' : 'was removed';
    this.emit(st, { type: 'system.note', text: `This thread's worktree ${went} when it was archived, so it carries on in the main checkout, ${to}.` }, turnId);
    return `[Threadbear] Your worktree at ${w.path} ${went} after its work landed on main. You're now in the main checkout, ${to}, which other threads share: stage your own files by name.`;
  },

  // The Land chip, for a thread with a worktree of its own.
  worktreeAction(this: Runner, rec: ThreadRecord): Action | undefined {
    const w = rec.worktree;
    if (!w || w.removedAt) return undefined;
    // This runner's own tb, in full: a login shell's PATH may not have it.
    const tb = path.join(BIN_DIR, 'tb');
    const quoted = /^[\w./-]+$/.test(tb) ? tb : `'${tb.replace(/'/g, `'\\''`)}'`;
    return {
      id: 'worktree.land',
      title: 'Land',
      kind: 'command',
      command: `${quoted} land`,
      patch: 'worktree',
      note: `Rebase ${w.branch} on main, run the check, then move main to it`,
    };
  },

  actionsOf(this: Runner, st: ThreadState, set: PatchSet): Action[] {
    const land = this.worktreeAction(st.rec);
    return land ? [...set.actions, land] : set.actions;
  },

  // At start (and when a thread is handed over): an archived thread whose
  // worktree and branch have gone (or whose folder another thread has
  // taken) but whose record never said so (a handover saved it mid-cleanup
  // before 6 Nov, THREADBEAR-16, or the runner stopped there) is told now,
  // so it shows no Land chip and, brought back, never carries on in the
  // folder. Each check counts as the thread's cleanup, so a message sent
  // meanwhile waits for it (deliver).
  settleLostCleanups(this: Runner, threads: Iterable<ThreadState> = this.threads.values(), retry = true): Promise<void> {
    const checks = [];
    for (const st of threads) {
      const { rec, rt } = st;
      const w = rec.worktree;
      if (!rec.archivedAt || !w || w.removedAt || rt.cleaning) continue;
      // Archived, but the runner went before the cleanup ran: it's still to
      // do, not just to record. Not from a handover: one that comes with this
      // still owed gave up waiting for its git (letGo), which may still be
      // removing the folder, and a second one beside it could read that as
      // uncommitted changes. The next start does it.
      const check = (retry && w.cleanupOwed ? this.cleanUpWorktree(st) : worktreeGone(w).then((gone) => {
          if (!gone || rt.deleted || w.removedAt) return;
          w.removedAt = this.isoNow();
          if (gone === 'taken') w.spare = true;
          this.markDirty(st);
          this.log.info("recorded a worktree's removal the record missed", { threadId: rec.id, path: w.path });
        }))
        .catch((e: unknown) => this.log.warn("couldn't check an archived thread's worktree", { threadId: rec.id, error: String(e) }))
        .finally(() => {
          if (rt.cleaning === check) rt.cleaning = undefined;
        });
      rt.cleaning = check;
      checks.push(check);
    }
    return Promise.all(checks).then(() => undefined);
  },

  // When the thread is archived or deleted: its worktree and branch go if
  // everything on them is on main; otherwise they stay, and the thread (or,
  // once it's deleted, a notice) says so and how to land or drop them.
  async cleanUpWorktree(this: Runner, st: ThreadState, deleted = false): Promise<void> {
    const { rec } = st;
    const w = rec.worktree;
    if (!w || w.removedAt) return;
    let result;
    try {
      result = await cleanUpWorktree(w, () => deleted || !st.rt.deleted);
    } catch (e) {
      result = { removed: false as const, reason: String((e as Error).message ?? e) };
    }
    this.log.info('worktree cleanup', { threadId: rec.id, path: w.path, ...result });
    // Deleted meanwhile: nothing to record it in, and emit would throw.
    if (st.rt.deleted && !deleted) return;
    delete w.cleanupOwed;
    if (result.removed) {
      w.removedAt = this.isoNow();
      // A folder that's another checkout's now counts as a spare: the
      // thread, brought back, never carries on in it (leavesRemovedWorktree).
      if (result.spare || result.taken) w.spare = true;
      if (deleted) return;
      const text = result.taken
        ? `This thread's worktree had already gone, and its folder ${w.path} is another checkout's now, so it was left alone. Its branch ${w.branch} is gone too.`
        : w.spare
          ? `Deleted this thread's branch ${w.branch} (everything on it is on main) and kept its worktree, build caches and all, for the next thread.`
          : `Removed this thread's worktree and its branch ${w.branch}: everything on it is on main.`;
      this.emit(st, { type: 'system.note', text });
      this.markDirty(st);
      return;
    }
    const how =
      `To land it, run tb land in ${w.path}${deleted ? '' : ' (or bring the thread back and press Land)'}. ` +
      `To drop it, git -C ${w.mainCheckout} worktree remove --force ${w.path} && git -C ${w.mainCheckout} branch -D ${w.branch}.`;
    if (deleted) {
      this.notice('info', `"${rec.title}" was deleted, but its worktree at ${w.path} and branch ${w.branch} stay: ${result.reason}. ${how}`);
      return;
    }
    this.emit(st, { type: 'system.note', text: `This thread's worktree at ${w.path} and its branch ${w.branch} stay: ${result.reason}. ${how}` });
    this.markDirty(st);
  },
};

export type WorktreesPart = RunnerPart<typeof worktreesPart>;
