// tb's commands for working on Threadbear from inside Threadbear
// (docs/dev-tools.md, section 3): the runner's state, the calling thread,
// restarts, a thread as plain text, the runner log, fixture exports for the
// mock runner, and raw calls. cli.ts hands these commands over; the
// formatting and export functions are pure enough to test on their own.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { defaultHome, readToken, runnerUrl, type Config } from './config.ts';
import { RunnerClient, RpcClientError } from './client.ts';
import { ErrorCode, type Account, type ImageRef, type PersistedEvent, type RunnerDefaults, type ThreadSummary } from './protocol.ts';
import { pushFailingText } from './push-failing.ts';
import type { RestartResult, RunnerStatus } from './restart.ts';
import type { UpstreamStatus } from './upstream.ts';

export const DEV_HELP = `Working on Threadbear itself:
  tb status [--json]              the runner: version, live CLIs, busy threads, a pending restart
  tb self [--json]                the thread this command runs in (THREADBEAR_THREAD_ID)
  tb updates [check] [--json]     Mike's newest release and what this copy's main is missing
                                  (docs/bringing-in-updates.md); check fetches upstream now
  tb restart [--now] [--resume "text" | --no-resume] [--reason "text"] [--thread ID]
             [--max-wait 30m]     restart once no thread is busy (or now), for dev runners and
                                  sandboxes. Inside a thread it carries that thread on
                                  afterwards; --resume sets the text. Background shells and
                                  subagents hold it for --max-wait at most
  tb restart --cancel             withdraw a restart that hasn't begun (from a thread of
                                  that runner, only the thread's own)
  tb show <threadId> [--last N] [--tools]
                                  the thread as plain text; --last N turns; --tools adds results
  tb logs [-f] [-n 200] [--thread ID]
  tb activity [--since 1h] [--thread ID] [--summary] [--json]
                                  what was clicked, opened, chosen and sent in the Mac app, from its
                                  activity log (Settings > General, off unless it's switched on);
                                  --summary counts what's used most, over 7 days unless --since
  tb export <threadId> [--out DIR]
                                  thread.json, events.ndjson and media/ for the mock runner,
                                  in app/.fixtures/threads/<id> by default
  tb rpc <method> ['{"json": "params"}']`;

export type Flags = Record<string, string | boolean | string[] | undefined>;
type Resolve = (prefix: string | undefined) => Promise<string>;

const ALL = ['inbox', 'snoozed', 'archived'];
const BUSY = ['starting', 'running', 'waiting'];
// This tb, written out in full in what it prints: a bare `tb` isn't on
// PATH in every shell.
const TB = path.resolve(import.meta.dirname, '..', 'bin', 'tb');

// The tb to print in a follow-up command, so pasting it reaches the runner
// this one talked to. A dev runner's <home>/tb sets THREADBEAR_TB to itself.
// Otherwise, inside a thread whose THREADBEAR_HOME was pointed somewhere
// else for this one command, the home goes in front: a bare tb there is the
// thread's own runner, the live one, and `tb restart --cancel` on that
// would withdraw someone's deploy.
export function tbCommand(env: NodeJS.ProcessEnv = process.env): string {
  if (env.THREADBEAR_TB) return shQuote(env.THREADBEAR_TB);
  const home = env.THREADBEAR_HOME ?? env.THREADBEAR_DATA_DIR;
  if (home && env.THREADBEAR_RUNNER_HOME && !sameDir(home, env.THREADBEAR_RUNNER_HOME)) return `THREADBEAR_HOME=${shQuote(home)} ${shQuote(TB)}`;
  return shQuote(TB);
}

