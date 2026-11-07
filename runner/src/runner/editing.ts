// Editing a message the user sent earlier, and cutting the thread back to it.
// Part of the Runner (runner.ts), split out on 4 Nov 2026 as a plain move so a
// fork's change to one area doesn't clash with another's. Each method's `this`
// is the Runner; runner.ts puts them on its prototype.
import { INSTRUCTIONS_REWOUND } from '../instructions.ts';
import type { Runner } from '../runner.ts';
import type { RunnerPart } from './part.ts';
import type { Account, ImageRef, RewoundFiles } from '../protocol.ts';
import { ErrorCode, RpcError, sentByAgent } from '../protocol.ts';
import type { RewindResult } from '../adapters/types.ts';
import type { ThreadRecord } from '../store.ts';
import { cutOut } from '../store.ts';
import { appliedChanges, undoChanges } from '../undo-edits.ts';
import crypto from 'node:crypto';
import type { ThreadState } from '../runner.ts';
import { checkImages, providerName } from '../runner.ts';

export const editingPart = {
  // Mike changes one of his earlier messages and carries on from there
  // (docs/protocol.md, "Editing a message"): the turn stops, the native
  // session is cut back to just before the message, the agent's file
  // changes since are put back, and the new text starts a turn.
  async editMessage(this: Runner, threadId: string, seq: number, text: string, images: ImageRef[] = [], opts: { stopBackground?: boolean } = {}): Promise<{ turnId: string; rewound: { seq: number; fromSeq: number; toSeq: number; files: RewoundFiles } }> {
    const st = this.mustGet(threadId);
    const { rec, rt } = st;
    this.checkAccepting();
    if (this.draining) throw new RpcError(ErrorCode.busy, 'The runner is handing over to a new one; edit again in a moment.');
    if (rt.editing) throw new RpcError(ErrorCode.busy, 'This thread is already going back to an earlier message.');
    if (!text && images.length === 0) throw new RpcError(ErrorCode.badParams, 'text or images required');
    checkImages(images);
    const target = this.editableMessage(st, seq);
    const adapter = this.adapters[rec.provider];
    if (!adapter?.rewind) throw new RpcError(ErrorCode.badParams, `${providerName(rec.provider)} threads can't go back to an earlier message.`);
    const account = this.accounts.get(rec.accountId);
    if (!account) throw new RpcError(ErrorCode.badParams, `Account ${rec.accountId} isn't available on this Mac.`);
    // Going back needs a fresh CLI (it resumes at the cut), and releasing
    // this one stops its background shells and sub-agents, which may have
    // been started turns before the edited message (an upload, 4 Nov). So
    // only once whoever's editing has been told and said yes.
    if (rt.tasks.length && !opts.stopBackground) {
      const what = rt.tasks.map((t) => t.description || t.type).join('; ');
      throw new RpcError(ErrorCode.backgroundRunning, `Still running in the background: ${what}. Going back to an earlier message stops it.`, { background: rt.tasks });
    }
    rt.editing = true;
    // Going back is new work: the answer it replaces isn't a finish.
    delete rec.finished;
    try {
      // Messages waiting behind the turn were sent after the edited one,
      // so they go with the rest.
      if (rec.queue.length) {
        rec.queue = [];
        this.markDirty(st);
      }
      // A turn the CLI starts by itself as the last one ends (a
      // background task's result) is stopped too.
      for (let i = 0; rt.turn && i < 5; i++) {
        const ended = new Promise<void>((r) => (rt.turnEndWaiters ??= []).push(r));
        this.interrupt(rec.id);
        await ended;
      }
      if (rt.session) this.releaseSession(st);
      while (rt.closing) await rt.closing;
      if (rt.deleted || this.threads.get(rec.id) !== st) throw new RpcError(ErrorCode.threadNotFound, `Thread not found: ${threadId}`);
      // Cut the native session. One never started (its first turn failed
      // before the CLI got going) has nothing to cut.
      let cut: RewindResult = { fresh: true };
      if (rec.sessionUsed && rec.nativeSessionId && !rec.handoff) {
        try {
          cut = await adapter.rewind({ threadId: rec.id, account, cwd: rec.cwd, sessionId: rec.nativeSessionId, messageId: target.turnId });
        } catch (e) {
          const err = e as Error;
          if (err.name === 'RewindRefusedError') throw new RpcError(ErrorCode.badParams, err.message);
          this.log.error('could not cut the session back', { threadId: rec.id, error: String(e) });
          throw new RpcError(ErrorCode.other, `Couldn't go back to that message: ${err.message}`);
        }
      }
      const toSeq = this.store.log(rec.id).lastSeq;
      let files: RewoundFiles;
      if (cut.files) files = { ...cut.files, how: 'checkpoint' };
      else {
        const changes = appliedChanges(this.store.log(rec.id).read(seq, toSeq).filter((e) => !cutOut(rec, e.seq)));
        files = changes.length ? { ...undoChanges(changes, rec.cwd), how: 'diffs' } : { undone: [], failed: [], how: 'none' };
      }
      if (cut.fresh) {
        // The message opened the session: a new one, told what came before
        // it when anything did (a handoff from another login, say).
        rec.nativeSessionId = crypto.randomUUID();
        rec.sessionUsed = false;
        rec.sessionCostTotal = 0;
        delete rec.resumeAt;
        if (!rec.handoff && this.saidBefore(rec, seq)) rec.handoff = { fromCwd: rec.cwd, fromAccountId: rec.accountId };
      } else if (cut.resumeAt) rec.resumeAt = cut.resumeAt;
      // The cut may undo what the session was told about them (Codex review).
      if (!cut.fresh && rec.instructionsTold !== undefined) rec.instructionsTold = INSTRUCTIONS_REWOUND;
      (rec.rewinds ??= []).push({ from: seq, to: toSeq });
      const ev = this.emit(st, { type: 'thread.rewound', fromSeq: seq, toSeq, files });
      // What the cut turns left open or found goes with them (pins stay).
      if (rec.needs && rec.needs.seq >= seq) delete rec.needs;
      // A review owed for a turn that's cut (runner/lab-review.ts) goes too:
      // its change was undone.
      if (rec.labReviewOwed && (rec.labReviewOwed.seq ?? Infinity) >= seq) delete rec.labReviewOwed;
      if (rec.highlights?.items.some((h) => h.seq >= seq && h.how !== 'pinned')) {
        rec.highlights.items = rec.highlights.items.filter((h) => h.seq < seq || h.how === 'pinned');
        this.highlightsChanged(st);
      }
      if (rec.panelRequest) {
        delete rec.panelRequest;
        this.endPanelWait(st, false);
      }
      this.markDirty(st);
      this.log.info('went back to an earlier message', { threadId: rec.id, seq, toSeq, how: files.how, undone: files.undone.length, failed: files.failed.length, fresh: Boolean(cut.fresh) });
      rt.editing = false;
      // The edited message goes first; anything sent during the edit after it.
      const later = rec.queue.splice(0);
      const turnId = this.sendTo(st, text, images, { editOf: seq });
      if (later.length) {
        rec.queue.push(...later);
        this.markDirty(st);
        // A slash command the runner answered has already ended its turn.
        if (!rt.turn) this.kickQueue(st);
      }
      return { turnId, rewound: { seq: ev.seq, fromSeq: seq, toSeq, files } };
    } finally {
      if (rt.editing) {
        rt.editing = false;
        // Messages sent while it failed still go.
        if (!rt.turn) this.kickQueue(st);
      }
      this.markDirty(st);
    }
  },

  // The message at `seq`, if Mike can edit it; otherwise why not.
  editableMessage(this: Runner, st: ThreadState, seq: number): { turnId: string } {
    const { rec } = st;
    const log = this.store.log(rec.id);
    const ev = Number.isInteger(seq) && seq >= 1 && seq <= log.lastSeq ? log.read(seq, seq)[0] : undefined;
    const no = (why: string) => new RpcError(ErrorCode.badParams, why);
    if (!ev || ev.type !== 'user.message') throw no(`There's no message at ${seq} to edit.`);
    if (cutOut(rec, seq)) throw no('That message was already taken out by an earlier edit.');
    if ((ev.origin && ev.origin !== 'phone') || sentByAgent(ev.text)) throw no('Only your own messages can be edited.');
    // It started a turn: its turn.started comes straight after it. One sent
    // into a running turn went into that turn and can't be cut out alone.
    const next = log.read(seq + 1, seq + 3).find((e) => e.type === 'turn.started');
    if (!ev.turnId || !next || next.turnId !== ev.turnId) throw no('That message went into a turn that was already running, so it can only be edited with the message that started that turn.');
    return { turnId: ev.turnId };
  },

  // Whether the thread had a message before `seq` that's still part of it.
  saidBefore(this: Runner, rec: ThreadRecord, seq: number): boolean {
    const log = this.store.log(rec.id);
    for (let to = seq - 1; to >= 1; to -= 500) {
      const page = log.read(Math.max(1, to - 499), to);
      if (page.some((e) => (e.type === 'user.message' || e.type === 'assistant.text') && !cutOut(rec, e.seq))) return true;
    }
    return false;
  },
};

export type EditingPart = RunnerPart<typeof editingPart>;
