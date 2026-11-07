// Making threads: create, Quick Ask's threads, the tour's sample threads, and checking the settings a new thread asks for.
// Part of the Runner (runner.ts), split out on 4 Nov 2026 as a plain move so a
// fork's change to one area doesn't clash with another's. Each method's `this`
// is the Runner; runner.ts puts them on its prototype.
import type { Runner } from '../runner.ts';
import type { RunnerPart } from './part.ts';
import { SAMPLE_THREADS, WELCOME_PATCH } from '../samples.ts';
import type { Account, EffortLevel, ImageRef, MessageOrigin, PermissionMode, ThreadStartedBy, ThreadSummary } from '../protocol.ts';
import { ErrorCode, LIMITS, RpcError } from '../protocol.ts';
import type { Schedule } from '../protocol.ts';
import type { ThreadRecord } from '../store.ts';
import { expandHome, readRunnerJson } from '../config.ts';
import { isDirectory } from '../fsutil.ts';
import { ASK_CODEX_MODEL, HAIKU } from '../models/index.ts';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type { ThreadState } from '../runner.ts';
import { checkImages, effortTitle, isClaudeModel, modelRow, modelTitle, newRuntime, oneLine, providerName, titleFrom, userMessage } from '../runner.ts';
import { cutSafely } from '../safe-cut.ts';

