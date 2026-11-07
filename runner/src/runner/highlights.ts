// Highlights (pin, unpin) and showing panels in front of the user (show_panel).
// Part of the Runner (runner.ts), split out on 4 Nov 2026 as a plain move so a
// fork's change to one area doesn't clash with another's. Each method's `this`
// is the Runner; runner.ts puts them on its prototype.
import type { Runner } from '../runner.ts';
import type { RunnerPart } from './part.ts';
import type { PanelPlace, PanelRequest, ThreadSummary } from '../protocol.ts';
import { ErrorCode, RpcError } from '../protocol.ts';
import { cutOut } from '../store.ts';
import { emptyHighlights, MAX_URL, observe as observeHighlights, pinItem, remove as removeHighlight, unpin as unpinHighlight, upsert as upsertHighlight, view as highlightsView, absolute, type ThreadHighlights } from '../highlights.ts';
import { PANEL_ACK_WAIT_MS, PANEL_PLACES, resolvePanel } from '../panel-requests.ts';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type { ThreadState } from '../runner.ts';

export const highlightsPart = {
  // What the thread has made, shared and pinned (docs/protocol.md,
  // "Highlights"): brought up to date from the events since the last ask.
  highlights(this: Runner, threadId: string): ThreadHighlights {
    const st = this.mustGet(threadId);
    this.catchUpHighlights(st);
    return highlightsView(st.rec.highlights!, st.rec.brief);
  },

  removeHighlight(this: Runner, threadId: string, highlightId: string): { thread: ThreadSummary } {
    const st = this.mustGet(threadId);
    this.catchUpHighlights(st);
    if (!removeHighlight(st.rec.highlights!, highlightId)) throw new RpcError(ErrorCode.badParams, `This thread has no highlight ${highlightId}`);
    this.highlightsChanged(st);
    return { thread: this.summary(st) };
  },

  // The `pin` tool: a file (relative to the thread's folder is fine) or a
  // URL, for Mike to look at. Returns the highlight's id.
  pin(this: Runner, threadId: string, target: { path?: string; url?: string; title?: string; note?: string; show?: boolean }): { id: string; scriptsOff?: true } {
    const st = this.mustGet(threadId);
    if (Boolean(target.path) === Boolean(target.url)) throw new RpcError(ErrorCode.badParams, 'Pin a path or a url, one of the two.');
    let file: string | undefined;
    if (target.path) {
      file = absolute(target.path, st.rec.cwd);
      if (!fs.statSync(file, { throwIfNoEntry: false })?.isFile()) throw new RpcError(ErrorCode.badParams, `There's no file at ${file}.`);
    } else if (!/^[a-z][a-z0-9+.-]*:\/\/\S/i.test(target.url!)) {
      throw new RpcError(ErrorCode.badParams, 'A url needs a scheme, like https://.');
    } else if (target.url!.length > MAX_URL) {
      throw new RpcError(ErrorCode.badParams, `That url is over ${MAX_URL} characters.`);
    }
    this.catchUpHighlights(st);
    const state = st.rec.highlights!;
    const item = pinItem({ ...target, path: file }, st.rec.lastSeq, this.isoNow());
    // Pinning something Mike removed is the agent asking again: let it.
    state.removed = state.removed?.filter((id) => id !== item.id);
    upsertHighlight(state, item);
    this.highlightsChanged(st);
    return file && pageHasScripts(file) ? { id: item.id, scriptsOff: true } : { id: item.id };
  },

  unpin(this: Runner, threadId: string, highlightId: string): { removed: boolean } {
    const st = this.mustGet(threadId);
    this.catchUpHighlights(st);
    const removed = unpinHighlight(st.rec.highlights!, highlightId);
    if (removed) this.highlightsChanged(st);
    return { removed };
  },

  // The show_panel tool (docs/protocol.md, "Showing panels"): the request
  // waits on the thread, replacing an older one, for the app to show once
  // Mike is looking at it. Resolves when the app says it has, or after
  // waitMs with shown false. Everything up to the wait runs before the
  // promise is returned, so the request is there as soon as this is called.
  async showPanel(this: Runner, threadId: string, ask: { panel: string; where?: PanelPlace }, waitMs = PANEL_ACK_WAIT_MS): Promise<{ request: PanelRequest; shown: boolean }> {
    const st = this.mustGet(threadId);
    if (ask.where !== undefined && !PANEL_PLACES.includes(ask.where)) {
      throw new RpcError(ErrorCode.badParams, `where is ${PANEL_PLACES.slice(0, -1).join(', ')} or ${PANEL_PLACES.at(-1)}.`);
    }
    const set = this.patchSet(st);
    let panel: { id: string; title: string };
    try {
      panel = resolvePanel(ask.panel, { panels: set.panels, hasPatches: set.patches.length > 0 || Boolean(this.worktreeAction(st.rec)) });
    } catch (e) {
      throw new RpcError(ErrorCode.badParams, (e as Error).message);
    }
    const request: PanelRequest = { id: crypto.randomUUID(), panel: panel.id, title: panel.title, at: this.isoNow() };
    if (ask.where) request.where = ask.where;
    this.endPanelWait(st, false);
    st.rec.panelRequest = request;
    this.markDirty(st);
    const shown = await new Promise<boolean>((resolve) => {
      const timer = this.clock.setTimeout(() => this.endPanelWait(st, false), waitMs);
      st.rt.panelWaiter = { id: request.id, resolve, timer };
    });
    return { request, shown };
  },

  // The app has shown the thread's panel request: it's done.
  panelShown(this: Runner, threadId: string, requestId: string): { thread: ThreadSummary } {
    const st = this.mustGet(threadId);
    if (st.rec.panelRequest?.id === requestId) {
      delete st.rec.panelRequest;
      if (st.rt.panelWaiter?.id === requestId) this.endPanelWait(st, true);
      this.markDirty(st);
    }
    return { thread: this.summary(st) };
  },

  endPanelWait(this: Runner, st: ThreadState, shown: boolean): void {
    const waiter = st.rt.panelWaiter;
    if (!waiter) return;
    st.rt.panelWaiter = undefined;
    waiter.timer.cancel();
    waiter.resolve(shown);
  },

  catchUpHighlights(this: Runner, st: ThreadState): void {
    const state = (st.rec.highlights ??= emptyHighlights());
    const log = this.store.log(st.rec.id);
    if (state.seq >= log.lastSeq) return;
    // A page at a time, so a long thread's first look doesn't hold
    // thousands of events at once.
    for (let from = state.seq + 1; from <= log.lastSeq; from += 500) {
      const to = Math.min(log.lastSeq, from + 499);
      observeHighlights(state, log.read(from, to).filter((e) => !cutOut(st.rec, e.seq)), { cwd: st.rec.cwd });
      state.seq = Math.max(state.seq, to);
    }
    this.markDirty(st);
  },

  highlightsChanged(this: Runner, st: ThreadState): void {
    // markDirty sends the summary, whose new highlightsAt tells clients
    // to fetch again.
    st.rec.highlightsAt = this.isoNow();
    this.markDirty(st);
  },
};

