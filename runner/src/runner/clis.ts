// CLI sessions: releasing idle ones, and moving them onto a new Claude or Codex version (CLI updates).
// Part of the Runner (runner.ts), split out on 4 Nov 2026 as a plain move so a
// fork's change to one area doesn't clash with another's. Each method's `this`
// is the Runner; runner.ts puts them on its prototype.
import type { Runner } from '../runner.ts';
import type { RunnerPart } from './part.ts';
import type { CliStatus, Provider } from '../protocol.ts';
import type { AgentAdapter } from '../adapters/types.ts';
import type { BinaryReporter, CliControl, CliHooks, ThreadState } from '../runner.ts';

export const clisPart = {
  scheduleIdle(this: Runner, st: ThreadState): void {
    const { rec, rt } = st;
    rt.idleTimer?.cancel();
    rt.idleTimer = undefined;
    if (!rt.session || rt.closing || rt.turn || rec.queue.length || rt.approvals.size) return;
    if (rt.releaseWhenIdle || this.bucket(rec) !== 'inbox') {
      this.releaseSession(st);
      return;
    }
    // A CLI update is waiting for this session to be idle. Never at the
    // cost of background work, or of the turn the CLI is about to start to
    // read a finished task's result.
    if (rt.versionMove && rt.tasks.length === 0 && !rt.wakeTimer) {
      this.log.info('releasing a CLI on an old version', { threadId: rec.id, version: rt.cliVersion, wanted: this.wantedVersion[rec.provider] });
      this.releaseSession(st);
      return;
    }
    // A background shell or subagent is still working; the countdown starts
    // when it finishes.
    if (rt.tasks.length) return;
    rt.idleTimer = this.clock.setTimeout(() => {
      rt.idleTimer = undefined;
      if (!rt.turn && rec.queue.length === 0 && rt.tasks.length === 0 && rt.approvals.size === 0) this.releaseSession(st);
    }, this.cfg.idleMs);
  },

  // Ends the CLI's input so it exits; the next send resumes the session.
  // Background work would keep the CLI alive (and could start a turn in a
  // thread that's just been snoozed), so if there is any it's stopped
  // straight away, with a note saying what was stopped.
  releaseSession(this: Runner, st: ThreadState): void {
    const { rt, rec } = st;
    rt.idleTimer?.cancel();
    rt.idleTimer = undefined;
    if (!rt.session || rt.closing) return;
    const session = rt.session;
    const hard = rt.tasks.length > 0;
    if (hard) {
      const what = rt.tasks.map((t) => t.description || t.type).join('; ');
      try {
        this.emit(st, { type: 'system.note', text: `Stopped background work when the session was released: ${what}` }, rt.turn?.turnId);
      } catch (e) {
        this.log.error('could not save a note', { threadId: rec.id, error: String(e) });
      }
      rt.tasks = [];
    }
    rt.finished = [];
    rt.releaseWhenIdle = false;
    rt.releasedGen = rt.generation;
    this.log.info('releasing CLI', { threadId: rec.id, hard });
    rt.closing = session
      .end({ hard })
      .catch((e: unknown) => this.log.warn('release failed', { threadId: rec.id, error: String(e) }))
      .finally(() => {
        rt.closing = undefined;
        if (rt.session === session) {
          // The adapter didn't report an exit; treat it as gone.
          rt.session = undefined;
        }
        this.markDirty(st);
        this.archiveWhenGone(st);
      });
  },

  // The hooks E's CliUpdates calls (restartPending comes from the
  // Restarter, in main.ts).
  cliHooks(this: Runner, restartPending: () => boolean): CliHooks {
    return {
      restartPending,
      releaseIdle: (p, v) => this.releaseIdle(p, v),
      versionsInUse: (p) => this.versionsInUse(p),
      codexBinariesInUse: () => this.codexBinariesInUse(),
    };
  },

  // A new version of a provider's CLI is in place. Live sessions on another
  // version are released now if they're idle, with the soft release (so
  // background work is never stopped by an update), and the rest as soon
  // as they are (scheduleIdle). The next message resumes on the new one.
  releaseIdle(this: Runner, provider: Provider, keepVersion: string): void {
    this.wantedVersion[provider] = keepVersion;
    for (const st of this.threads.values()) {
      const { rec, rt } = st;
      if (rec.provider !== provider || !rt.session || rt.closing) continue;
      if (rt.cliVersion === keepVersion) {
        rt.versionMove = false;
        continue;
      }
      rt.versionMove = true;
      if (this.idleForUpdate(st)) {
        this.log.info('releasing an idle CLI for an update', { threadId: rec.id, version: rt.cliVersion, wanted: keepVersion });
        this.releaseSession(st);
      }
    }
  },

  // Nothing would be cut short by releasing it: no turn (starting, running
  // or interrupting), approval or question, queued message, background
  // work or wake grace, and not already due to go.
  idleForUpdate(this: Runner, st: ThreadState): boolean {
    const { rec, rt } = st;
    return !rt.turn && rt.approvals.size === 0 && rec.queue.length === 0 && rt.tasks.length === 0 && !rt.wakeTimer && !rt.releaseWhenIdle;
  },

  // Which versions of a provider's CLI the live sessions run, from their
  // cliVersion outputs.
  versionsInUse(this: Runner, provider: Provider): { version: string; threadIds: string[] }[] {
    const by = new Map<string, string[]>();
    for (const { rec, rt } of this.threads.values()) {
      if (rec.provider !== provider || !rt.session || !rt.cliVersion) continue;
      by.set(rt.cliVersion, [...(by.get(rt.cliVersion) ?? []), rec.id]);
    }
    return [...by].map(([version, threadIds]) => ({ version, threadIds }));
  },

  // The Codex binaries live processes run, so E only deletes version
  // folders nothing uses.
  codexBinariesInUse(this: Runner): string[] {
    const codex = this.adapters.codex as (AgentAdapter & BinaryReporter) | undefined;
    try {
      return codex?.binariesInUse?.() ?? [];
    } catch (e) {
      this.log.warn('could not list the Codex binaries in use', { error: String(e) });
      return [];
    }
  },

  // E's CliUpdates: hello and clis.updated carry its statuses, and a Codex
  // update that activates asks every Codex account for its models again.
  attachClis(this: Runner, clis: CliControl): void {
    this.clis = clis;
    const codex = this.cliList()?.find((c) => c.provider === 'codex');
    this.codexVersion = codex?.installedVersion;
    this.codexMissing = codex?.status === 'missing';
    this.unsubs.push(clis.onChange((list) => this.clisChanged(list)));
  },

  cliList(this: Runner): CliStatus[] | undefined {
    if (!this.clis) return undefined;
    try {
      return this.clis.list();
    } catch (e) {
      this.log.warn('could not read the CLI statuses', { error: String(e) });
      return undefined;
    }
  },

  tellStarted(this: Runner, p: Provider, version: string | undefined, ok: boolean): void {
    try {
      this.clis?.sessionStarted?.(p, version, ok);
    } catch (e) {
      this.log.warn('could not report a session start', { error: String(e) });
    }
  },

  clisChanged(this: Runner, list: CliStatus[]): void {
    this.notify({ method: 'clis.updated', params: { clis: list } });
    const codex = list.find((c) => c.provider === 'codex');
    const version = codex?.installedVersion;
    if (version && version !== this.codexVersion) {
      const changed = this.codexVersion !== undefined || this.codexMissing;
      this.codexVersion = version;
      if (changed && !this.stopping) void this.probeModels((a) => a.provider === 'codex');
    }
    this.codexMissing = codex?.status === 'missing';
  },
};

export type ClisPart = RunnerPart<typeof clisPart>;
