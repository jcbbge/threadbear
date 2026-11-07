// Design reviews (show_options): making, answering and recovering them (reviews.ts has the files).
// Part of the Runner (runner.ts), split out on 4 Nov 2026 as a plain move so a
// fork's change to one area doesn't clash with another's. Each method's `this`
// is the Runner; runner.ts puts them on its prototype.
import type { Runner } from '../runner.ts';
import type { RunnerPart } from './part.ts';
import { reviewInput, reviewDraft, reviewReply, sameDraft, type ReviewInput } from '../reviews.ts';
import type { DesignReview, ReviewDraft } from '../protocol.ts';
import { ErrorCode, RpcError } from '../protocol.ts';
import type { QueuedSend } from '../store.ts';
import { copyImageInto } from '../media.ts';
import { copyReviewMedia } from '../review-media.ts';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type { SendOptions, ThreadState } from '../runner.ts';
import { fromMike } from '../runner.ts';

export const reviewsPart = {
  createReview(this: Runner, threadId: string, raw: ReviewInput): { review: DesignReview } {
    const st = this.mustGet(threadId);
    this.checkAccepting();
    const input = reviewInput(raw, st.rec.cwd);
    const id = crypto.randomUUID();
    const dir = path.join(this.store.mediaDir(threadId), 'reviews', id);
    const now = this.isoNow();
    try {
      const options = input.options.map(({shots: sources, ...option}) => {
        const shots = sources.map(s => ({...(s.title ? {title: s.title} : {}),
          ...(s.kind === 'video' || s.kind === 'page' ? copyReviewMedia(dir, s.path, s.kind) : {image: copyImageInto(dir, s.path)})}));
        // image stays the first shot for clients that show one per option
        // (a video's or page's still); shots only when there's more to say
        // than that one picture.
        return {...option, image: shots[0].image, ...(shots.length > 1 || shots[0].title || 'media' in shots[0] ? {shots} : {})};
      });
      const review: DesignReview = { id, title: input.title, ...(input.note ? {note: input.note} : {}), ...(input.recommended ? {recommended: input.recommended} : {}), options,
        status: 'pending', revision: 0, createdAt: now, updatedAt: now, draft: {notes: {}} };
      this.persistReview(st, review);
      return {review: structuredClone(review)};
    } catch (e) {
      // Only remove imports if the review was not committed. If an event
      // append failed after the record save, startup repairs its card.
      if (!st.rec.reviews?.some(r => r.id === id)) fs.rmSync(dir, {recursive: true, force: true});
      throw e;
    }
  },

  listReviews(this: Runner, threadId: string): { reviews: DesignReview[] } {
    return { reviews: structuredClone((this.mustGet(threadId).rec.reviews ?? [])
      .filter(review => review.status === 'pending')
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))) };
  },

  getReview(this: Runner, threadId: string, reviewId: string): { review: DesignReview } {
    return {review: structuredClone(this.mustReview(this.mustGet(threadId), reviewId))};
  },

  saveReview(this: Runner, threadId: string, reviewId: string, revision: number, raw: ReviewDraft): { review: DesignReview } {
    const st = this.mustGet(threadId);
    this.checkAccepting();
    const review = this.mustReview(st, reviewId);
    this.checkReviewRevision(review, revision);
    const draft = reviewDraft(review, raw);
    const next = {...review, draft, revision: review.revision + 1, updatedAt: this.isoNow()};
    this.persistReview(st, next);
    return {review: structuredClone(next)};
  },

  respondReview(this: Runner, threadId: string, reviewId: string, revision: number, raw: ReviewDraft): { review: DesignReview; turnId?: string } {
    const st = this.mustGet(threadId);
    const review = this.mustReview(st, reviewId);
    const draft = reviewDraft(review, raw, true);
    // A dropped WebSocket response must not send Mike's answer twice.
    if (review.status === 'answered' && sameDraft(review.response, draft)) {
      this.kickQueue(st);
      return {review: structuredClone(review), turnId: review.replyTurnId};
    }
    this.checkAccepting();
    this.checkReviewRevision(review, revision);
    const turnId = crypto.randomUUID();
    const next: DesignReview = {...review, draft, response: draft, status: 'answered', revision: review.revision + 1, updatedAt: this.isoNow(), replyTurnId: turnId};
    const message: QueuedSend = {turnId, text: reviewReply(review, draft), images: [], reviewId, reviewResponse: draft};
    // The answer and outbox live in one atomic thread.json write. Publish
    // the card only after it succeeds, then start the queued reply.
    this.persistReview(st, next, [...st.rec.queue, message], true);
    st.rt.releaseWhenIdle = false;
    this.markDirty(st);
    this.kickQueue(st);
    return {review: structuredClone(next), turnId};
  },

  cancelReview(this: Runner, threadId: string, reviewId: string, revision: number): {review: DesignReview} {
    const st = this.mustGet(threadId);
    this.checkAccepting();
    const review = this.mustReview(st, reviewId);
    this.checkReviewRevision(review, revision);
    const next: DesignReview = {...review, status: 'cancelled', revision: review.revision + 1, updatedAt: this.isoNow()};
    this.persistReview(st, next);
    return {review: structuredClone(next)};
  },

  // Mike often answers a review by typing in the thread instead of picking
  // in the review window. Left pending, it kept the thread in Needs you
  // (even mid-turn) with nothing left to do. So his own message, from the
  // app or the phone, closes every open review as superseded; the card
  // and window stay readable. Runner, schedule and agent-to-thread
  // messages aren't him and leave reviews open.
  supersedeReviews(this: Runner, st: ThreadState, text: string, opts: SendOptions): void {
    if (!fromMike(text, opts)) return;
    for (const review of st.rec.reviews ?? []) {
      if (review.status !== 'pending') continue;
      this.persistReview(st, {...review, status: 'superseded', revision: review.revision + 1, updatedAt: this.isoNow()});
    }
  },

  mustReview(this: Runner, st: ThreadState, id: string): DesignReview {
    const review = st.rec.reviews?.find(r => r.id === id);
    if (!review) throw new RpcError(ErrorCode.badParams, `Review not found: ${id}`);
    return review;
  },

  checkReviewRevision(this: Runner, review: DesignReview, revision: number): void {
    if (review.status !== 'pending') throw new RpcError(ErrorCode.badParams, `This review is ${review.status}.`);
    if (!Number.isSafeInteger(revision) || review.revision !== revision) throw new RpcError(ErrorCode.badParams, 'This review changed. Reload it before saving or sending your answer.');
  },

  persistReview(this: Runner, st: ThreadState, review: DesignReview, queue = st.rec.queue, wake = false): void {
    const previous = st.rec.reviews ?? [];
    const reviews = previous.some(r => r.id === review.id)
      ? previous.map(r => r.id === review.id ? review : r)
      : [...previous, review];
    const next = {...st.rec, reviews, queue};
    if (wake) {
      delete next.snoozedUntil;
      delete next.snoozedUntilRestart;
      delete next.untilRelease;
      delete next.wakeWhen;
      delete next.waitingOn;
      delete next.archivedAt;
    }
    this.store.save(next);
    if (wake) {
      delete st.rec.snoozedUntil;
      delete st.rec.snoozedUntilRestart;
      delete st.rec.untilRelease;
      delete st.rec.wakeWhen;
      delete st.rec.waitingOn;
      delete st.rec.archivedAt;
    }
    // An answer queued is new work: its last finish no longer counts for
    // threads waiting on it (runner/hibernation.ts).
    if (queue.length > st.rec.queue.length) {
      delete next.finished;
      delete st.rec.finished;
    }
    // Preserve the record object used by any in-flight deliver() callback.
    Object.assign(st.rec, next);
    this.emit(st, {type: 'review.updated', review});
  },

  recoverReviews(this: Runner, st: ThreadState): void {
    // Reviews save their record before their event. Threads without reviews
    // need no extra log scan (the common case, including long transcripts).
    if (!st.rec.reviews?.length && !st.rec.queue.some(q => q.reviewId)) return;
    const log = this.store.log(st.rec.id);
    const latest = new Map<string, DesignReview>();
    const sent = new Set(st.rec.reviewDeliveries ?? []);
    for (const event of log.read(1, log.lastSeq)) {
      if (event.type === 'review.updated') latest.set(event.review.id, event.review);
    }
    const reviews = new Map((st.rec.reviews ?? []).map(r => [r.id, r]));
    for (const [id, review] of latest) if (!reviews.has(id) || reviews.get(id)!.revision < review.revision) reviews.set(id, review);
    if (reviews.size) st.rec.reviews = [...reviews.values()];
    // The delivery marker is written after session.send, not merely after
    // user.message. A failed turn.started append leaves the answer unsent.
    st.rec.queue = st.rec.queue.filter(q => !q.reviewId || !sent.has(q.reviewId));
    for (const [id, review] of reviews) {
      if (review.status === 'answered' && review.replyTurnId && review.response && !sent.has(id) && !st.rec.queue.some(q => q.reviewId === id)) {
        st.rec.queue.push({turnId: review.replyTurnId, text: reviewReply(review, review.response), images: [], reviewId: id, reviewResponse: review.response});
      }
      if (latest.get(id)?.revision !== review.revision) this.emit(st, {type: 'review.updated', review});
    }
    if (reviews.size) this.markDirty(st);
  },
};

export type ReviewsPart = RunnerPart<typeof reviewsPart>;