export type HighlightsPart = RunnerPart<typeof highlightsPart>;

// A local page the Mac app previews runs none of its own scripts until Mike
// chooses Run them over it (Daybreak finding 6), so a page that draws itself
// shows as empty boxes at first. `pin` tells the agent (6 Nov 2026). The app's note over the page uses the same
// test (LocalPreviewSite.hasScripts): a `<script`, an `on...=` handler or a
// `javascript:` link. Opened without blocking and checked on the open file,
// so a FIFO swapped in after pin's stat can't hang the runner (Codex review).
// The test is `/<script|<[^>]*\son[a-z]+\s*=|javascript:/i`, read in one pass
// (hasScriptMarks): as a regex, a page of 4 MB of "<" with no ">" started
// a scan to its end at every "<", which held the runner for hours.
export function pageHasScripts(file: string): boolean {
  if (!/\.html?$/i.test(file)) return false;
  let fd: number | undefined;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK);
    if (!fs.fstatSync(fd).isFile()) return false;
    const buf = Buffer.alloc(4 * 1024 * 1024);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    return hasScriptMarks(buf.subarray(0, n).toString('utf8'));
  } catch {
    return false;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

// A handler counts inside a tag: after a "<" with no ">" since, which is what
// `<[^>]*` before it allowed.
export function hasScriptMarks(html: string): boolean {
  if (/<script|javascript:/i.test(html)) return true;
  let lastOpen = -1;
  let lastClose = -1;
  let read = 0;
  for (const m of html.matchAll(/\son[a-z]+\s*=/gi)) {
    for (; read < m.index; read++) {
      if (html[read] === '<') lastOpen = read;
      else if (html[read] === '>') lastClose = read;
    }
    if (lastOpen > lastClose) return true;
  }
  return false;
}
