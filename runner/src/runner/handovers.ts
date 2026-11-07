// Handovers: draining this runner after a new release takes over, and adopting threads from the old one (docs/protocol.md, "Handovers").
// Part of the Runner (runner.ts), split out on 4 Nov 2026 as a plain move so a
// fork's change to one area doesn't clash with another's. Each method's `this`
// is the Runner; runner.ts puts them on its prototype.
import type { Runner } from '../runner.ts';
import type { RunnerPart } from './part.ts';
import type { ThreadSummary } from '../protocol.ts';
import type { Drain, ThreadState } from '../runner.ts';
import { DRAIN_AGENT_MS, DRAIN_BACKGROUND_MS, DRAIN_CHECK_MS, DRAIN_MAX_OLD_MS, DRAIN_SETTLE_MS, newRuntime } from '../runner.ts';

// How long a handover waits for an archive's worktree cleanup (letGo).
// Removing a big worktree can take a while, and a git change still running
// when the wait ends can't be stopped (cleanUpWorktree's stillOurs only
// stops the next one), so this is long: past it, git has hung.
const CLEANUP_WAIT_MS = 10 * 60_000;

export const handoversPart = {
  // This runner is handing over to a new release. `keep` are the busy
  // threads it goes on running; every other thread is let go now (an idle
  // CLI exits, and the new runner resumes it by session id). Resolves once
  // those CLIs have gone, so the new runner never resumes a session beside
  // its old CLI. Each kept thread is let go in turn once nothing would be
  // cut short, and onHandedOver hears its id after its thread.json is saved.
  //
  // `ready` says whether the new runner is there to hear about one (it has
  // connected); until it is, threads stay here, and recheckHandovers() looks
  // again once it does.
  async beginDrain(this: Runner, keep: Iterable<string>, opts: { onHandedOver: (threadId: string) => void; backgroundMs?: number; agentMs?: number; checkMs?: number; ready?: () => boolean }): Promise<void> {
    if (this.draining) throw new Error('already draining');
    const d: Drain = {
      // A thread whose worktree cleanup is running stays until it's done
      // (letGo), as a busy one would, so the rest go now rather than wait.
      // So does one with a turn-end hook running: the restarter doesn't
      // count that as busy, but its result may start a turn, and an archive
      // waiting for it (archiveWhenGone) isn't saved anywhere to pick up.
      keep: new Set([...keep, ...[...this.threads.values()].filter((st) => st.rt.cleaning || st.rt.hooksRunning).map((st) => st.rec.id)].filter((id) => this.threads.has(id))),
      going: new Set(),
      gone: new Set(),
      onHandedOver: opts.onHandedOver,
      since: this.clock.now(),
      backgroundMs: opts.backgroundMs ?? DRAIN_BACKGROUND_MS,
      agentMs: opts.agentMs ?? DRAIN_AGENT_MS,
      checkMs: opts.checkMs ?? DRAIN_CHECK_MS,
      checkQueued: false,
      ready: opts.ready ?? (() => true),
    };
    this.draining = d;
    // Accounts are the primary's to watch now.
    this.rescanTimer?.cancel();
    this.accountsTimer?.cancel();
    await Promise.all([...this.threads.values()].filter((st) => !d.keep.has(st.rec.id)).map((st) => this.letGo(st)));
    this.log.info('let go of the idle threads', { keeps: [...d.keep] });
    this.checkHandovers();
  },

  // The threads a draining runner still has; undefined when not draining.
  keeping(this: Runner): string[] | undefined {
    return this.draining ? [...this.draining.keep] : undefined;
  },

  // Whether this runner has the thread (a draining one lets them go).
  has(this: Runner, threadId: string): boolean {
    return this.threads.has(threadId);
  },

  recheckHandovers(this: Runner): void {
    this.queueHandoverCheck();
  },

  queueHandoverCheck(this: Runner): void {
    const d = this.draining;
    if (!d || d.checkQueued) return;
    d.checkQueued = true;
    this.defer(() => {
      d.checkQueued = false;
      this.checkHandovers();
    });
  },

  checkHandovers(this: Runner): void {
    const d = this.draining;
    if (!d || this.stopping) return;
    d.timer?.cancel();
    d.timer = undefined;
    for (const id of d.ready() ? [...d.keep] : []) {
      const st = this.threads.get(id);
      if (!st) {
        // Deleted while kept.
        d.keep.delete(id);
        continue;
      }
      if (d.going.has(id) || !this.readyToHandOver(st, d)) continue;
      d.going.add(id);
      void this.letGo(st).then(
        () => {
          d.going.delete(id);
          d.keep.delete(id);
          this.log.info('handed a thread over', { threadId: id, left: d.keep.size });
          d.onHandedOver(id);
        },
        (e: unknown) => {
          d.going.delete(id);
          this.log.error('could not hand a thread over', { threadId: id, error: String(e) });
        },
      );
    }
    // Background work's limit passes without anything else happening.
    if (d.keep.size > d.going.size) d.timer = this.clock.setTimeout(() => this.checkHandovers(), d.checkMs);
  },

  // Nothing would be cut short by letting it go now: no turn, approval or
  // question, wake grace, turn-end hook or action. Queued messages go with
  // it. Background shells and monitors hold it for backgroundMs after its
  // last turn (a dev server never ends), or DRAIN_SETTLE_MS once it has
  // been here DRAIN_MAX_OLD_MS, and are then stopped with a note, and the thread told
  // on the new runner. Subagents hold it for agentMs: they
  // finish by themselves, and stopping one throws away its work (27 Oct: a
  // builder agent an agent left running was cut off after 30 minutes).
  readyToHandOver(this: Runner, st: ThreadState, d: Drain): boolean {
    const { rt } = st;
    if (rt.turn || rt.approvals.size || rt.wakeTimer || rt.hooksRunning || rt.runningActions?.size) return false;
    if (rt.tasks.length === 0) return true;
    const idleFor = this.clock.now() - rt.activeAt;
    if (rt.tasks.some((t) => t.kind === 'agent')) return idleFor >= d.agentMs;
    if (this.clock.now() - d.since >= DRAIN_MAX_OLD_MS && idleFor >= DRAIN_SETTLE_MS) return true;
    return idleFor >= d.backgroundMs;
  },

  // Lets go of a thread for good: its CLI exits (background work, if any,
  // is stopped with a note), its record is saved, and anything the old CLI
  // still reports goes nowhere.
  async letGo(this: Runner, st: ThreadState): Promise<void> {
    const { rt, rec } = st;
    rt.idleTimer?.cancel();
    rt.idleTimer = undefined;
    this.flushDeltas(st);
    if (rt.session && !rt.closing) {
      this.rememberStoppedWork(st);
      this.releaseSession(st);
    }
    if (rt.closing) await rt.closing;
    // An archive's worktree cleanup, started as the CLI went: its removedAt
    // and note belong in the record saved below (THREADBEAR-16). Not for
    // ever, as git can hang (a hook): past the limit the record goes as it
    // is, and the adopting runner settles it (settleLostCleanups).
    if (rt.cleaning) {
      let timer: { cancel(): void } | undefined;
      const late = new Promise<void>((resolve) => (timer = this.clock.setTimeout(resolve, CLEANUP_WAIT_MS)));
      const finished = await Promise.race([rt.cleaning.then(() => true), late.then(() => false)]);
      timer?.cancel();
      if (!finished) this.log.warn('handed a thread over before its worktree cleanup finished', { threadId: rec.id });
    }
    // Deleted while it waited: its folder has gone to trash, and saving
    // would bring it back.
    if (rt.deleted) return;
    rt.deltaTimer?.cancel();
    rt.wakeTimer?.cancel();
    rt.generation++;
    this.store.save(rec);
    rt.deleted = true;
    this.dirty.delete(rec.id);
    this.threads.delete(rec.id);
    this.draining?.gone.add(rec.id);
    this.store.forget(rec.id);
  },

  // Loads a thread a draining runner has handed over and carries on with
  // it: messages queued while it was busy there start now. `crashed`: the
  // draining runner died with it, so it's recovered as after a crash (a
  // turn in flight ends as stopped).
  adopt(this: Runner, threadId: string, opts: { crashed?: boolean } = {}): ThreadSummary | undefined {
    const had = this.threads.get(threadId);
    if (had) return this.summary(had);
    this.store.forget(threadId);
    const rec = this.store.load(threadId) ?? this.rebuild(threadId);
    if (!rec) {
      this.log.warn('a handed-over thread is gone', { threadId });
      return undefined;
    }
    rec.lastSeq = this.store.log(rec.id).lastSeq;
    const st: ThreadState = { rec, rt: newRuntime(Date.parse(rec.lastActivityAt) || 0) };
    this.threads.set(rec.id, st);
    // A thread that was busy on the old runner comes across here, not at
    // start, so it learns its "You: ..." line here too.
    if (rec.asked === undefined && !rec.archivedAt) this.backfillAsked(rec);
    this.recoverReviews(st);
    // Handed over before its worktree cleanup finished (letGo's limit).
    void this.settleLostCleanups([st], false);
    if (opts.crashed) {
      // main.ts carries it on (carryOnStopped), after any resume of its own.
      if (this.recover(st)) this.notice('info', `The old runner stopped while "${rec.title}" was mid-turn.`);
    }
    // Hibernating until the runner restarts: for this thread, coming across
    // is the restart.
    if (this.wakesOnStart(rec)) this.wake(st, 'restart');
    else if (rec.queue.length && this.bucket(rec) === 'inbox') {
      this.kickQueue(st);
    }
    this.tellOneStoppedWork(st);
    this.markDirty(st);
    this.armSnoozeTimer();
    this.armRoomTimer();
    this.armNetTimer(true);
    this.log.info('adopted a thread', { threadId, crashed: Boolean(opts.crashed), queued: rec.queue.length });
    return this.summary(st);
  },
};

export type HandoversPart = RunnerPart<typeof handoversPart>;
