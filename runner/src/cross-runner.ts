// Starting a thread on another runner from an agent's create_thread
// (docs/protocol.md, "Asking another runner").
//
// The main Mac's runner holds the owner key and starts it straight away,
// through the relay. A runner on a runner key (the cloud, Bruce) may not
// queue work for another runner (Runner keys), so it asks instead: it files
// the whole request in the backend, where it can't change it afterwards,
// and shows a card in its own thread. The main Mac's app reads the request
// back through its own runner (requests.get), shows Mike all of it, and on
// Allow its runner starts the thread (requests.answer), marks the request
// allowed and answers the card. The asking runner believes only the
// backend's row, never the answer's words, so a phone or an old app that
// says "allow" without starting anything changes nothing.
import crypto from 'node:crypto';
import { ErrorCode, RpcError } from './protocol.ts';
import type { RunnerRequestInput, RunnerRequestRow } from './sync.ts';
import { wasNotSent } from './relay.ts';

// The card's name in approval.requested, which the Mac app draws as a
// request rather than a tool's approval.
export const START_CARD = 'threadbear.start_thread';
// How long the asking agent waits for Mike before the card expires.
export const REQUEST_WAIT_MIN = 60;

export type StartRequest = RunnerRequestInput & { runner: string };

export type RequestAnswer =
  | { status: 'started'; runnerId: string; runnerName: string; threadId: string }
  | { status: 'declined' | 'expired'; message?: string };

export type RunnerRef = { id: string; name: string; self: boolean; online?: boolean };

export type CrossRunnerDeps = {
  self: () => { id: string; name: string };
  // The backend with this runner's key; undefined while sync is off.
  backend: () =>
    | {
        ownerKey(): boolean;
        fileRequest(p: { requestId: string; threadId: string; target: string; request: RunnerRequestInput }): Promise<void>;
        runnerRequest(requestId: string): Promise<RunnerRequestRow | null>;
        decideRequest(p: { requestId: string; docId: string; state: 'claimed' | 'allowed' | 'pending' | 'denied'; result?: { runnerId: string; runnerName: string; threadId: string } }): Promise<void>;
        closeRequest(requestId: string): Promise<void>;
      }
    | undefined;
  // Every runner the owner key can see, this one first (schedules.ts runners()).
  runners: () => Promise<RunnerRef[]>;
  createHere: (p: RunnerRequestInput & { startedBy?: { kind: 'thread'; label: string; threadId?: string; why?: string } }) => Promise<{ id: string }>;
  createThere: (runnerId: string, p: RunnerRequestInput) => Promise<{ id: string }>;
  // Shows the card in one of this runner's threads and waits for its answer.
  card: (threadId: string, c: { approvalId: string; title: string; input: Record<string, unknown>; minutes: number; check: () => Promise<RequestAnswer> }) => Promise<RequestAnswer>;
  // The open card on another runner's thread, as the backend's row has it.
  openCard: (threadId: string) => Promise<string | undefined>;
  // Answers another runner's card through the relay.
  respondThere: (threadId: string, approvalId: string, decision: 'allow' | 'deny', message?: string) => Promise<void>;
};

const bad = (m: string) => new RpcError(ErrorCode.badParams, m);
const other = (m: string) => new RpcError(ErrorCode.other, m);