// Returns undefined for a command that isn't one of these.
export async function runDev(client: RunnerClient, cmd: string, args: string[], f: Flags, resolveId: Resolve): Promise<number | undefined> {
  const env = process.env;
  switch (cmd) {
    case 'status': {
      const s = await client.call<RunnerStatus>('runner.status').catch(quietlyTooOld);
      if (!s) {
        // Most of it can still be had from hello and threads.list.
        const hello = await client.call<{ runnerVersion: string }>('hello', { client: 'tb', version: '1' });
        const threads = await listAll(client);
        const busy = threads.filter((t) => BUSY.includes(t.status)).map((t) => t.id);
        if (f.json) return printJson({ version: hello.runnerVersion, running: busy, old: true });
        const lines = [`Runner ${hello.runnerVersion}`, busy.length ? `Busy threads: ${busy.length}` : 'Busy threads: none'];
        for (const id of busy) lines.push(`  ${threadLine(id, threads, env.THREADBEAR_THREAD_ID)}`);
        lines.push("This runner predates runner.status and picks it up on its next restart. Don't restart it yourself.");
        process.stdout.write(lines.join('\n') + '\n');
        return 0;
      }
      if (f.json) return printJson(s);
      process.stdout.write(formatStatus(s, await listAll(client), Date.now(), env.THREADBEAR_THREAD_ID));
      return 0;
    }
    case 'updates': {
      if (args[0] && args[0] !== 'check') {
        console.error('Usage: tb updates [check] [--json]');
        return 2;
      }
      const r = await client.call<{ upstream: UpstreamStatus }>(args[0] === 'check' ? 'upstream.check' : 'upstream.status').catch(quietlyTooOld);
      if (!r) {
        console.error("This runner predates Mike's releases (upstream.status); it picks them up on its next update.");
        return 1;
      }
      if (f.json) return printJson(r.upstream);
      process.stdout.write(formatUpstream(r.upstream, Date.now()) + '\n');
      return 0;
    }
    case 'self': {
      const id = env.THREADBEAR_THREAD_ID;
      if (!id) {
        console.error("THREADBEAR_THREAD_ID isn't set: tb self only works inside a Threadbear thread.");
        return 1;
      }
      const t = (await listAll(client)).find((x) => x.id === id);
      if (!t) {
        // Most likely tb is pointed at another runner than the thread's.
        const s = await client.call<RunnerStatus>('runner.status').catch(() => undefined);
        const here = s?.home ?? env.THREADBEAR_HOME ?? defaultHome();
        const mine = env.THREADBEAR_RUNNER_HOME;
        if (mine && !sameDir(mine, here)) console.error(`This thread (${id.slice(0, 8)}) runs on the runner at ${mine}; this tb talks to the one at ${here}.`);
        else console.error(`Thread not found: ${id}`);
        return 1;
      }
      if (f.json) return printJson(t);
      process.stdout.write(formatSelf(t));
      return 0;
    }
    case 'restart': {
      if (f.cancel) {
        // From a thread of the runner it would cancel, only that thread's
        // own restart. Anyone else's is almost always a deploy waiting for
        // this very turn to end: withdrawing it undoes the deploy (current
        // goes back) and the thread waiting to be carried on never is.
        const status = await client.call<RunnerStatus>('runner.status').catch(quietlyTooOld);
        const p = status?.pendingRestart;
        const self = env.THREADBEAR_THREAD_ID;
        const onIt = status && (Boolean(env.THREADBEAR_RUNNER_HOME && sameDir(env.THREADBEAR_RUNNER_HOME, status.home)) || isAncestor(status.pid));
        if (p && onIt && !f.force && (!self || p.resumeThreadId !== self)) {
          const threads = await listAll(client);
          const what = [p.reason ? `"${p.reason}"` : 'a restart', p.release ? `onto ${p.release}` : ''].filter(Boolean).join(' ');
          console.error(`The pending restart isn't this thread's: ${what}, asked ${duration(Date.now() - Date.parse(p.requestedAt))} ago.`);
          if (p.resumeThreadId) console.error(`  It carries on: ${threadLine(p.resumeThreadId, threads, self)}`);
          const undo = p.release ? 'undo that deploy' : 'cancel it under whoever asked';
          console.error(`Withdrawing it would ${undo}${p.resumeThreadId ? ' and leave that thread waiting' : ''}. Leave it: it goes ahead once every thread is idle, this one included.`);
          return 1;
        }
        const r = await client.call<RestartResult>('runner.restart', { cancel: true }).catch(tooOld);
        if (!r) return TOO_OLD;
        console.log(r.scheduled ? 'The restart is still on.' : 'No restart is pending now.');
        if (r.note) console.log(r.note);
        return 0;
      }
      const status = await client.call<RunnerStatus>('runner.status').catch(quietlyTooOld);
      if (!status) {
        tooOld(undefined);
        return TOO_OLD;
      }
      const threads = await listAll(client);
      // The thread this runs in, if it's one of this runner's: tb may be
      // pointed at a dev runner or sandbox from a thread of the real one.
      const self = env.THREADBEAR_THREAD_ID && threads.some((t) => t.id === env.THREADBEAR_THREAD_ID) ? env.THREADBEAR_THREAD_ID : undefined;
      const refused = restartRefusal(status, {
        onIt: Boolean(self) || Boolean(env.THREADBEAR_RUNNER_HOME && sameDir(env.THREADBEAR_RUNNER_HOME, status.home)) || isAncestor(status.pid),
        real: sameDir(status.home, defaultHome()),
        force: Boolean(f.force),
      });
      if (refused) {
        console.error(refused);
        return 1;
      }
      if (f.now) {
        // Never offered --force here: an agent that reads it learns to cut
        // every thread's work short.
        if (self && !f.force) {
          console.error("--now stops every turn on this runner, this thread's own included. Leave it out to restart once every thread is idle.");
          return 1;
        }
        const others = [...new Set([...status.running, ...(status.background ?? []).map((b) => b.threadId)])].filter((id) => id !== self);
        if (others.length && (self || !f.force)) {
          const whose = others.length === 1 ? `1 ${self ? 'other ' : ''}thread's` : `${others.length} ${self ? 'other ' : ''}threads'`;
          console.error(`--now would cut short ${whose} work (turns, background shells, subagents):`);
          for (const id of others) console.error(`  ${threadLine(id, threads, self)}`);
          console.error('Leave --now out: the runner then restarts once they finish.');
          return 1;
        }
      }
      const params: Record<string, unknown> = { when: f.now ? 'now' : 'idle', backgroundWaitMs: parseWait(f['max-wait']) };
      if (typeof f.reason === 'string') params.reason = f.reason;
      const target = typeof f.thread === 'string' ? await resolveId(f.thread) : self;
      if (typeof f.resume === 'string') {
        if (!target) {
          console.error('--resume needs a thread: run it inside one, or pass --thread ID.');
          return 1;
        }
        params.resume = { threadId: target, text: f.resume };
      } else if (target && !f['no-resume']) {
        // Inside a thread the agent that asked should hear how it went, as
        // deploy-runner.sh does.
        params.resume = { threadId: target, text: `The runner restarted${typeof f.reason === 'string' ? ` (${f.reason})` : ''}. Check that it worked, then carry on.` };
      }
      const r = await client.call<RestartResult>('runner.restart', params).catch(tooOld);
      if (!r) return TOO_OLD;
      const resume = params.resume as { threadId: string; text: string } | undefined;
      const who = resume?.threadId === self ? 'this thread' : resume?.threadId.slice(0, 8);
      // The runner says when it won't send the resume (a thread resumed 3
      // times this hour), so nobody ends a turn waiting for it.
      const then = !resume ? '' : r.noResume ? `The runner won't carry ${who} on afterwards: ${r.noResume}.` : `Then ${who} carries on with: "${resume.text}"`;
      if (r.waitingFor.length === 0) {
        console.log(self ? `Restarting now; this turn ends with it.${then ? ` ${then}` : ''}` : `Restarting now.${then ? ` ${then}` : ''}`);
        return 0;
      }
      const after = await listAll(client);
      console.log(`The runner will restart when ${plural(r.waitingFor.length, 'thread finishes', 'threads finish')} (a turn, or background shells and subagents):`);
      for (const id of r.waitingFor) console.log(`  ${threadLine(id, after, self)}`);
      if (then) console.log(then);
      // Ending the turn doesn't stop these, and the restart waits for them.
      const own = self ? (r.background ?? []).find((b) => b.threadId === self) : undefined;
      if (own?.tasks.length) {
        console.log(`It also waits for this thread's background work, which ending the turn doesn't stop:`);
        for (const t of own.tasks) console.log(`  ${t}`);
        console.log(`Stop it before you end your turn (a dev runner stops with the kill <pid> it printed). Otherwise the restart goes ahead after ${fmtWait(params.backgroundWaitMs as number)} and stops it.`);
      }
      // Waiting for it from inside the turn it waits for would never end.
      if (self && r.waitingFor.includes(self)) {
        console.log(
          r.noResume && resume?.threadId === self
            ? 'End your turn now, and say in your reply that the user has to message this thread once the runner is back; the runner restarts after it.'
            : 'End your turn now; the runner restarts after it and carries this thread on.',
        );
      } else console.log(`${tbCommand()} restart --cancel withdraws it.`);
      return 0;
    }
    case 'show': {
      const id = await resolveId(args[0]);
      const t = await threadById(client, id);
      const last = f.last !== undefined ? Number(f.last) : undefined;
      if (last !== undefined && !(Number.isInteger(last) && last > 0)) throw new Error('--last takes a whole number above 0');
      process.stdout.write(formatThread(t, await allEvents(client, id), { last, tools: Boolean(f.tools) }));
      return 0;
    }
    case 'export': {
      const id = await resolveId(args[0]);
      const t = await threadById(client, id);
      const out = typeof f.out === 'string' ? path.resolve(f.out) : defaultExportDir(id);
      const r = exportThread(t, await allEvents(client, id), out);
      console.log(`Exported ${plural(r.events, 'event', 'events')} and ${plural(r.media, 'image', 'images')} to ${out}`);
      // dev-app.sh runs a debug build in a temp bundle with its window kept
      // behind Mike's, with its own mock runner that it stops again, so an
      // agent can look at the export without asking. It comes first: a
      // bare mock runner started by hand blocks the shell it runs in.
      // --fixtures with the export's own folder loads just this thread,
      // without the mock's sample threads or anything beside it.
      const root = findRepoRoot() ?? '.';
      console.log(`To look at it in a debug app, then dump, shot and stop it:`);
      console.log(`  ${shQuote(path.join(root, 'app', 'Tools', 'dev-app.sh'))} start --mock --fixtures ${shQuote(out)}`);
      console.log(`Its events by seq (line N of events.ndjson is seq N): ${tbCommand()} events ${id.slice(0, 8)} --from N --to M`);
      return 0;
    }
    case 'rpc': {
      if (!args[0]) throw new Error('method required');
      // runner.restart has guards tb restart applies and a raw call skips
      // (the live runner, --now while others are busy, someone else's
      // pending restart), so it always goes through tb restart. Mike can
      // pass tb restart --force from a terminal.
      if (args[0] === 'runner.restart') {
        console.error(`Use ${tbCommand()} restart (--cancel to withdraw one): it checks the runner isn't the one your thread runs on and handles waiting for your own turn.`);
        return 1;
      }
      let params: unknown = {};
      if (args[1] !== undefined) {
        try {
          params = JSON.parse(args[1]);
        } catch {
          throw new Error(`Params aren't JSON: ${args[1]}`);
        }
      }
      if (!params || typeof params !== 'object' || Array.isArray(params)) throw new Error('Params must be a JSON object');
      // The same guards tb approve, delete and interrupt apply: a thread's
      // own cards are Mike's to answer, and it can't stop itself.
      const own = env.THREADBEAR_THREAD_ID && (params as { threadId?: unknown }).threadId === env.THREADBEAR_THREAD_ID;
      // A plan's Go ahead is one of its cards too: approving its own plan
      // would take the thread out of Plan first by itself.
      if (own && ['approvals.respond', 'plans.approve', 'threads.delete', 'threads.interrupt'].includes(args[0])) {
        console.error(args[0] === 'approvals.respond' || args[0] === 'plans.approve' ? "That's this thread's own card; the user answers it." : `Not on the thread this runs in (${args[0]}).`);
        return 1;
      }
      // Snoozing or archiving releases the CLI, ending this turn: tb snooze
      // and tb archive refuse it for the thread they run in, and so does this.
      if (own && args[0] === 'threads.update') {
        const u = params as { archived?: unknown; snoozedUntil?: unknown };
        if (u.archived === true || (u.snoozedUntil !== undefined && u.snoozedUntil !== null)) {
          console.error("Can't snooze or archive the thread this runs in from inside its own turn. To archive it once the turn is over, call end_turn with archive: true (again, if you already have). To snooze it, ask the user to.");
          return 1;
        }
      }
      return printJson(await client.call(args[0], params as Record<string, unknown>));
    }
    default:
      return undefined;
  }
}