export const newThreadsPart = {
  create(this: Runner, params: {
    text: string;
    images?: ImageRef[];
    cwd?: string;
    accountId?: string;
    poolId?: string;
    model?: string;
    effort?: EffortLevel;
    permissionMode?: PermissionMode;
    title?: string;
    origin?: MessageOrigin;
    scheduleId?: string;
    // false: start in the folder as it is, even in a repo that asks for a
    // worktree per thread.
    worktree?: boolean;
    startedBy?: ThreadStartedBy;
    // Started by a sandboxed thread's agent in a sandbox folder: shut in
    // one too (ThreadRecord.confined).
    confined?: boolean;
  }): { thread: ThreadSummary; turnId: string } {
    if (!params.text && !params.images?.length) throw new RpcError(ErrorCode.badParams, 'text or images required');
    checkImages(params.images ?? []);
    const { st, notes } = this.makeThread(params);
    const turnId = this.sendTo(st, params.text ?? '', params.images ?? [], { origin: params.origin, scheduleId: params.scheduleId });
    // Under the first turn, so they read as part of starting it.
    for (const text of notes) this.emit(st, { type: 'system.note', text }, st.rt.turn?.turnId ?? turnId);
    if (!st.rec.titleSet && params.text?.trim()) void this.titleFromModel(st, params.text);
    return { thread: this.summary(st), turnId };
  },

  // A quick ask the phone already answered out loud (docs/protocol.md, Sync,
  // "quickAsk"), kept as a thread so Mike can carry on in it. It's made as a
  // create with no folder would be, but no turn runs: the exchange is
  // written as a finished turn, seen, and the first message sent to it
  // starts a fresh session with a handoff note saying how it began.
  quickAsk(this: Runner, params: { question: string; answer: string; sources?: { title: string; url: string }[]; askedAt?: number }): { thread: ThreadSummary } {
    const question = params.question.trim();
    const answer = params.answer.trim();
    if (!question || !answer) throw new RpcError(ErrorCode.badParams, 'question and answer required');
    // A follow-up is usually spoken and waited on, so it starts on a small
    // quick model. Mike picked Haiku 5.5 over GPT-6-Luna on 31 Oct as the
    // smarter of the two, though Luna is quicker on long replies (about 10 s
    // for 300 words against 21 to 31). Luna is for a runner with no Claude
    // login. With neither it's the account's default, as naming a model the
    // login can't run would write a note into the thread.
    const usable = this.usableAccounts();
    const speed = usable.some((a) => a.provider === 'claude')
      ? { model: HAIKU }
      : usable.some((a) => a.provider === 'codex')
        ? { model: ASK_CODEX_MODEL, effort: 'low' as const }
        : {};
    const { st, notes } = this.makeThread({ text: question, origin: 'phone', worktree: false, ...speed });
    const { rec } = st;
    const turnId = crypto.randomUUID();
    const sources = (params.sources ?? []).filter((x) => x?.url).slice(0, 10);
    const links = sources.map((x) => `- [${(x.title || x.url).replace(/[[\]]/g, '')}](${x.url})`).join('\n');
    const text = links ? `${answer}\n\n${links}` : answer;
    // In the order startTurn writes them: a user.message after turn.started
    // would read as one sent while the turn ran.
    this.emit(st, userMessage({ turnId, text: question, images: [], origin: 'phone' }), turnId);
    this.emit(st, { type: 'turn.started', turnId }, turnId);
    this.emit(st, { type: 'assistant.text', itemId: crypto.randomUUID(), text }, turnId);
    this.emit(st, { type: 'system.note', text: 'Answered by Ask from Agent Archive' }, turnId);
    for (const note of notes) this.emit(st, { type: 'system.note', text: note }, turnId);
    const askedAt = params.askedAt !== undefined && Number.isFinite(params.askedAt) ? params.askedAt : this.clock.now();
    const done = this.emit(st, { type: 'turn.completed', turnId, outcome: 'completed', durationMs: Math.max(0, this.clock.now() - askedAt), needs: 'nothing' }, turnId);
    rec.needs = { seq: done.seq, needs: 'nothing' };
    rec.preview = oneLine(answer, LIMITS.previewChars);
    rec.lastTurnCompletedSeq = done.seq;
    rec.lastSeenSeq = done.seq;
    // The answer came from a fast model, not a session of this thread's.
    rec.handoff = { fromCwd: rec.cwd, fromAccountId: rec.accountId, quickAsk: true };
    this.markDirty(st);
    void this.titleFromModel(st, question, answer);
    return { thread: this.summary(st) };
  },

  // The tour's sample threads (docs/protocol.md, threads.samples; samples.ts):
  // made up exchanges written as finished turns, like a quick ask, in the
  // folder the app gives (~/ThreadbearThreads/Welcome, where its example patch
  // is), so someone new has threads to hibernate, archive and look round.
  // Asking again makes them afresh; remove deletes them all, archived and
  // hibernating ones too.
  samples(this: Runner, params: { cwd: string; remove?: boolean }): { threads: ThreadSummary[] } {
    // Any there are go first, made fresh each time: ones left by a tour that
    // didn't finish could be hibernating, archived, in another folder, or
    // from a runner that didn't trust the patch yet (Tinker Desk, 30 Oct).
    for (const st of [...this.threads.values()].filter((st) => st.rec.sample)) this.delete(st.rec.id);
    if (params.remove) return { threads: [] };
    // The folder and its example patch, written here and trusted as written:
    // one changed since is someone's code, and waits like any other.
    const cwd = path.resolve(expandHome(params.cwd));
    const patchFile = path.join(cwd, '.threadbear', 'patches', 'welcome.ts');
    fs.mkdirSync(path.dirname(patchFile), { recursive: true });
    if (!fs.existsSync(patchFile)) fs.writeFileSync(patchFile, WELCOME_PATCH);
    if (fs.readFileSync(patchFile, 'utf8') === WELCOME_PATCH) this.trustAgentPatches([{ path: patchFile, sha256: crypto.createHash('sha256').update(WELCOME_PATCH).digest('hex'), base: null }], cwd);
    const made: ThreadSummary[] = [];
    // Oldest first, so the first in SAMPLE_THREADS is the newest in the list.
    for (const sample of [...SAMPLE_THREADS].reverse()) {
      const { st } = this.makeThread({ text: sample.question, cwd, title: sample.title, worktree: false });
      const { rec } = st;
      rec.sample = true;
      const turnId = crypto.randomUUID();
      this.emit(st, userMessage({ turnId, text: sample.question, images: [] }), turnId);
      this.emit(st, { type: 'turn.started', turnId }, turnId);
      this.emit(st, { type: 'assistant.text', itemId: crypto.randomUUID(), text: sample.answer }, turnId);
      const done = this.emit(st, {
        type: 'turn.completed', turnId, outcome: 'completed', durationMs: 4000, needs: sample.needs,
        ...(sample.asks ? { asks: sample.asks } : {}),
      }, turnId);
      rec.needs = { seq: done.seq, needs: sample.needs, ...(sample.asks ? { asks: sample.asks } : {}) };
      rec.preview = oneLine(sample.answer, LIMITS.previewChars);
      rec.lastTurnCompletedSeq = done.seq;
      // Unseen: Needs you, or the blue dot; the rest read.
      if (sample.needs === 'nothing' && !sample.unread) rec.lastSeenSeq = done.seq;
      this.markDirty(st);
      made.push(this.summary(st));
    }
    return { threads: made.reverse() };
  },

  // The record and state of a new thread, before anything is sent to it:
  // its folder, login, model and effort as create picks them.
  makeThread(this: Runner, params: {
    text: string;
    cwd?: string;
    accountId?: string;
    poolId?: string;
    model?: string;
    effort?: EffortLevel;
    permissionMode?: PermissionMode;
    title?: string;
    origin?: MessageOrigin;
    scheduleId?: string;
    worktree?: boolean;
    startedBy?: ThreadStartedBy;
    confined?: boolean;
  }): { st: ThreadState; notes: string[] } {
    this.checkAccepting();
    // New threads belong on the new release.
    if (this.draining) throw new RpcError(ErrorCode.busy, 'This runner is handing over to a new one; start the thread there.');
    // A blank folder means the default, not the runner's own folder.
    const cwd = path.resolve(expandHome(params.cwd?.trim() ? params.cwd.trim() : this.cfg.defaults.cwd));
    // An accountId pins the thread to that login. Otherwise a pool picks
    // the login (docs/protocol.md, "Pools"), except on a dev runner whose
    // keepAccount pins new threads to its own account.
    let poolId: string | undefined;
    let accountId = params.accountId;
    if (accountId === undefined && (params.poolId !== undefined || !readRunnerJson(this.cfg.home).defaults?.keepAccount)) {
      const picked = this.pickForNew({ poolId: params.poolId, cwd, model: params.model });
      if (picked) ({ poolId, accountId } = picked);
    }
    accountId ??= this.defaultAccountId();
    const account = this.accounts.get(accountId);
    if (!account) throw new RpcError(ErrorCode.accountNotFound, `No account called ${accountId}`);
    this.checkProvider(account);
    if (!isDirectory(cwd)) throw new RpcError(ErrorCode.badParams, `Folder not found: ${cwd}`);
    // In a sandbox folder a Claude thread is shut in it from the start. One
    // asked for that which can't be (a Codex login, a folder outside) is
    // refused rather than started outside (sandbox.ts).
    const sandboxed = account.provider === 'claude' && this.sandboxed(cwd);
    if (params.confined && !sandboxed) {
      throw new RpcError(ErrorCode.badParams, account.provider === 'claude' ? `${cwd} isn't in a sandbox folder, and a sandboxed thread can only start threads in one without asking.` : "A sandboxed thread can only start Claude threads, as Codex doesn't run in the sandbox.");
    }
    const now = this.isoNow();
    const id = crypto.randomUUID();
    const rec: ThreadRecord = {
      id,
      title: params.title?.trim() ? cutSafely(params.title.trim(), 200) : titleFrom(params.text),
      titleSet: Boolean(params.title?.trim()),
      cwd,
      accountId,
      ...(poolId ? { poolId } : {}),
      provider: account.provider,
      permissionMode: params.permissionMode ?? 'full',
      ...(sandboxed ? { confined: true as const } : {}),
      status: 'idle',
      createdAt: now,
      updatedAt: now,
      lastActivityAt: now,
      preview: '',
      lastSeq: 0,
      lastSeenSeq: 0,
      nativeSessionId: crypto.randomUUID(),
      sessionUsed: false,
      lastTurnCompletedSeq: 0,
      queue: [],
      pendingApprovals: [],
    };
    const checked = this.checkSettings(account, params.model || this.defaultModelFor(account.provider), params.effort ?? this.defaultEffortFor(account.provider));
    if (checked.model) rec.model = checked.model;
    if (checked.effort) rec.effort = checked.effort;
    // Whether the first turn should look for a worktree patch. Reading the
    // patch files is async, so it happens there; a folder with no patch
    // files at all (most of them) starts its CLI straight away as before.
    if (params.worktree !== false && this.mayWantWorktree(cwd)) rec.worktreePending = true;
    if (params.origin === 'schedule' && params.scheduleId) rec.schedule = { id: params.scheduleId, title: params.title?.trim() || rec.title };
    const startedBy = params.origin === 'schedule' && params.scheduleId ? { kind: 'schedule' as const, label: 'Schedule' } : params.startedBy;
    if (startedBy) {
      // Its title as it is now, for the row's tooltip: that thread may be
      // renamed, archived or deleted later.
      const from = startedBy.threadId ? this.threads.get(startedBy.threadId) : undefined;
      rec.startedBy = { ...startedBy, ...(from ? { threadTitle: from.rec.title } : {}) };
    }
    this.store.create(rec);
    const st: ThreadState = { rec, rt: newRuntime(this.clock.now()) };
    this.threads.set(id, st);
    // What Mike picked last is what the next thread starts on, so a
    // schedule's own login or pool (a 9:00 standup's) doesn't move it.
    if (params.origin === 'schedule') {
      /* keep the last pick */
    } else if (!poolId) this.rememberAccount(accountId);
    else if (params.poolId !== undefined) this.rememberPool(poolId);
    return { st, notes: checked.notes };
  },

  // An account whose CLI this runner can't drive (a Codex login found
  // before the Codex adapter is wired) is refused up front, rather than
  // making a thread whose first turn can only fail.
  checkProvider(this: Runner, account: Account): void {
    if (!this.adapters[account.provider]) {
      throw new RpcError(ErrorCode.badParams, `This runner can't run ${providerName(account.provider)} threads yet, so ${account.id} can't be used.`);
    }
  },

  // Checks a model and effort against the account's provider (protocol,
  // "Models and effort across providers"). A model of the other provider,
  // or a Codex id the account doesn't list, gives way to the provider's
  // default; an effort the model doesn't offer is dropped. Each says so in
  // a note rather than failing the call, since an older app always sends a
  // model and can't get past an error.
  checkSettings(this: Runner, account: Account, model: string | undefined, effort: EffortLevel | undefined): { model?: string; effort?: EffortLevel; notes: string[] } {
    const notes: string[] = [];
    const provider = account.provider;
    if (model && !this.modelFits(account, model)) {
      const replacement = this.defaultModelFor(provider);
      const fallback = replacement && this.modelFits(account, replacement) ? replacement : undefined;
      const uses = fallback ? modelTitle(account, fallback) : account.defaultModel ? modelTitle(account, account.defaultModel) : "the account's default model";
      notes.push(`${model} isn't a ${providerName(provider)} model, so this thread uses ${uses}.`);
      model = fallback;
    }
    if (effort) {
      const row = modelRow(account, model ?? account.defaultModel);
      const offered = (e: EffortLevel) => !(provider === 'claude' && e === 'ultra') && (!row?.effortLevels || row.effortLevels.includes(e));
      if (!offered(effort)) {
        const fallback = this.defaultEffortFor(provider);
        const next = fallback && fallback !== effort && offered(fallback) ? fallback : undefined;
        const why = provider === 'claude' && effort === 'ultra' ? `${effortTitle(effort)} effort is Codex only` : `${row ? row.title : 'This model'} doesn't offer ${effortTitle(effort)} effort`;
        notes.push(`${why}, so this thread uses ${next ? `${effortTitle(next)} effort` : "the model's own level"}.`);
        effort = next;
      }
    }
    return { ...(model ? { model } : {}), ...(effort ? { effort } : {}), notes };
  },

  // Whether a thread on this account can run this model id. Codex: one the
  // account lists, or before the list is known anything starting gpt-.
  // Claude: anything but a Codex id, unless the account itself lists it.
  modelFits(this: Runner, account: Account, model: string): boolean {
    if (modelRow(account, model)) return true;
    if (account.provider === 'codex') return !account.models?.length && model.startsWith('gpt-');
    if (isClaudeModel(model)) return true;
    const codexIds = this.safeAccounts().filter((a) => a.provider === 'codex').some((a) => modelRow(a, model));
    return !model.startsWith('gpt-') && !codexIds;
  },
};

export type NewThreadsPart = RunnerPart<typeof newThreadsPart>;