// What the agent's text arrives as on the new thread: said by the main
// Mac's runner, not by the runner that asked, so the new thread knows where
// the brief came from and that its words are that runner's.
// Both come from the asking runner (its thread's id, its name), so only
// characters that can't end the line or the brackets get in.
export function askedHeader(row: Pick<RunnerRequestRow, 'threadId' | 'runnerName'>): string {
  const id = row.threadId.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64);
  const name = row.runnerName.replace(/[^A-Za-z0-9 _.'-]/g, '').slice(0, 40).trim() || 'another runner';
  return `[Asked for by thread ${id} on ${name}, and allowed by the user on this Mac. The brief below is that thread's. To report back, send_message to thread ${id}.]\n\n`;
}

// What Mike read, so Start it starts only that: a request filed again
// under the same id (after the week's sweep, say) has another time and
// so another fingerprint.
export function fingerprint(row: RunnerRequestRow): string {
  const fields = [row.docId, row.requestId, row.runnerId, row.threadId, row.target, row.text, row.title, row.cwd, row.model, row.effort, row.permissionMode, row.why, row.createdAt];
  return crypto.createHash('sha256').update(JSON.stringify(fields)).digest('hex');
}

export class CrossRunner {
  private deps: CrossRunnerDeps;
  // Requests being started now, so a double click starts one thread.
  private starting = new Set<string>();

  constructor(deps: CrossRunnerDeps) {
    this.deps = deps;
  }

  private isSelf(name: string): boolean {
    const s = this.deps.self();
    const n = name.trim().toLowerCase();
    return n === s.id.toLowerCase() || n === s.name.toLowerCase() || n === 'this' || n === 'here';
  }

  // "main", a name or an id, as a runner the owner key can see.
  async resolve(name: string): Promise<RunnerRef | undefined> {
    const list = await this.deps.runners();
    const want = name.trim().toLowerCase();
    if (!want || want === 'main' || want === 'mac' || want === 'my mac') return list.find((r) => r.self);
    return list.find((r) => r.id.toLowerCase() === want) ?? list.find((r) => r.name.toLowerCase() === want);
  }

  /**
   * An agent's create_thread with a runner. Answers with what to tell the
   * agent. A runner that's this one isn't elsewhere: the caller starts it
   * here as usual (returns undefined).
   */
  async start(threadId: string, req: StartRequest): Promise<string | undefined> {
    if (this.isSelf(req.runner)) return undefined;
    const backend = this.deps.backend();
    if (!backend) throw other("This runner isn't connected to Threadbear's Convex backend, so it can't reach another runner.");
    const { runner, ...request } = req;
    if (backend.ownerKey()) {
      const target = await this.resolve(runner);
      if (!target) throw bad(`No runner called ${runner}. Runners: ${(await this.deps.runners()).map((r) => r.name).join(', ')}.`);
      if (target.self) return undefined;
      const t = await this.deps.createThere(target.id, request);
      return `Started thread ${t.id} on ${target.name}. Use read_thread to see how it goes.`;
    }
    const approvalId = crypto.randomUUID();
    // Plan first goes as Ask: a main runner from before Plan first dropped
    // the mode it didn't know and started the thread on full access, and
    // the request row has no room for a flag an older one would ignore
    // (Codex review, 7 Nov 2026). Ask is as careful, and works everywhere.
    if (request.permissionMode === 'plan') request.permissionMode = 'ask';
    await backend.fileRequest({ requestId: approvalId, threadId, target: runner, request });
    const input: Record<string, unknown> = { runner, ...request };
    const answer = await this.deps.card(threadId, {
      approvalId,
      title: `Start a thread on ${runner}?`,
      input,
      minutes: REQUEST_WAIT_MIN,
      check: async () => {
        const row = await backend.runnerRequest(approvalId);
        if (row?.state === 'allowed' && row.result) return { status: 'started', ...row.result };
        if (row?.state === 'denied' || row?.state === 'closed') return { status: 'declined' };
        if (row?.state === 'claimed') throw bad('The main Mac is starting it now.');
        throw bad('Answer this in the Threadbear app on the main Mac: it starts the thread from there.');
      },
    });
    // Closed here without starting (declined, expired, Mike wrote instead):
    // so it stops counting against this runner's few, and can't be started late.
    if (answer.status !== 'started') await backend.closeRequest(approvalId).catch(() => {});
    if (answer.status === 'started') return `The user allowed it: started thread ${answer.threadId} on ${answer.runnerName}. It can report back here with send_message; this thread can't read or message it.`;
    if (answer.status === 'declined') return `The user said no${answer.message ? `: ${answer.message}` : ''}. Don't ask again unless they say so.`;
    return `Nobody answered in ${REQUEST_WAIT_MIN} minutes, so nothing was started.`;
  }

  /** requests.get, on the main Mac: the request as it was filed, and where it would start. */
  async get(threadId: string, approvalId: string): Promise<{ request: RunnerRequestRow; target?: RunnerRef; runners: RunnerRef[]; fingerprint: string }> {
    const row = await this.row(threadId, approvalId);
    const runners = await this.deps.runners();
    const target = await this.resolve(row.target);
    return { request: row, ...(target ? { target } : {}), runners, fingerprint: fingerprint(row) };
  }

  /** requests.answer, on the main Mac: start it (on `runnerId`, or the one it asked for) or say no. */
  async answer(threadId: string, approvalId: string, allow: boolean, runnerId?: string, shown?: string): Promise<{ thread?: { id: string; runnerId: string; runnerName: string } }> {
    const backend = this.mustOwn();
    const row = await this.row(threadId, approvalId);
    if (row.state !== 'pending') throw bad(`That request is ${row.state === 'claimed' ? 'being started' : `already ${row.state}`}.`);
    if (allow && shown !== fingerprint(row)) throw bad('That request has changed since the card showed it. Open the thread again to read it.');
    // Only while its card is still open: one that expired or was answered
    // from the phone has an agent that's no longer waiting.
    if ((await this.deps.openCard(threadId)) !== approvalId) throw bad('That request has closed: its thread is no longer waiting for it.');
    if (!allow) {
      await backend.decideRequest({ requestId: approvalId, docId: row.docId, state: 'denied' });
      await this.deps.respondThere(threadId, approvalId, 'deny');
      return {};
    }
    if (this.starting.has(approvalId)) throw bad('That thread is already being started.');
    this.starting.add(approvalId);
    try {
      const target = runnerId ? (await this.deps.runners()).find((r) => r.id === runnerId) : await this.resolve(row.target);
      if (!target) throw bad(`No runner called ${runnerId ?? row.target}. Pick one.`);
      // Said before claiming, so it can be tried again once that Mac is back.
      if (!target.self && target.online === false) throw other(`${target.name} is offline. Try again once it's back.`);
      const { text, title, cwd, model, effort, permissionMode, why } = row;
      const p: RunnerRequestInput = { text: askedHeader(row) + text, ...(title ? { title } : {}), ...(cwd ? { cwd } : {}), ...(model ? { model } : {}), ...(effort ? { effort } : {}), ...(permissionMode ? { permissionMode } : {}) };
      // Claimed in the backend before anything starts, so a retry, a second
      // click or this runner restarting midway can't start it twice.
      await backend.decideRequest({ requestId: approvalId, docId: row.docId, state: 'claimed' });
      let made: { id: string };
      if (target.self) {
        try {
          made = await this.deps.createHere({ ...p, startedBy: { kind: 'thread', label: row.runnerName, threadId: row.threadId, ...(why ? { why } : {}) } });
        } catch (e) {
          // Turned down before anything was made (a folder that isn't one):
          // it can be tried again. Anything else may have made it (a
          // handover passing it to the new runner), so the claim stays.
          if (e instanceof RpcError && e.code === ErrorCode.badParams) await backend.decideRequest({ requestId: approvalId, docId: row.docId, state: 'pending' }).catch(() => {});
          throw e;
        }
      } else {
        // Another runner may still make it after a slow answer, so the
        // claim stays (never a second one), unless nothing was sent.
        made = await this.deps.createThere(target.id, p).catch(async (e: unknown) => {
          if (wasNotSent(e)) {
            await backend.decideRequest({ requestId: approvalId, docId: row.docId, state: 'pending' }).catch(() => {});
            throw e;
          }
          throw other(`${target.name} didn't say it started it (${e instanceof Error ? e.message : String(e)}). It may still: look there before asking again.`);
        });
      }
      const result = { runnerId: target.id, runnerName: target.name, threadId: made.id };
      await backend.decideRequest({ requestId: approvalId, docId: row.docId, state: 'allowed', result });
      // The thread is started and marked whatever happens now: a card the
      // other runner was slow to close isn't an error to show Mike.
      await this.deps.respondThere(threadId, approvalId, 'allow').catch(() => {});
      return { thread: { id: made.id, runnerId: target.id, runnerName: target.name } };
    } finally {
      this.starting.delete(approvalId);
    }
  }

  private mustOwn() {
    const backend = this.deps.backend();
    if (!backend) throw other("This runner isn't connected to Threadbear's Convex backend.");
    if (!backend.ownerKey()) throw other("Only the main Mac's runner can answer another runner's request.");
    return backend;
  }

  private async row(threadId: string, approvalId: string): Promise<RunnerRequestRow> {
    const backend = this.mustOwn();
    const row = await backend.runnerRequest(approvalId);
    // The card's thread must be the one that filed it, so a request can't
    // be answered through another thread's card.
    if (!row || row.threadId !== threadId) throw bad('No such request on that thread.');
    return row;
  }
}