// For commands printed to paste into a shell; the default data dir has a space.
export function shQuote(s: string): string {
  return /^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;
}

// Why tb restart won't restart this runner, if it won't. onIt: the runner
// the calling thread runs on (or one of its ancestors' runner). real: the
// LaunchAgent's data dir. tb restart is for dev runners and sandboxes; the
// live runner is restarted by deploy-runner.sh, which builds, tests and
// checks a release first, and a live runner run from a checkout would come
// back on whatever is in that checkout now (another job's half-merged
// edits, say), with no smoke test and nothing to roll back to.
export function restartRefusal(s: Pick<RunnerStatus, 'version' | 'release' | 'home'>, o: { onIt: boolean; real: boolean; force: boolean }): string | undefined {
  if (!o.real) return undefined;
  const source = !s.release;
  if (o.onIt && source) {
    return `The runner your thread runs on runs from a checkout (${s.version}), so a restart would bring it back on whatever is in that checkout now, untested. Runner changes wait for the user: tell them what you need, and they can switch it to releases with scripts/install-runner.sh from a terminal.`;
  }
  if (o.force) return undefined;
  if (o.onIt) return 'This is the runner your thread runs on. Ship runner changes with scripts/deploy-runner.sh, which builds, tests and checks a release, then restarts it once every thread is idle and carries your thread on.';
  if (source) return `The runner at ${s.home} runs from a checkout (${s.version}), so a restart would bring it back on whatever is in that checkout now, untested. Switch it to releases with scripts/install-runner.sh first.`;
  return undefined;
}

// True if pid is an ancestor of this process: a CLI that runner started
// ran tb, directly or through a shell or a dev runner.
function isAncestor(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 1) return false;
  const r = spawnSync('ps', ['-A', '-o', 'pid=,ppid='], { encoding: 'utf8' });
  if (r.status !== 0) return false;
  const parent = new Map<number, number>();
  for (const line of r.stdout.split('\n')) {
    const [p, pp] = line.trim().split(/\s+/).map(Number);
    if (p) parent.set(p, pp);
  }
  for (let p = process.ppid, n = 0; p > 1 && n < 200; p = parent.get(p) ?? 0, n++) {
    if (p === pid) return true;
  }
  return false;
}

const DEFAULT_WAIT_MS = 30 * 60_000;

// --max-wait: 90s, 30m, 2h (default 30m).
function parseWait(v: Flags[string]): number {
  if (v === undefined) return DEFAULT_WAIT_MS;
  const m = typeof v === 'string' ? /^(\d+(?:\.\d+)?)(s|m|h)?$/.exec(v.trim()) : null;
  if (!m) throw new Error(`Can't read --max-wait ${String(v)}; use something like 90s, 30m or 2h.`);
  return Number(m[1]) * { s: 1000, m: 60_000, h: 3_600_000 }[(m[2] ?? 's') as 's' | 'm' | 'h'];
}

function fmtWait(ms: number): string {
  return ms % 3_600_000 === 0 ? `${ms / 3_600_000}h` : ms % 60_000 === 0 ? `${ms / 60_000}m` : `${Math.round(ms / 1000)}s`;
}

function printJson(v: unknown): number {
  console.log(JSON.stringify(v, null, 2));
  return 0;
}

// A runner from before runner.status and runner.restart answers "method
// not found". tb says so and exits 3, so deploy-runner.sh can fall back to
// waiting for idle and restarting it from launchd.
const TOO_OLD = 3;

function tooOld(e: unknown): undefined {
  if (e !== undefined) quietlyTooOld(e);
  console.error(
    "This runner is too old for runner.status and runner.restart, so it can't wait for its threads before restarting. deploy-runner.sh waits for them itself; inside a thread, leave the restart to the user.",
  );
  return undefined;
}

function quietlyTooOld(e: unknown): undefined {
  if (e instanceof RpcClientError && e.code === ErrorCode.methodNotFound) return undefined;
  throw e;
}

async function listAll(client: RunnerClient): Promise<ThreadSummary[]> {
  return (await client.call<{ threads: ThreadSummary[] }>('threads.list', { include: ALL })).threads;
}

async function threadById(client: RunnerClient, id: string): Promise<ThreadSummary> {
  const t = (await listAll(client)).find((x) => x.id === id);
  if (!t) throw new Error(`Thread not found: ${id}`);
  return t;
}

// Every event, a page at a time (the runner gives at most 10,000 a call).
export async function allEvents(client: RunnerClient, threadId: string): Promise<PersistedEvent[]> {
  const out: PersistedEvent[] = [];
  const limit = 10_000;
  for (let after = 0; ; ) {
    const r = await client.call<{ events: PersistedEvent[] }>('threads.events', { threadId, afterSeq: after, limit });
    out.push(...r.events);
    if (r.events.length < limit) return out;
    after = r.events[r.events.length - 1].seq;
  }
}

// ------------------------------------------------------------- formatting

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

export function duration(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

// self marks the thread the command runs in.
function threadLine(id: string, threads: ThreadSummary[], self?: string): string {
  const t = threads.find((x) => x.id === id);
  const mine = id === self ? '  (this thread)' : '';
  return t ? `${id.slice(0, 8)}  ${t.title}  [${t.status}]${mine}` : `${id.slice(0, 8)}${mine}`;
}

export function formatStatus(s: RunnerStatus, threads: ThreadSummary[], now: number, self?: string): string {
  const lines = [`Runner ${s.version}${s.branch ? ` (branch ${s.branch})` : ''}, pid ${s.pid}, up ${duration(now - Date.parse(s.startedAt))}`];
  // A deploy can report success just before its release dies; this is how
  // anyone checking afterwards finds out the change isn't live.
  if (s.rolledBack) lines.push(`Went back to this release ${duration(now - Date.parse(s.rolledBack.at))} ago: ${s.rolledBack.from} kept crashing at startup.`);
  lines.push(`Data dir: ${s.home}`);
  if (s.logFile) lines.push(`Log: ${s.logFile}`);
  lines.push(`Live CLIs: ${s.liveClis}`);
  lines.push(s.running.length ? `Busy threads: ${s.running.length}` : 'Busy threads: none');
  for (const id of s.running) lines.push(`  ${threadLine(id, threads, self)}`);
  // A restart waits for these too; --now (or launchctl) would stop them.
  const bg = s.background ?? [];
  if (bg.length) {
    lines.push(`Background work: ${plural(bg.length, 'thread', 'threads')}`);
    for (const b of bg) lines.push(`  ${threadLine(b.threadId, threads, self)}: ${b.tasks.join('; ')}`);
  }
  // Handovers: an older release finishing these threads' turns, which
  // move here when they end.
  for (const d of s.draining ?? []) {
    lines.push(`Old runner ${d.version}, pid ${d.pid}, finishing ${plural(d.threads.length, 'thread', 'threads')}, handed over ${duration(now - Date.parse(d.since))} ago`);
    for (const id of d.threads) lines.push(`  ${threadLine(id, threads, self)}`);
  }
  const p = s.pendingRestart;
  if (p) {
    const waiting = p.waitingFor?.length ?? 0;
    let line = `Restart pending: ${p.when === 'now' ? 'now' : 'when idle'}${p.release ? ` onto ${p.release}` : ''}, asked ${duration(now - Date.parse(p.requestedAt))} ago`;
    if (waiting) line += `, waiting for ${plural(waiting, 'thread', 'threads')}`;
    lines.push(line);
    for (const id of p.waitingFor ?? []) lines.push(`  ${threadLine(id, threads, self)}`);
    if (p.reason) lines.push(`  Reason: ${p.reason}`);
    if (p.resumeThreadId) lines.push(`  Then carries on: ${threadLine(p.resumeThreadId, threads, self)}`);
  }
  const u = s.update;
  if (u) lines.push(formatUpdate(u, now));
  if (s.upstream && (s.upstream.state !== 'off' || s.upstream.published)) lines.push(formatUpstream(s.upstream, now).split('\n')[0]);
  // A held release is the one thing here that wants doing something about.
  if (s.upstream?.held) lines.push(heldLine(s.upstream.held));
  if (s.sync) lines.push(formatSync(s.sync, now));
  if (s.sync?.scrub) lines.push(...formatSecrets(s.sync.scrub, s.secretCheck, now, s.sync.full));
  // Releases never touch the LaunchAgent (launch.mjs, the plist, Threadbear
  // Runner.app); only Mike's install-runner.sh does.
  if (u?.launcherChanged) lines.push(`${u.launcherReason ?? 'launch.mjs on main differs from the installed one.'} The user runs ${u.checkout ? `${u.checkout}/runner/` : 'runner/'}scripts/install-runner.sh once nothing is busy.`);
  if (s.macScreen?.fullDiskAccess === false) lines.push('Threadbear Runner has no Full Disk Access here, so macOS can stop and wait for someone to answer a prompt. System Settings > Privacy & Security > Full Disk Access turns it on.');
  if (s.macScreen?.dialogs) lines.push(`${plural(s.macScreen.dialogs, 'dialog', 'dialogs')} waiting on this Mac's screen${s.macScreen.dialogsSince ? `, for ${duration(now - Date.parse(s.macScreen.dialogsSince))}` : ''}. A privacy prompt can hold up other apps until someone answers it.`);
  return lines.join('\n') + '\n';
}

// The Convex mirror (src/sync.ts), one line.
function formatSync(y: NonNullable<RunnerStatus['sync']>, now: number): string {
  if (y.state === 'off') return `Convex mirror: off${y.reason ? ` (${y.reason})` : ''}`;
  const where = y.url ? ` to ${y.url}` : '';
  const last = y.lastSyncAt ? `, last write ${duration(now - Date.parse(y.lastSyncAt))} ago` : ', nothing written yet';
  const pending = y.pending ? `, ${plural(y.pending, 'change', 'changes')} waiting` : '';
  if (y.state === 'error') return `Convex mirror: failing${where}: ${y.lastError ?? 'unknown error'}${y.retryAt ? `, retrying in ${duration(Math.max(0, Date.parse(y.retryAt) - now))}` : ''}${pending}`;
  const behind = y.backend && y.backend.apiVersion < y.backend.expected ? `; its backend is older than this runner (API ${y.backend.apiVersion}, wants ${y.backend.expected}): deploy it with runner/scripts/deploy-backend.mjs` : '';
  const held = y.schedulesHeld ? `; ${y.schedulesHeld} schedule${y.schedulesHeld === 1 ? '' : 's'} too big (or taken) for this runner's key, so its schedules stay in schedules.json on this Mac (tb logs says which)` : '';
  const rotating = y.ownerKeyRotating ? '; RUNNER_KEY_NEXT is still set, so two main keys work: finish with tb runner rotate-owner --finish' : '';
  // A self-hosted backend can't send phone notifications (docs/self-hosting.md).
  const push = y.pushOff ? "\nPhone notifications: off, as this backend can't send them (a self-hosted backend can't use the push relay)." : y.pushFailing ? `\n${pushFailingText(y.pushFailing)}` : '';
  const f = y.full;
  const full = f
    ? f.backendTooOld
      ? '\nFull sync: on, but the backend is too old to take tool output yet.'
      : `\nFull sync: on: ${plural(f.bodies, 'tool', 'tools')} (${Math.round(f.bytes / 1024)} KB) sent since this runner started, ${f.withheld} held back as they can hold secrets${f.unsent ? `, ${f.unsent} not sent` : ''}${f.pending ? `, ${f.pending} waiting` : ''}.`
    : '';
  return `Convex mirror: on${where} as ${y.name ?? y.runnerId ?? 'this runner'}${last}${pending}${behind}${held}${rotating}${push}${full}`;
}

// What stands between this runner's threads and the Convex deployment
// (src/scrub.ts), said plainly: docs/on-your-mac.md has the longer version.
export function formatSecrets(y: NonNullable<NonNullable<RunnerStatus['sync']>['scrub']>, c: RunnerStatus['secretCheck'], now: number, full?: NonNullable<RunnerStatus['sync']>['full']): string[] {
  const backend = y.backendChecks === false ? "; its backend is too old to check again" : y.backendChecks ? '; the backend checks again' : '';
  const lines = [`Secrets: rules v${y.rulesVersion} and ${plural(y.knownValues, 'known value', 'known values')} on everything sent to Convex${backend}. ${full ? 'Tool output goes up too, after those and a withhold list' : 'Tool output stays here, with a withhold list ready for when it does not'}. Not a guarantee: rotate any key that leaks.`];
  if (y.foldersUnread) lines.push(`Secrets: ${plural(y.foldersUnread, 'thread folder', 'thread folders')} didn't answer, so values in their .env files aren't known; only the rules cover those.`);
  if (y.failed) lines.push(`Secrets: the check failed on ${plural(y.failed, 'string', 'strings')}, held back rather than sent${y.lastFailure ? ` (${y.lastFailure})` : ''}.`);
  if (!c || c.state === 'off' || c.state === 'unsupported') {
    lines.push(`On-device secret check: ${c?.state === 'unsupported' ? 'none on this machine' : 'off'}, so this runner relies on the rules and the withhold list.`);
  } else if (c.state === 'starting') {
    // Its first look comes a few minutes after a start, with its counts kept from before.
    lines.push(`On-device secret check: on, silently, and waiting for its first run since this runner started: ${c.flaggedText} of ${c.checkedText} tool outputs and ${c.flaggedImages} of ${c.checkedImages} pictures flagged so far.`);
  } else if (c.state === 'unavailable') {
    lines.push(`On-device secret check: unavailable${c.reason ? ` (${c.reason})` : ''}, so this runner relies on the rules and the withhold list.`);
  } else {
    const last = c.lastRunAt ? `, last ran ${duration(now - Date.parse(c.lastRunAt))} ago` : ', not run yet';
    const battery = c.skippedOnBattery ? `, ${plural(c.skippedOnBattery, 'run', 'runs')} skipped on battery` : '';
    lines.push(`On-device secret check: on, silently (it changes nothing that uploads): ${c.flaggedText} of ${c.checkedText} tool outputs and ${c.flaggedImages} of ${c.checkedImages} pictures flagged, ${plural(c.errors, 'error', 'errors')}${last}${battery}.${c.file ? ` Flagged items by thread and seq: ${c.file}` : ''}`);
  }
  return lines;
}

// The runner following main by itself (src/update.ts), one line.
function formatUpdate(u: NonNullable<RunnerStatus['update']>, now: number): string {
  const checked = u.checkedAt ? `, checked ${duration(now - Date.parse(u.checkedAt))} ago` : '';
  const at = u.commit ? ` at ${u.commit.slice(0, 7)}` : '';
  switch (u.state) {
    case 'off':
      return `Following main: off${u.reason ? ` (${u.reason})` : ''}`;
    case 'checking':
      return `Following main: checking it now`;
    case 'building':
      return `Following main: building a release of main${at}`;
    case 'waiting':
      return `Following main: release ${u.release ?? '?'} of main${at} is built and starts on the pending restart`;
    case 'failed':
      return `Following main: the build of main${at} failed${checked}: ${u.reason ?? 'unknown error'}${u.logFile ? ` (output in ${u.logFile})` : ''}`;
    default:
      return `Following main: up to date${at}${checked}`;
  }
}

// Mike's runner, when GitHub's checks keep main's tip from being today's
// release (upstream.ts ciVerdict).
function heldLine(h: { commit: string; why: string }): string {
  return `Today's release is waiting: ${h.why} (${h.commit.slice(0, 8)})`;
}

// Mike's releases (src/upstream.ts): a line, then what's in a release
// main doesn't have yet.
export function formatUpstream(u: UpstreamStatus, now: number): string {
  const checked = u.checkedAt ? `, checked ${duration(now - Date.parse(u.checkedAt))} ago` : '';
  const published = (u.published ? `\nLast release tagged here: ${u.published.tag}` : '') + (u.held ? `\n${heldLine(u.held)}` : '');
  const r = u.release;
  switch (u.state) {
    case 'off':
      return `Mike's releases: off${u.reason ? ` (${u.reason})` : ''}${published}`;
    case 'checking':
      return `Mike's releases: checking upstream now`;
    case 'failed':
      return `Mike's releases: the last check failed${checked}: ${u.reason ?? 'unknown error'}${r ? `\nNewest known: ${r.tag}` : ''}`;
    case 'available': {
      if (!r) return `Mike's releases: a new one is available${checked}`;
      const more = r.changes > r.subjects.length ? `\n  … and ${r.changes - r.subjects.length} more` : '';
      return [
        `Mike's releases: ${r.tag} has ${r.changes} change${r.changes === 1 ? '' : 's'} this copy's main doesn't${checked}`,
        // Mike's plain-words notes first, when his runner wrote some.
        ...(r.notes ?? []).flatMap((n) => [`  What changed in ${n.tag}:`, ...n.lines.map((l) => `    ${l}`)]),
        ...(r.notes?.length ? ['  Every change:'] : []),
        ...r.subjects.map((x) => `  ${x}`),
      ].join('\n') + more + `\nIts commit, signed with the pinned key: ${r.commit}. To bring it in, follow docs/bringing-in-updates.md and merge that commit (git merge ${r.commit}), or use Bring them in, in the app's Updates panel.`;
    }
    default:
      return `Mike's releases: up to date${r ? ` with ${r.tag}` : ''}${u.reason ? ` (${u.reason})` : ''}${checked}${published}`;
  }
}

function access(t: ThreadSummary): string {
  return t.permissionMode === 'ask' ? 'asks before edits' : t.permissionMode === 'auto' ? 'auto' : t.permissionMode === 'plan' ? 'plan first' : 'full access';
}

// tb models: one row per model, the default starred, with its effort
// levels; then what a new thread on the account runs on.
export function formatModels(a: Account, defaults?: RunnerDefaults): string {
  const lines = [`${a.id} (${a.provider === 'codex' ? 'Codex' : 'Claude'})`];
  const isDefault = (m: { id: string; model: string }) => a.defaultModel !== undefined && (m.id === a.defaultModel || m.model === a.defaultModel);
  if (!a.models?.length) lines.push("  The CLI hasn't been asked for its models yet.");
  for (const m of a.models ?? []) {
    const efforts = m.effortLevels?.length ? `  efforts: ${m.effortLevels.join(', ')}${m.defaultEffort ? ` (own level ${m.defaultEffort})` : ''}` : '';
    lines.push(`${isDefault(m) ? '*' : ' '} ${m.id.padEnd(22)} ${m.title}${efforts}`);
  }
  lines.push(`Account default: ${a.defaultModel ?? 'unknown until a turn runs'}${a.defaultEffort ? `, effort ${a.defaultEffort}` : ''}`);
  const runnerModel = defaults?.models?.[a.provider] ?? (a.provider === 'claude' ? defaults?.model : undefined);
  const runnerEffort = defaults?.efforts?.[a.provider];
  if (runnerModel || runnerEffort) lines.push(`New threads here get: ${[runnerModel, runnerEffort ? `effort ${runnerEffort}` : ''].filter(Boolean).join(', ')} (the runner's defaults)`);
  return lines.join('\n');
}

export function formatSelf(t: ThreadSummary): string {
  const lines = [
    t.id,
    t.title,
    `Status: ${t.status}${t.live ? ', CLI live' : ''}`,
    `Account: ${t.accountId} (${t.provider === 'codex' ? 'Codex' : 'Claude'}), ${t.model ? `model ${t.model}` : 'default model'}${t.modelInUse ? ` (${t.modelInUse})` : ''}, effort ${t.effort ?? 'default'}${t.effortInUse ? ` (${t.effortInUse})` : ''}, ${access(t)}`,
    `Folder: ${t.cwd}`,
    `Events: ${t.lastSeq}`,
  ];
  if (t.costUsd !== undefined) lines.push(`Cost so far: $${t.costUsd.toFixed(4)}`);
  if (t.contextTokens !== undefined) lines.push(`Context: ${t.contextTokens} tokens${t.contextWindow ? ` of ${t.contextWindow}` : ''}`);
  return lines.join('\n') + '\n';
}

// The last n turns, with any notes just before the first of them (the
// "Runner restarted" note sits right before the turn it explains).
export function lastTurns(events: PersistedEvent[], n: number): { events: PersistedEvent[]; hidden: number } {
  const starts: number[] = [];
  const seen = new Set<string>();
  events.forEach((e, i) => {
    if (e.turnId && !seen.has(e.turnId)) {
      seen.add(e.turnId);
      starts.push(i);
    }
  });
  if (starts.length <= n) return { events, hidden: 0 };
  let from = starts[starts.length - n];
  while (from > 0 && !events[from - 1].turnId) from--;
  return { events: events.slice(from), hidden: starts.length - n };
}

const RESULT_LINES = 20;
const DIFF_LINES = 40;

function block(label: string, text: string, indent: string): string[] {
  const [first, ...rest] = text.split('\n');
  return [`${label}${first}`, ...rest.map((l) => (l ? indent + l : ''))];
}

function capped(lines: string[], max: number, indent: string): string[] {
  const out = lines.slice(0, max).map((l) => indent + l);
  if (lines.length > max) out.push(`${indent}... ${plural(lines.length - max, 'more line', 'more lines')}`);
  return out;
}

function imageLine(img: ImageRef, indent: string): string {
  return `${indent}[image: ${img.path}${img.width && img.height ? `, ${img.width}x${img.height}` : ''}]`;
}

const DECISIONS: Record<string, string> = {
  allow: 'allowed',
  allowAlways: 'always allowed',
  deny: 'denied',
  answered: 'answered',
  expired: 'expired',
};

// The thread as plain text, for an agent (or Mike) to read: messages, one
// line per tool call, approvals, notes and turn footers. tools adds tool
// results, diffs and thinking summaries.
export function formatThread(t: ThreadSummary, events: PersistedEvent[], opts: { last?: number; tools?: boolean } = {}): string {
  const lines = [t.title, `${t.id}, ${t.status}, ${t.accountId}${t.model ? `, ${t.model}` : ''}, ${access(t)}, in ${t.cwd}`];
  const { events: shown, hidden } = opts.last ? lastTurns(events, opts.last) : { events, hidden: 0 };
  if (hidden) lines.push(`(${plural(hidden, 'earlier turn', 'earlier turns')} not shown)`);
  // Everything that belongs to a call (its diff, its approval and the
  // answer, its result) goes straight under it, in seq order. Parallel
  // calls, the usual case, have their results arrive after all the calls,
  // in whatever order they finish, so in plain seq order a result would sit
  // under the wrong call. Anything whose call isn't shown stays where it is.
  const results = new Map<string, Extract<PersistedEvent, { type: 'tool.result' }>>();
  const attached = new Map<string, PersistedEvent[]>();
  const owned = new Set<PersistedEvent>();
  const approvalCall = new Map<string, string>();
  const attach = (itemId: string, e: PersistedEvent) => {
    const list = attached.get(itemId);
    if (!list) return;
    list.push(e);
    owned.add(e);
  };
  for (const e of shown) {
    if (e.type === 'tool.call') attached.set(e.itemId, []);
    else if (e.type === 'tool.result') {
      results.set(e.itemId, e);
      attach(e.itemId, e);
    } else if (e.type === 'edit.diff') attach(e.itemId, e);
    else if (e.type === 'approval.requested' && e.itemId && attached.has(e.itemId)) {
      approvalCall.set(e.approvalId, e.itemId);
      attach(e.itemId, e);
    } else if (e.type === 'approval.resolved' && approvalCall.has(e.approvalId)) attach(approvalCall.get(e.approvalId)!, e);
  }
  const render = (e: PersistedEvent) => {
    switch (e.type) {
      case 'user.message':
        lines.push('', ...block(e.origin === 'runner' ? 'Runner: ' : e.origin === 'schedule' ? 'Schedule: ' : 'User: ', e.text, '  '));
        for (const img of e.images ?? []) lines.push(imageLine(img, '  '));
        break;
      case 'assistant.text':
        lines.push('', ...block('Assistant: ', e.text, '  '));
        break;
      case 'reasoning':
        if (opts.tools) lines.push(`  (thinking) ${e.text.split('\n')[0].slice(0, 200)}`);
        break;
      case 'tool.call': {
        const r = results.get(e.itemId);
        const failed = r && !r.ok ? ' (failed)' : '';
        // The title cuts a command short, and with --tools the point is to
        // see exactly what ran.
        if (opts.tools && e.name === 'Bash' && typeof e.input?.command === 'string') lines.push(...block('  - ', `${e.input.command}${failed}`, '    '));
        else lines.push(`  - ${e.title}${failed}`);
        for (const a of attached.get(e.itemId) ?? []) render(a);
        break;
      }
      case 'tool.result':
        if (!opts.tools) break;
        lines.push(...capped((e.text || '(no output)').split('\n'), RESULT_LINES, '      '));
        if (e.truncated) lines.push(`      (cut short${e.blobPath ? `; all of it is in ${e.blobPath}` : ''})`);
        for (const img of e.images ?? []) lines.push(imageLine(img, '      '));
        break;
      case 'edit.diff':
        if (opts.tools) lines.push(...capped(e.hunks.flatMap((h) => h.lines), DIFF_LINES, '      '));
        break;
      case 'approval.requested': {
        // The id, so tb approve can answer it, and a Bash command whole
        // (the title is cut short).
        const cmd = e.name === 'Bash' && typeof e.input?.command === 'string' ? e.input.command : e.title;
        lines.push(...block(`  Approval asked (${e.approvalId.slice(0, 8)}): `, cmd, '    '));
        break;
      }
      case 'question.requested':
        for (const q of e.questions) {
          lines.push(`  Question: ${q.question}${q.options.length ? ` (${q.options.map((o) => o.label).join(' / ')})` : ''}`);
        }
        break;
      case 'secret.requested':
        lines.push(`  Secret asked: ${e.label}`);
        break;
      case 'approval.resolved':
        lines.push(`  Answer: ${DECISIONS[e.decision] ?? e.decision}${e.message ? `: ${e.message}` : ''}`);
        break;
      case 'plan.updated':
        lines.push('  Plan:');
        for (const x of e.entries) lines.push(`    [${x.status === 'completed' ? 'x' : x.status === 'in_progress' ? '>' : ' '}] ${x.text}`);
        break;
      case 'plan.proposed':
        lines.push('  Plan, waiting for approval:');
        for (const l of e.text.split('\n')) lines.push(`    ${l}`);
        break;
      case 'plan.resolved':
        lines.push(e.decision === 'go' ? '  (plan approved)' : '  (plan sent back)');
        break;
      case 'turn.started':
        break;
      case 'turn.completed': {
        const cost = e.costUsd !== undefined ? `, $${e.costUsd.toFixed(4)}` : '';
        lines.push(`  (${e.outcome}, ${(e.durationMs / 1000).toFixed(1)}s${cost}${e.error ? `: ${e.error}` : ''})`);
        break;
      }
      case 'system.note':
        lines.push(...block('  Note: ', e.text, '    '));
        break;
      case 'error':
        lines.push(...block('  Error: ', e.message, '    '));
        break;
      default:
        lines.push(`  (${(e as { type: string }).type})`);
    }
  };
  for (const e of shown) if (!owned.has(e)) render(e);
  return lines.join('\n') + '\n';
}

// ----------------------------------------------------------------- export

// The checkout to put fixtures in: the one the command runs in, else the
// one this tb belongs to (a release snapshot has no app/ folder).
export function findRepoRoot(starts: string[] = [process.cwd(), path.resolve(import.meta.dirname, '..', '..')]): string | undefined {
  for (const start of starts) {
    for (let d = path.resolve(start); ; d = path.dirname(d)) {
      if (fs.existsSync(path.join(d, 'app', 'Tools', 'mock-runner', 'server.mjs'))) return d;
      if (path.dirname(d) === d) break;
    }
  }
  return undefined;
}

function defaultExportDir(id: string): string {
  const root = findRepoRoot();
  if (!root) throw new Error("Couldn't find a Threadbear checkout to export into; pass --out DIR.");
  return path.join(root, 'app', '.fixtures', 'threads', id);
}

// Writes the thread the way app/Tools/mock-runner/server.mjs reads a
// fixture: thread.json (the summary), events.ndjson, and the images under
// media/ with paths relative to the fixture folder. Images that are gone
// keep their old path.
export function exportThread(t: ThreadSummary, events: PersistedEvent[], out: string): { events: number; media: number } {
  const mediaDir = path.join(out, 'media');
  fs.mkdirSync(mediaDir, { recursive: true });
  const copied = new Map<string, string>();
  const names = new Set<string>();
  const localise = (img: ImageRef): ImageRef => {
    if (!img?.path || !path.isAbsolute(img.path)) return img;
    let rel = copied.get(img.path);
    if (!rel) {
      if (!fs.existsSync(img.path)) return img;
      const base = path.basename(img.path);
      let name = base;
      for (let i = 2; names.has(name); i++) name = `${i}-${base}`;
      names.add(name);
      fs.copyFileSync(img.path, path.join(mediaDir, name));
      rel = `media/${name}`;
      copied.set(img.path, rel);
    }
    return { ...img, path: rel };
  };
  const lines = events.map((e) => {
    const images = (e as { images?: ImageRef[] }).images;
    return JSON.stringify(Array.isArray(images) ? { ...e, images: images.map(localise) } : e);
  });
  fs.writeFileSync(path.join(out, 'events.ndjson'), lines.map((l) => l + '\n').join(''));
  // The mock has no CLI behind it, so nothing will finish a turn that's in
  // progress (as when a thread exports itself): it's shown as idle.
  const summary: ThreadSummary = { ...t, live: false };
  if (BUSY.includes(summary.status)) {
    summary.status = 'idle';
    summary.needsYou = false;
  }
  fs.writeFileSync(path.join(out, 'thread.json'), JSON.stringify(summary, null, 2) + '\n');
  return { events: events.length, media: copied.size };
}

// ------------------------------------------------------------------- logs

// tb logs works with the runner down (that's when it's needed most), so it
// runs before tb connects. The file is THREADBEAR_LOG, else the one the
// runner says it writes, else where a runner on that data dir writes:
// <home>/runner.log for a dev runner or sandbox, the default for the real
// one. Which file it is goes to stderr.
export async function logsCommand(cfg: Config, f: Flags): Promise<number> {
  const file = process.env.THREADBEAR_LOG ? cfg.logFile : ((await runnerLogFile(cfg)) ?? fallbackLog(cfg));
  console.error(`==> ${file} <==`);
  const n = f.lines !== undefined ? Number(f.lines) : 200;
  if (!Number.isInteger(n) || n < 0) throw new Error('-n takes a whole number');
  const filter = typeof f.thread === 'string' && f.thread ? f.thread : undefined;
  if (!fs.existsSync(file)) {
    if (!f.follow) {
      console.error(`No log at ${file}`);
      return 1;
    }
  }
  // Where following starts: the size the tail was read at, so a line
  // written between the two is neither lost nor printed twice.
  let from = 0;
  if (fs.existsSync(file)) {
    from = fs.statSync(file).size;
    for (const line of lastLines(file, n, filter, from)) console.log(line);
  }
  if (!f.follow) return 0;
  await follow(file, filter, from);
  return 0;
}

function fallbackLog(cfg: Config): string {
  const own = path.join(cfg.home, 'runner.log');
  return !sameDir(cfg.home, defaultHome()) && fs.existsSync(own) ? own : cfg.logFile;
}

function sameDir(a: string, b: string): boolean {
  const real = (p: string) => {
    try {
      return fs.realpathSync(p);
    } catch {
      return path.resolve(p);
    }
  };
  return real(a) === real(b);
}

async function runnerLogFile(cfg: Config): Promise<string | undefined> {
  const url = runnerUrl(cfg);
  let client: RunnerClient | undefined;
  let timer: NodeJS.Timeout | undefined;
  try {
    client = new RunnerClient(url, readToken(cfg.home));
    const c = client;
    const timeout = new Promise<never>((_, reject) => (timer = setTimeout(() => reject(new Error('timeout')), 1500)));
    const s = await Promise.race([c.opened.then(() => c.call<RunnerStatus>('runner.status')), timeout]);
    return typeof s.logFile === 'string' ? s.logFile : undefined;
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
    client?.close();
  }
}

// The last n lines (that contain filter, if given), reading back from the
// end a block at a time so a big log isn't read whole.
// `upTo`: read as if the file ended there (where a follow then starts).
export function lastLines(file: string, n: number, filter?: string, upTo?: number): string[] {
  if (n === 0) return [];
  const fd = fs.openSync(file, 'r');
  try {
    let pos = Math.min(upTo ?? Infinity, fs.fstatSync(fd).size);
    let tail = '';
    let found: string[] = [];
    const BLOCK = 64 * 1024;
    while (pos > 0) {
      const len = Math.min(BLOCK, pos);
      pos -= len;
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, pos);
      // latin1 keeps one char per byte, so a UTF-8 character split across
      // two blocks comes back whole when the line is decoded at the end.
      const parts = (buf.toString('latin1') + tail).split('\n');
      // The first piece may be the end of a line that starts further back.
      tail = pos > 0 ? parts.shift()! : '';
      found = parts.filter((l) => l && (!filter || l.includes(filter))).concat(found);
      if (found.length >= n) break;
    }
    return found.slice(-n).map((l) => Buffer.from(l, 'latin1').toString('utf8'));
  } finally {
    fs.closeSync(fd);
  }
}

// Prints lines as they're added, until interrupted. A log that shrinks
// (rotated or cleared) is read again from the start.
function follow(file: string, filter: string | undefined, from: number): Promise<void> {
  let pos = from;
  let partial = '';
  return new Promise((resolve) => {
    const timer = setInterval(() => {
      let size: number;
      try {
        size = fs.statSync(file).size;
      } catch {
        return;
      }
      if (size < pos) {
        pos = 0;
        partial = '';
      }
      if (size === pos) return;
      const fd = fs.openSync(file, 'r');
      try {
        const buf = Buffer.alloc(size - pos);
        fs.readSync(fd, buf, 0, buf.length, pos);
        pos = size;
        const parts = (partial + buf.toString('utf8')).split('\n');
        partial = parts.pop() ?? '';
        for (const l of parts) if (l && (!filter || l.includes(filter))) console.log(l);
      } finally {
        fs.closeSync(fd);
      }
    }, 250);
    const stop = () => {
      clearInterval(timer);
      resolve();
    };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  });
}
