// tb: a small command line client for testing and scripting the runner.
import { parseArgs } from 'node:util';
import { startedByFlags } from './started-by-flags.ts';
import path from 'node:path';
import { loadConfig, readToken, runnerUrl } from './config.ts';
import { RunnerClient } from './client.ts';
import { poolLine } from './pools.ts';
import type { Account, ImageRef, Pool, LibrarianStatus, PersistedEvent, Project, RunnerDefaults, Schedule, ThreadSummary } from './protocol.ts';
import type { Settings } from './settings.ts';
import { backgroundFlag } from './protocol.ts';
import { parseWhen as parseLater, relativeFuture } from './when.ts';
import { DEV_HELP, formatModels, logsCommand, runDev } from './tb-dev.ts';
import { findWorktreePatch, isInside } from './patches.ts';
import { TRUST_ALL } from './patch-trust.ts';
import { land, landTargetFromGit, type LandTarget } from './worktrees.ts';
import { activityCommand } from './activity.ts';
import { pairCommand } from './pair.ts';
import { runnerKeysCommand } from './runner-keys.ts';

const OPTIONS = {
  cwd: { type: 'string' },
  account: { type: 'string' },
  pool: { type: 'string' },
  model: { type: 'string' },
  effort: { type: 'string' },
  ask: { type: 'boolean' },
  auto: { type: 'boolean' },
  plan: { type: 'boolean' },
  full: { type: 'boolean' },
  text: { type: 'string' },
  image: { type: 'string', multiple: true },
  wait: { type: 'boolean' },
  json: { type: 'boolean' },
  snoozed: { type: 'boolean' },
  archived: { type: 'boolean' },
  all: { type: 'boolean' },
  from: { type: 'string' },
  why: { type: 'string' },
  icon: { type: 'string' },
  to: { type: 'string' },
  'until-done': { type: 'boolean' },
  at: { type: 'string' },
  cron: { type: 'string' },
  tz: { type: 'string' },
  title: { type: 'string' },
  labels: { type: 'string' },
  field: { type: 'string', multiple: true },
  system: { type: 'string' },
  remove: { type: 'boolean' },
  'dry-run': { type: 'boolean' },
  // tb-dev.ts
  last: { type: 'string' },
  tools: { type: 'boolean' },
  out: { type: 'string' },
  now: { type: 'boolean' },
  force: { type: 'boolean' },
  resume: { type: 'string' },
  'no-resume': { type: 'boolean' },
  cancel: { type: 'boolean' },
  reason: { type: 'string' },
  thread: { type: 'string' },
  'max-wait': { type: 'string' },
  // tb runner
  ssh: { type: 'string' },
  id: { type: 'string' },
  finish: { type: 'boolean' },
  replace: { type: 'boolean' },
  // tb runner audit (--remove is tb models' already)
  drop: { type: 'string', multiple: true },
  snapshot: { type: 'string' },
  'keys-checked': { type: 'boolean' },
  'lock-out': { type: 'string', multiple: true },
  purge: { type: 'boolean' },
  lines: { type: 'string', short: 'n' },
  follow: { type: 'boolean', short: 'f' },
  since: { type: 'string' },
  summary: { type: 'boolean' },
  help: { type: 'boolean', short: 'h' },
} as const;

const HELP = `tb: talk to the Threadbear runner

  tb new "text" [--cwd DIR] [--pool ID | --account ID] [--model M] [--effort L] [--ask | --auto | --plan] [--image FILE]... [--wait]
                [--from NAME] [--why WORDS] [--icon SYMBOL]
                                  --pool runs it on a pool (the login with room, moving when
                                  one runs dry); --account pins it to one login. --from says a
                                  tool started it, --why says why in a few words and --icon is
                                  an SF Symbol: the row shows them under the title
  tb send <threadId> "text" [--image FILE]... [--wait]
  tb list [--snoozed] [--archived] [--all] [--json]
  tb search "words" [--json]
  tb tail <threadId> [--from SEQ] [--json] [--until-done]
  tb events <threadId> [--from SEQ] [--to SEQ] [--json]
                                  each event with its seq first (Copy debug info's "events: 5-9")
  tb interrupt <threadId>
  tb approve <threadId> <approvalId> [allow|allowAlways|deny]
  tb answer <threadId> <approvalId> "answer"
  tb snooze <threadId> <ISO time or 30m, 2h, 1d, or restart>
  tb archive <threadId>      tb unarchive <threadId>
  tb move <threadId> <folder>
  tb delete <threadId>
  tb accounts                     the Claude and Codex logins (* new threads start on it)
  tb accounts <account> [--json]  that account's models and its default
  tb pools [--json]               the pools, their logins and room (* new threads start on it)
  tb actions <threadId> [--json]  the thread's actions, panels and patches (from its folder)
  tb highlights <threadId> [--json]  what the thread made, shared and pinned, and the librarian's brief
  tb panel <threadId> <panelId> [--json]  draws an image panel or fills a list panel now
  tb show-panel <threadId> <panel> [--json]  opens a panel when the user looks at that thread
  tb run <threadId> <actionId>    run one: a command's output is printed and goes into the thread
  tb schedule "text" (--at WHEN | --cron "0 9 * * 1-5") [--tz ZONE] [--title T]
              [--thread ID | --cwd DIR [--account ID | --pool ID] [--model M] [--effort L] [--ask | --auto]]
                                  sends the text later: once (--at 30m, 2h, 1d, tomorrow
                                  or an ISO time) or on a cron; to a thread with --thread,
                                  otherwise to a new thread each time
  tb schedules [--json]           tb schedules run|pause|resume|delete <scheduleId>
  tb schedules update <scheduleId> [--text T] [--title T] [--at WHEN | --cron C] [--tz ZONE]
              [--cwd DIR] [--account ID | --pool ID] [--model M] [--effort L] [--ask | --auto | --full]
                                  changes a schedule; folder, account, model, effort and
                                  access only for one that starts a new thread
  tb projects [--archived] [--json]  the projects, their folders and thread counts
  tb projects show <project>      one project: goals, state, notes, threads
  tb projects add|remove <threadId> <project>   puts a thread in a project or takes it out, as the user would
  tb librarian [--json]           what the librarian is doing, its queue and what it did
  tb librarian run [<threadId>]   a look at a thread now; with none, at every recent thread it hasn't seen
  tb librarian pause|resume
  tb settings [--json]            what the Settings window shows
  tb models [--json]              the small-model pool and private folders
  tb models pool <pool|off>       which pool's Claude logins answer small jobs (off: none, so no titles or librarian)
  tb models try <job> "text" [--labels a,b] [--field name=description]... [--system S] [--cwd DIR]
                                  one call by hand: classify (--labels), extract (--field),
                                  summarize or generate. It spends like any other
  tb land [--dry-run]             in a thread's own worktree: rebase its branch on main, run
                                  the repo's check, then move main to it (never pushes);
                                  --dry-run stops before main moves
  tb pair                         what to copy to another Mac (this runner's token file and
                                  host) so its app can open this Mac's threads
  tb runner add <name> (--ssh <host> | --out <file>) [--id <runnerId>]
                                  on the main Mac: a backend key for another runner that acts
                                  as that runner alone, written over ssh into its
                                  secrets/convex-key (or a file); never printed
  tb runner list [--json]         tb runner revoke <runnerId> [--purge]  (--purge: and take out all it wrote)
  tb runner logins [<runnerId> <provider:email>... | none]
                                  on the main Mac: which logins a runner key's Mac gets this Mac's
                                  usage readings of (only your word counts, not what that Mac says)
  tb runner check [--ssh <host>]  whether a Mac with a runner key also has a deploy key or
                                  Convex login (either can do anything to the deployment)
  tb runner rotate-owner [--finish] [--lock-out <runnerId,...>]
                                  on the main Mac: a new RUNNER_KEY with no gap (NEXT, restart, finish);
                                  not while Convex lists a deploy key made for another Mac
                                  (CONVEX_TEAM_TOKEN for the run lets it ask; else --keys-checked),
                                  nor while another runner is still on the main key (tb runner add
                                  it first, or --lock-out to cut it off)
  tb runner audit [--drop 2,5 --snapshot <hex>]
                                  what the old shared key could have left (tokens, keys,
                                  schedules, cards, messages, pictures), numbered; --drop
                                  takes out those rows, if the listing hasn't changed
  tb retitle [<threadId>...] [--dry-run] [--json]
                                  a model title for every thread still named by its first line,
                                  or for the ones given (never one named by hand)

Thread ids can be shortened to any unique prefix.
Uses THREADBEAR_HOME and THREADBEAR_PORT like the runner does.

${DEV_HELP}`;

// The flags each command reads. Any other is refused rather than ignored:
// `tb events <id> --from 3` used to print every event as if it had worked.
const COMMAND_FLAGS: Record<string, string[]> = {
  new: ['cwd', 'account', 'pool', 'model', 'effort', 'ask', 'auto', 'plan', 'image', 'wait', 'json', 'from', 'why', 'icon'],
  send: ['image', 'wait', 'json'],
  list: ['snoozed', 'archived', 'all', 'json'],
  search: ['json'],
  tail: ['from', 'json', 'until-done'],
  events: ['from', 'to', 'json'],
  interrupt: [],
  approve: [],
  answer: [],
  snooze: [],
  archive: [],
  unarchive: [],
  move: [],
  delete: [],
  accounts: ['json'],
  pools: ['json'],
  schedule: ['at', 'cron', 'tz', 'title', 'thread', 'cwd', 'account', 'pool', 'model', 'effort', 'ask', 'auto', 'json'],
  schedules: ['json', 'text', 'title', 'at', 'cron', 'tz', 'cwd', 'account', 'pool', 'model', 'effort', 'ask', 'auto', 'full'],
  projects: ['json', 'archived'],
  librarian: ['json'],
  settings: ['json'],
  models: ['json', 'remove', 'labels', 'field', 'system', 'cwd'],
  status: ['json'],
  updates: ['json'],
  self: ['json'],
  restart: ['now', 'force', 'resume', 'no-resume', 'cancel', 'reason', 'thread', 'max-wait'],
  show: ['last', 'tools'],
  logs: ['lines', 'follow', 'thread'],
  activity: ['since', 'thread', 'summary', 'json'],
  export: ['out'],
  rpc: [],
  land: ['dry-run'],
  pair: [],
  runner: ['ssh', 'out', 'id', 'json', 'finish', 'replace', 'drop', 'snapshot', 'keys-checked', 'lock-out', 'purge'],
};

// Read but never listed when a command refuses a flag: an agent that sees
// --force in "It takes ..." learns to cut every thread's work short (tb
// restart --now --force) or withdraw someone else's deploy.
const HIDDEN_FLAGS = new Set(['force']);

// `tb show --help`: the help lines for that command (its usage line and
// the indented lines under it), or undefined for a command it doesn't know.
function commandHelp(cmd: string, help = HELP): string | undefined {
  const lines = help.split('\n');
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const name = cmd.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (!new RegExp(`^\\s*tb ${name}(\\s|$)`).test(lines[i]) && !lines[i].includes(`tb ${cmd} <`)) continue;
    out.push(lines[i]);
    // The lines that carry on its description are indented past the usage.
    while (i + 1 < lines.length && /^ {6,}\S/.test(lines[i + 1]) && !/^\s*tb /.test(lines[i + 1])) out.push(lines[++i]);
  }
  return out.length ? out.join('\n') : undefined;
}

async function main(argv: string[]): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({ args: argv, allowPositionals: true, options: OPTIONS });
  } catch (e) {
    // A typo or a flag with no value: say which, not a stack trace.
    console.error(`${(e as Error).message}\nSee tb --help.`);
    return 2;
  }
  const { values, positionals } = parsed;
  const [cmd, ...args] = positionals;
  if (!cmd || values.help) {
    console.log((cmd && commandHelp(cmd)) || HELP);
    return cmd ? 0 : 1;
  }
  const allowed = COMMAND_FLAGS[cmd];
  if (allowed) {
    const wrong = Object.keys(values).filter((k) => values[k as keyof typeof values] !== undefined && !allowed.includes(k));
    if (wrong.length) {
      const names = wrong.map((k) => `--${k}`).join(', ');
      const shown = allowed.filter((k) => !HIDDEN_FLAGS.has(k));
      console.error(`tb ${cmd} doesn't take ${names}.${shown.length ? ` It takes ${shown.map((k) => `--${k}`).join(', ')}.` : ''}\nSee tb ${cmd} --help.`);
      return 2;
    }
  }
  const cfg = loadConfig();
  if (cmd === 'logs') return logsCommand(cfg, values);
  // The app's activity log is files on this Mac: no runner needed.
  if (cmd === 'activity') return activityCommand(cfg, values);
  // Works with no runner too: from any thread/ worktree, by git alone.
  if (cmd === 'land') return landCommand(cfg, Boolean(values['dry-run']));
  // Read from runner.json alone, on the Mac being paired.
  if (cmd === 'pair') return pairCommand(cfg);
  // Straight to the backend with this Mac's key, so no runner needed either.
  if (cmd === 'runner') {
    const flags = { ...(typeof values.ssh === 'string' ? { ssh: values.ssh } : {}), ...(typeof values.out === 'string' ? { out: values.out } : {}), ...(typeof values.id === 'string' ? { id: values.id } : {}), json: Boolean(values.json), finish: Boolean(values.finish), replace: Boolean(values.replace), ...(Array.isArray(values.drop) ? { remove: values.drop as string[] } : {}), ...(typeof values.snapshot === 'string' ? { snapshot: values.snapshot } : {}), keysChecked: Boolean(values['keys-checked']), ...(Array.isArray(values['lock-out']) ? { lockOut: values['lock-out'] as string[] } : {}), purge: Boolean(values.purge) };
    // The audit asks this Mac's runner how far each of its threads goes.
    const heads = async () => {
      const client = await RunnerClient.connect(runnerUrl(cfg), readToken(cfg.home));
      try {
        await client.call('hello', { client: 'tb', version: '1' });
        const r = await client.call<{ threads: ThreadSummary[] }>('threads.list', { include: ['inbox', 'snoozed', 'archived'] });
        return r.threads.map((t) => ({ threadId: t.id, lastSeq: t.lastSeq }));
      } finally {
        client.close();
      }
    };
    return runnerKeysCommand(cfg, args, flags, { heads });
  }
  const url = runnerUrl(cfg);
  let client: RunnerClient;
  try {
    client = await RunnerClient.connect(url, readToken(cfg.home));
  } catch (e) {
    console.error(`Couldn't reach the runner at ${url}: ${(e as Error).message}`);
    return 2;
  }
  try {
    await client.call('hello', { client: 'tb', version: '1' });
    return await run(client, cmd, args, values);
  } catch (e) {
    console.error((e as Error).message);
    return 1;
  } finally {
    client.close();
  }
}

type Flags = Record<string, string | boolean | string[] | undefined>;

// `tb land` (docs/thread-worktrees.md, worktrees.ts). Inside a thread
// (THREADBEAR_THREAD_ID) the runner says where the thread's worktree is;
// otherwise, or when the thread has none, it's the git checkout this runs
// in, if that's on a thread/ branch. The check is the one in that
// worktree's own patch, so a branch that changes it lands under its own.
async function landCommand(cfg: ReturnType<typeof loadConfig>, dryRun: boolean): Promise<number> {
  const here = process.cwd();
  let target: Omit<LandTarget, 'check'> | undefined;
  let from = here;
  const threadId = process.env.THREADBEAR_THREAD_ID;
  if (threadId) {
    const t = await threadFromRunner(cfg, threadId);
    if (t?.worktree) {
      target = t.worktree;
      if (!isInside(here, t.worktree.path)) from = isInside(t.cwd, t.worktree.path) ? t.cwd : t.worktree.path;
    }
  }
  if (!target) {
    const found = await landTargetFromGit(here);
    if (!found.target) {
      console.error(found.reason);
      return 1;
    }
    target = found.target;
  }
  return land(target, {
    dryRun,
    // Read after the landing lock and rebase: main may have changed the
    // check while we waited. Running tb land asks for this patch's check.
    readCheck: async () => (await findWorktreePatch(from, undefined, undefined, undefined, TRUST_ALL, true))?.check,
  });
}

// The thread's summary, or undefined when the runner can't be reached or
// doesn't know it (tb land then goes by git alone).
async function threadFromRunner(cfg: ReturnType<typeof loadConfig>, threadId: string): Promise<ThreadSummary | undefined> {
  let client: RunnerClient;
  try {
    client = await RunnerClient.connect(runnerUrl(cfg), readToken(cfg.home));
  } catch {
    return undefined;
  }
  try {
    await client.call('hello', { client: 'tb', version: '1' });
    const r = await client.call<{ threads: ThreadSummary[] }>('threads.list', { include: ['inbox', 'snoozed', 'archived'] });
    return r.threads.find((t) => t.id === threadId);
  } catch {
    return undefined;
  } finally {
    client.close();
  }
}


async function run(client: RunnerClient, cmd: string, args: string[], f: Flags): Promise<number> {
  const images = async (): Promise<ImageRef[]> => {
    const out: ImageRef[] = [];
    for (const p of (f.image as string[] | undefined) ?? []) {
      const r = await client.call<{ image: ImageRef }>('media.import', { path: path.resolve(p) });
      out.push(r.image);
    }
    return out;
  };
  switch (cmd) {
    case 'new': {
      const params: Record<string, unknown> = { text: args[0] ?? '', images: await images() };
      if (f.cwd) params.cwd = path.resolve(String(f.cwd));
      if (f.account) params.accountId = f.account;
      if (f.pool) params.poolId = f.pool;
      if (f.model) params.model = f.model;
      if (f.effort) params.effort = f.effort;
      if (f.ask) params.permissionMode = 'ask';
      else if (f.auto) params.permissionMode = 'auto';
      else if (f.plan) params.permissionMode = 'plan';
      const startedBy = startedByFlags(f, process.env.THREADBEAR_THREAD_ID);
      if (startedBy) params.startedBy = startedBy;
      const r = await client.call<{ thread: ThreadSummary; turnId: string }>('threads.create', params);
      console.log(r.thread.id);
      if (f.wait) return tail(client, r.thread.id, { from: 0, json: Boolean(f.json), untilTurn: r.turnId });
      return 0;
    }
    case 'send': {
      const id = await resolveId(client, args[0]);
      // The newest seq before sending, so the tail starts with this message.
      // (threads.events, not markSeen, which would mark the thread read.)
      const before = f.wait ? (await client.call<{ lastSeq: number }>('threads.events', { threadId: id, limit: 1 })).lastSeq : 0;
      const r = await client.call<{ turnId: string }>('threads.send', { threadId: id, text: args[1] ?? '', images: await images() });
      if (f.wait) return tail(client, id, { from: before, json: Boolean(f.json), untilTurn: r.turnId });
      console.log(r.turnId);
      return 0;
    }
    case 'list': {
      const include = f.all ? ['inbox', 'snoozed', 'archived'] : f.archived ? ['archived'] : f.snoozed ? ['snoozed'] : ['inbox'];
      const r = await client.call<{ threads: ThreadSummary[] }>('threads.list', { include });
      printThreads(r.threads, Boolean(f.json));
      return 0;
    }
    case 'search': {
      const r = await client.call<{ threads: ThreadSummary[] }>('threads.search', { query: args.join(' ') });
      printThreads(r.threads, Boolean(f.json));
      return 0;
    }
    case 'tail': {
      const id = await resolveId(client, args[0]);
      return tail(client, id, { from: f.from !== undefined ? Number(f.from) : undefined, json: Boolean(f.json), untilDone: Boolean(f['until-done']) });
    }
    case 'events': {
      const id = await resolveId(client, args[0]);
      const from = seqFlag(f.from, '--from');
      const to = seqFlag(f.to, '--to');
      if (from !== undefined && to !== undefined && to < from) throw new Error('--to is before --from');
      const params: Record<string, unknown> = { threadId: id, limit: 10_000 };
      if (from !== undefined) params.afterSeq = from - 1;
      if (to !== undefined) params.beforeSeq = to + 1;
      const r = await client.call<{ events: PersistedEvent[] }>('threads.events', params);
      // Each line starts with its seq, so the seqs in Copy debug info and
      // an export's events.ndjson can be matched up.
      for (const e of r.events) printEvent(e, Boolean(f.json), f.json ? '' : `${String(e.seq).padStart(5)}  `);
      return 0;
    }
    case 'interrupt': {
      const id = notSelf(await resolveId(client, args[0]), "That's the thread this runs in. Just end the turn.");
      await client.call('threads.interrupt', { threadId: id });
      return 0;
    }
    case 'approve':
    case 'answer': {
      // Its own cards are Mike's to answer: delete_thread always asks him,
      // and an edit in an ask-before-edits thread waits for him.
      const threadId = notSelf(await resolveId(client, args[0]), "That's this thread's own card; the user answers it.");
      const params: Record<string, unknown> = { threadId, approvalId: await resolveApproval(client, threadId, args[1]) };
      if (cmd === 'approve') params.decision = args[2] ?? 'allow';
      else Object.assign(params, { decision: 'answered', answers: { '0': args[2] ?? '' } });
      await client.call('approvals.respond', params);
      return 0;
    }
    case 'move': {
      const id = await resolveId(client, args[0]);
      if (!args[1]) throw new Error('folder required');
      const r = await client.call<{ thread: ThreadSummary }>('threads.update', { threadId: id, cwd: path.resolve(args[1]) });
      console.log(`moved to ${r.thread.cwd} (from the next message)`);
      return 0;
    }
    case 'delete': {
      const id = notSelf(await resolveId(client, args[0]), "A thread can't delete itself. Ask the user to.");
      await client.call('threads.delete', { threadId: id });
      console.log(`deleted ${id}`);
      return 0;
    }
    case 'snooze': {
      const id = notSelf(await resolveId(client, args[0]), STOPS_SELF);
      // "restart": until the runner next starts; "release": until it starts on a new release.
      const word = args[1]?.toLowerCase();
      const until = word === 'restart' || word === 'release' ? word : parseWhen(args[1] ?? '1h');
      const r = await client.call<{ thread: ThreadSummary }>('threads.update', { threadId: id, snoozedUntil: until });
      console.log(`snoozed until ${r.thread.snoozedUntilRelease ? 'a new release' : r.thread.snoozedUntilRestart ? 'the runner restarts' : r.thread.snoozedUntil}`);
      return 0;
    }
    case 'archive':
    case 'unarchive': {
      const id = await resolveId(client, args[0]);
      if (cmd === 'archive') notSelf(id, STOPS_SELF);
      // Run from a thread (its agent), it's the agent archiving, not Mike.
      const by = cmd === 'archive' && process.env.THREADBEAR_THREAD_ID ? { archivedBy: 'agent' } : {};
      await client.call('threads.update', { threadId: id, archived: cmd === 'archive', ...by });
      return 0;
    }
    case 'highlights': {
      const id = await resolveId(client, args[0]);
      const h = await client.call<{ highlights: { id: string; kind: string; title: string; how: string; note?: string; url?: string; path?: string; branch?: string; pushed?: true }[]; edited: string[]; brief?: { text: string } }>('threads.highlights', { threadId: id });
      if (f.json) {
        console.log(JSON.stringify(h, null, 2));
        return 0;
      }
      if (h.brief) console.log(`${h.brief.text}\n`);
      if (!h.highlights.length) console.log('Nothing found or pinned yet.');
      for (const x of h.highlights) {
        const where = x.url ?? (x.path ? tildePath(x.path) : x.branch ? `${x.branch}${x.pushed ? ', pushed' : ''}` : '');
        console.log(`  ${x.how.padEnd(10)} ${x.kind.padEnd(7)} ${x.title}${where && where !== x.title ? `  ${where}` : ''}${x.note ? `\n             ${x.note}` : ''}`);
      }
      if (h.edited.length) console.log(`\n${h.edited.length} ${h.edited.length === 1 ? 'file' : 'files'} edited`);
      return 0;
    }
    case 'show-panel': {
      const id = await resolveId(client, args[0]);
      if (!args[1]) throw new Error('Name a panel, such as browser or highlights.');
      const result = await client.call<{ available: boolean; shown?: boolean }>('threads.showPanel', { threadId: id, panel: args[1] });
      if (f.json) console.log(JSON.stringify(result));
      else console.log(!result.available ? 'The Threadbear Mac app is not connected.' : result.shown ? 'The panel is open.' : 'The panel will open when the user next opens that thread.');
      return result.available ? 0 : 1;
    }
    case 'panel': {
      const id = await resolveId(client, args[0]);
      if (!args[1]) throw new Error('Which panel? tb actions <threadId> lists them.');
      const r = await client.call<{ image?: { path: string }; items?: { title: string; detail?: string; tone?: string }[]; note?: string }>('panels.render', { threadId: id, panelId: args[1] });
      if (f.json) {
        console.log(JSON.stringify(r, null, 2));
        return 0;
      }
      if (r.note) console.log(r.note);
      if (r.image) console.log(r.image.path);
      for (const item of r.items ?? []) console.log(`  ${item.tone === 'done' ? '✓' : item.tone === 'failed' ? '✗' : item.tone === 'attention' ? '!' : '·'} ${item.title}${item.detail ? `  ${item.detail}` : ''}`);
      return 0;
    }
    case 'actions': {
      const id = await resolveId(client, args[0]);
      const thread = (await client.call<{ threads: ThreadSummary[] }>('threads.list', { include: ['inbox', 'snoozed', 'archived'] })).threads.find((x) => x.id === id);
      if (!thread) throw new Error(`No thread ${id}`);
      if (f.json) {
        console.log(JSON.stringify({ actions: thread.actions ?? [], panels: thread.panels ?? [], hooks: thread.hooks ?? [], patches: thread.patches ?? [] }, null, 2));
        return 0;
      }
      const actions = thread.actions ?? [];
      const panels = thread.panels ?? [];
      const hooks = thread.hooks ?? [];
      const patches = thread.patches ?? [];
      if (!actions.length && !panels.length && !hooks.length && !patches.length) {
        console.log(`No patches apply to ${thread.cwd}. Add .threadbear/patches/<name>.ts there (see docs/protocol.md, Patches).`);
        return 0;
      }
      if (actions.length) {
        console.log('Actions:');
        for (const a of actions) console.log(`  ${a.id.padEnd(32)} ${a.title}${a.kind === 'prompt' ? '  (prompt)' : a.kind === 'url' ? `  ${a.url}` : `  $ ${a.command}`}`);
      }
      if (panels.length) {
        console.log('Panels:');
        for (const p of panels) console.log(`  ${p.id.padEnd(32)} ${p.title}${p.url ? `  ${p.url}` : `  (${p.kind})`}${p.note ? `  ${p.note}` : ''}`);
      }
      if (hooks.length) {
        console.log('Hooks:');
        for (const h of hooks) console.log(`  ${h.id.padEnd(32)} ${h.title}  after a turn${h.edited ? ` that edited ${h.edited}` : ''}  $ ${h.command}  (tell ${h.tell})`);
      }
      console.log('Patches:');
      for (const p of patches) console.log(`  ${p.id.padEnd(32)} ${p.source}${p.file ? `  ${p.file}` : ''}${p.error ? `  ERROR ${p.error}` : ''}`);
      return 0;
    }
    case 'run': {
      const id = await resolveId(client, args[0]);
      if (!args[1]) throw new Error('Which action? tb actions <threadId> lists them.');
      const before = (await client.call<{ lastSeq: number }>('threads.events', { threadId: id, limit: 1 })).lastSeq;
      // No client-side timeout: the runner stops a command after its own limit.
      const r = await client.call<{ turnId?: string; ok?: boolean; exitCode?: number; durationMs?: number; seq?: number }>('actions.run', { threadId: id, actionId: args[1] });
      if (r.turnId) {
        console.log(`Sent as a message; turn ${r.turnId}.`);
        return 0;
      }
      if (r.seq !== undefined) {
        const page = await client.call<{ events: { seq: number; type: string; text?: string }[] }>('threads.events', { threadId: id, afterSeq: Math.max(before, r.seq - 1), limit: 1 });
        const ev = page.events.find((e) => e.seq === r.seq);
        if (ev?.text) console.log(ev.text.trimEnd());
      }
      console.log(`(${r.ok ? 'ok' : 'failed'}${r.exitCode !== undefined ? `, exit ${r.exitCode}` : ''}, ${((r.durationMs ?? 0) / 1000).toFixed(1)}s)`);
      return r.ok ? 0 : 1;
    }
    case 'accounts': {
      const r = await client.call<{ accounts: Account[]; defaults: RunnerDefaults }>('hello', { client: 'tb', version: '1' });
      // With an account, its models (tb models is the runner's own small jobs).
      if (args[0]) {
        const a = r.accounts.find((x) => x.id === args[0]) ?? r.accounts.find((x) => x.email === args[0] || x.title === args[0]);
        if (!a) throw new Error(`No account ${args[0]}. Accounts: ${r.accounts.map((x) => x.id).join(', ')}`);
        if (f.json) {
          console.log(JSON.stringify({ accountId: a.id, provider: a.provider, defaultModel: a.defaultModel, defaultEffort: a.defaultEffort, models: a.models ?? [] }, null, 2));
          return 0;
        }
        console.log(formatModels(a, r.defaults));
        return 0;
      }
      for (const a of r.accounts) {
        const note = a.note ? `  (${a.note})` : '';
        // The provider has its own column, so not "Codex · " again.
        const who = a.email ?? a.title.replace(/^Codex · /, '');
        console.log(`${a.id === r.defaults.accountId ? '*' : ' '} ${a.id.padEnd(12)} ${(a.provider === 'codex' ? 'Codex' : 'Claude').padEnd(7)}${who}${note}`);
      }
      return 0;
    }
    case 'pools': {
      const r = await client.call<{ accounts: Account[]; pools?: Pool[]; defaults: RunnerDefaults }>('hello', { client: 'tb', version: '1' });
      if (!r.pools) throw new Error('This runner is older than pools.');
      if (f.json) {
        console.log(JSON.stringify({ pools: r.pools, defaultPoolId: r.defaults.poolId }, null, 2));
        return 0;
      }
      for (const p of r.pools) {
        const folders = p.folders?.length ? `  (folders: ${p.folders.join(', ')})` : '';
        console.log(`${p.id === r.defaults.poolId ? '*' : ' '} ${p.id.padEnd(12)} ${p.title.padEnd(10)} ${poolLine(p, r.accounts, Date.now())}${folders}`);
      }
      return 0;
    }
    case 'schedule': {
      if (!args[0]) throw new Error('What should it send? tb schedule "text" --at 30m');
      if (Boolean(f.at) === Boolean(f.cron)) throw new Error('Give --at (once) or --cron (repeating).');
      const params: Record<string, unknown> = { text: args[0] };
      if (f.at) params.at = parseLater(String(f.at), Date.now());
      if (f.cron) params.cron = f.cron;
      if (f.tz) params.timezone = f.tz;
      if (f.title) params.title = f.title;
      if (f.thread) params.threadId = await resolveId(client, String(f.thread));
      else {
        if (f.cwd) params.cwd = path.resolve(String(f.cwd));
        if (f.account) params.accountId = f.account;
        if (f.pool) params.poolId = f.pool;
        if (f.model) params.model = f.model;
        if (f.effort) params.effort = f.effort;
        if (f.ask) params.permissionMode = 'ask';
        else if (f.auto) params.permissionMode = 'auto';
      }
      // A schedule an agent makes from a thread says which one.
      if (process.env.THREADBEAR_THREAD_ID) params.createdBy = process.env.THREADBEAR_THREAD_ID;
      const r = await client.call<{ schedule: Schedule }>('schedules.create', params);
      if (f.json) console.log(JSON.stringify(r.schedule));
      else printSchedules([r.schedule]);
      return 0;
    }
    case 'schedules': {
      const [action, id] = args;
      if (!action) {
        const r = await client.call<{ schedules: Schedule[] }>('schedules.list', {});
        if (f.json) console.log(JSON.stringify(r.schedules, null, 2));
        else if (!r.schedules.length) console.log('No schedules.');
        else printSchedules(r.schedules);
        return 0;
      }
      if (!id) throw new Error(`tb schedules ${action} <scheduleId>`);
      if (action === 'delete') {
        await client.call('schedules.delete', { scheduleId: id });
        console.log('deleted');
        return 0;
      }
      if (action === 'run') {
        const r = await client.call<{ threadId: string }>('schedules.run', { scheduleId: id });
        console.log(`sent to ${r.threadId}`);
        return 0;
      }
      if (action === 'update') {
        const params: Record<string, unknown> = { scheduleId: id };
        if (f.text !== undefined) params.text = f.text;
        if (f.title !== undefined) params.title = f.title;
        if (f.at) params.at = parseLater(String(f.at), Date.now());
        if (f.cron) params.cron = f.cron;
        if (f.tz !== undefined) params.timezone = f.tz || null;
        if (f.cwd) params.cwd = path.resolve(String(f.cwd));
        if (f.account) params.accountId = f.account;
        // --pool "" takes it out of its pool.
        if (f.pool !== undefined) params.poolId = f.pool || null;
        if (f.model !== undefined) params.model = f.model || null;
        if (f.effort !== undefined) params.effort = f.effort || null;
        if ([f.ask, f.auto, f.full].filter(Boolean).length > 1) throw new Error('Give one of --ask, --auto and --full.');
        if (f.ask) params.permissionMode = 'ask';
        else if (f.auto) params.permissionMode = 'auto';
        else if (f.full) params.permissionMode = 'full';
        if (Object.keys(params).length === 1) throw new Error('Nothing to change. tb schedules update <scheduleId> --account claude-2 (tb --help lists the rest)');
        const r = await client.call<{ schedule: Schedule }>('schedules.update', params);
        if (f.json) console.log(JSON.stringify(r.schedule));
        else printSchedules([r.schedule]);
        return 0;
      }
      if (action !== 'pause' && action !== 'resume') throw new Error(`Unknown: tb schedules ${action}. It's update, run, pause, resume or delete.`);
      const r = await client.call<{ schedule: Schedule }>('schedules.update', { scheduleId: id, paused: action === 'pause' });
      printSchedules([r.schedule]);
      return 0;
    }
    case 'projects': {
      const [action, a, b] = args;
      if (!action) {
        const r = await client.call<{ projects: Project[] }>('projects.list', { archived: Boolean(f.archived) });
        if (f.json) console.log(JSON.stringify(r.projects, null, 2));
        else if (!r.projects.length) console.log('No projects yet.');
        else for (const p of r.projects) console.log(projectLine(p));
        return 0;
      }
      if (action === 'show') {
        if (!a) throw new Error('tb projects show <project>');
        const r = await client.call<{ project: Project; threadIds: string[] }>('projects.get', { projectId: await projectId(client, a) });
        if (f.json) console.log(JSON.stringify(r, null, 2));
        else printProject(r.project, r.threadIds);
        return 0;
      }
      if (action === 'add' || action === 'remove') {
        if (!a || !b) throw new Error(`tb projects ${action} <threadId> <project>`);
        const pid = await projectId(client, b);
        const r = await client.call<{ thread: ThreadSummary }>('threads.setProjects', { threadId: a, [action]: [pid] });
        console.log(`${r.thread.title}: ${(r.thread.projects ?? []).map((p) => p.title).join(', ') || 'in no project'}`);
        return 0;
      }
      throw new Error(`Unknown: tb projects ${action}. It's show, add or remove.`);
    }
    case 'librarian': {
      const [action, id] = args;
      let r: { librarian: LibrarianStatus };
      if (!action) r = await client.call('librarian.status', {});
      else if (action === 'run') r = await client.call('librarian.run', id ? { threadId: id } : {});
      else if (action === 'pause' || action === 'resume') r = await client.call('librarian.update', { paused: action === 'pause' });
      else throw new Error(`Unknown: tb librarian ${action}. It's run, pause or resume.`);
      if (f.json) console.log(JSON.stringify(r.librarian, null, 2));
      else printLibrarian(r.librarian);
      return 0;
    }
    case 'settings': {
      const r = await client.call<{ settings: Settings }>('settings.get', {});
      if (f.json) console.log(JSON.stringify(r.settings, null, 2));
      else printSettings(r.settings);
      return 0;
    }
    case 'models':
      return modelsCommand(client, args, f);
    case 'retitle': {
      const dryRun = Boolean(f['dry-run']);
      const threadIds = args.length ? await Promise.all(args.map((a) => resolveId(client, a))) : undefined;
      const r = await client.call<{ threads: { threadId: string; from: string; to?: string; reason?: string }[] }>('threads.retitle', { dryRun, threadIds });
      if (f.json) {
        console.log(JSON.stringify(r.threads, null, 2));
        return 0;
      }
      if (!r.threads.length) console.log('Every thread already has a name.');
      for (const t of r.threads) {
        const what = dryRun ? '' : t.to ? `  ->  ${t.to}` : `  (kept: ${t.reason})`;
        console.log(`${t.threadId.slice(0, 8)}  ${t.from}${what}`);
      }
      const named = r.threads.filter((t) => t.to).length;
      if (r.threads.length) console.log(dryRun ? `\n${r.threads.length} to name. Run tb retitle to name them.` : `\nNamed ${named} of ${r.threads.length}.`);
      return named === r.threads.length || dryRun ? 0 : 1;
    }
    default: {
      const code = await runDev(client, cmd, args, f, (prefix) => resolveId(client, prefix));
      if (code !== undefined) return code;
      console.error(`Unknown command: ${cmd}\n\n${HELP}`);
      return 1;
    }
  }
}

function printSettings(s: Settings): void {
  console.log(`Default folder   ${s.defaultCwd}`);
  console.log(`Idle minutes     ${s.idleMinutes}`);
  console.log(`Most live CLIs   ${s.maxLiveCLIs}`);
  console.log(`Follow main      ${s.followMain ? 'on' : 'off'}`);
  console.log(`Bullet replies   ${s.bulletReplies === false ? 'off' : 'on'}`);
  console.log(`One reply        ${s.oneReply ? 'on' : 'off'}`);
  printModels(s);
}

function printModels(s: Settings): void {
  const m = s.models;
  console.log(`Small jobs on    ${m.pool === null ? 'nothing: titles and the librarian are off' : `the ${m.pool} pool`}`);
  console.log(`Private folders  ${m.privateFolders.length ? m.privateFolders.join(', ') : 'none'}`);
}

async function modelsCommand(client: RunnerClient, args: string[], f: Flags): Promise<number> {
  const [action, ...rest] = args;
  if (!action) {
    const r = await client.call<{ settings: Settings }>('settings.get', {});
    if (f.json) console.log(JSON.stringify(r.settings.models, null, 2));
    else printModels(r.settings);
    return 0;
  }
  if (action === 'pool') {
    const [id] = rest;
    if (!id || rest.length > 1) throw new Error('tb models pool <pool|off>. tb pools lists them.');
    const r = await client.call<{ settings: Settings }>('settings.update', { models: { pool: id === 'off' ? null : id } });
    printModels(r.settings);
    return 0;
  }
  if (action === 'try') {
    const [job, text] = rest;
    if (!job || text === undefined) throw new Error('tb models try <classify|extract|summarize|generate> "text"');
    const params: Record<string, unknown> = { job, text };
    if (f.labels) params.labels = String(f.labels).split(',').map((l) => l.trim()).filter(Boolean);
    if (f.field) {
      const fields: Record<string, string> = {};
      for (const kv of f.field as string[]) {
        const i = kv.indexOf('=');
        if (i < 1) throw new Error(`--field takes name=description, not ${kv}`);
        fields[kv.slice(0, i).trim()] = kv.slice(i + 1).trim();
      }
      params.fields = fields;
    }
    if (f.system) params.system = f.system;
    if (f.cwd) params.cwd = path.resolve(String(f.cwd));
    const r = await client.call<{ ok: boolean; value?: unknown; model?: string; reason?: string; message?: string }>('models.run', params);
    if (f.json) console.log(JSON.stringify(r, null, 2));
    else if (!r.ok) console.error(`Not sent or no answer (${r.reason}): ${r.message}`);
    else {
      console.log(typeof r.value === 'string' ? r.value : JSON.stringify(r.value, null, 2));
      console.error(`(${r.model})`);
    }
    return r.ok ? 0 : 1;
  }
  throw new Error(`Unknown: tb models ${action}. It's pool or try.`);
}

// Inside a thread, tb won't stop the thread it runs in, as the threadbear
// MCP tools won't (threadbear-mcp.ts): it would end this very turn.
// THREADBEAR_THREAD_ID is only set in a thread's own CLI and what it runs.
const STOPS_SELF = "Can't snooze or archive the thread this runs in from inside its own turn. Do it once the turn is over by calling end_turn with needs \"nothing\" and archive: true, or snooze: and when to wake (30m, 2h, tomorrow, an ISO time, \"restart\", or words like \"when the phone arrives\"), again if you already have.";

function notSelf(id: string, message: string): string {
  if (id === process.env.THREADBEAR_THREAD_ID) throw new Error(message);
  return id;
}

function seqFlag(v: string | boolean | string[] | undefined, name: string): number | undefined {
  if (v === undefined) return undefined;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1) throw new Error(`${name} takes a seq, a whole number from 1`);
  return n;
}

async function resolveId(client: RunnerClient, prefix: string | undefined): Promise<string> {
  if (!prefix) throw new Error('thread id required');
  const r = await client.call<{ threads: ThreadSummary[] }>('threads.list', { include: ['inbox', 'snoozed', 'archived'] });
  const hits = r.threads.filter((t) => t.id.startsWith(prefix));
  if (hits.length === 1) return hits[0].id;
  if (hits.length === 0) return prefix;
  throw new Error(`${prefix} matches ${hits.length} threads`);
}

// An approval id, or the start of one (tb show prints the first 8
// characters), among the thread's approvals that haven't been answered.
async function resolveApproval(client: RunnerClient, threadId: string, prefix: string | undefined): Promise<string> {
  if (!prefix) throw new Error('approval id required');
  const { events } = await client.call<{ events: PersistedEvent[] }>('threads.events', { threadId, limit: 10_000 });
  const resolved = new Set(events.flatMap((e) => (e.type === 'approval.resolved' ? [e.approvalId] : [])));
  const open = events.flatMap((e) => ((e.type === 'approval.requested' || e.type === 'question.requested') && !resolved.has(e.approvalId) ? [e.approvalId] : []));
  if (open.includes(prefix)) return prefix;
  const hits = open.filter((id) => id.startsWith(prefix));
  if (hits.length === 1) return hits[0];
  if (hits.length > 1) throw new Error(`${prefix} matches ${hits.length} open approvals`);
  return prefix;
}

function parseWhen(s: string): string {
  const m = /^(\d+)([mhd])$/.exec(s);
  if (m) {
    const ms = Number(m[1]) * { m: 60_000, h: 3_600_000, d: 86_400_000 }[m[2] as 'm' | 'h' | 'd'];
    return new Date(Date.now() + ms).toISOString();
  }
  const t = Date.parse(s);
  if (Number.isNaN(t)) throw new Error(`Can't read the time ${s}`);
  return new Date(t).toISOString();
}

function printSchedules(list: Schedule[]): void {
  for (const sc of list) {
    const state = sc.finishedAt ? 'done' : sc.paused ? 'paused' : sc.nextRunAt ? `next ${relativeFuture(sc.nextRunAt, Date.now())}` : 'no more runs';
    const on = [sc.accountId, sc.poolId && `${sc.poolId} pool`, sc.model, sc.effort].filter(Boolean).join(', ');
    const target = sc.threadId ? `thread ${sc.threadId.slice(0, 8)}` : `new thread in ${sc.cwd}${on ? ` (${on})` : ''}`;
    const last = sc.lastRun && sc.lastRun.outcome !== 'sent' ? `  (last run ${sc.lastRun.outcome}: ${sc.lastRun.note ?? ''})` : '';
    console.log(`${sc.id.slice(0, 8)}  ${sc.title}  [${sc.whenText}, ${state}]  ${target}${last}`);
  }
}

function printThreads(threads: ThreadSummary[], json: boolean): void {
  if (json) {
    console.log(JSON.stringify(threads, null, 2));
    return;
  }
  for (const t of threads) {
    const flags = [t.status, t.live ? 'live' : '', t.needsYou ? 'needs you' : '', backgroundFlag(t.background)].filter(Boolean).join(', ');
    console.log(`${t.id.slice(0, 8)}  ${t.title}  [${flags}]  ${t.accountId}`);
    if (t.preview) console.log(`          ${t.preview}`);
  }
}

let midLine = false;
const streamed = new Set<string>();

// prefix (tb events' seq) goes before the event's first line.
function printEvent(e: any, json: boolean, prefix = ''): void {
  if (json) {
    console.log(JSON.stringify(e));
    return;
  }
  const out = (s: string) => {
    if (midLine) process.stdout.write('\n');
    midLine = false;
    console.log(prefix ? prefix + s.replace(/^\n+/, '') : s);
  };
  switch (e.type) {
    case 'assistant.text.delta':
      process.stdout.write(e.text);
      streamed.add(e.itemId);
      midLine = true;
      return;
    case 'reasoning.delta':
    // A command's output as it runs (Codex streams it); its result follows.
    case 'tool.output.delta':
      return;
    case 'user.message':
      return out(`\n> ${e.text}${e.images?.length ? ` [${e.images.length} image(s)]` : ''}`);
    case 'assistant.text':
      // Already shown as it streamed.
      if (streamed.has(e.itemId)) {
        if (midLine) process.stdout.write('\n');
        midLine = false;
        return;
      }
      return out(e.text);
    case 'reasoning':
      return out(`(thinking) ${e.text.split('\n')[0]}`);
    case 'tool.call':
      return out(`- ${e.title}`);
    case 'tool.result':
      return out(`  ${e.ok ? 'ok' : 'failed'}: ${String(e.text).split('\n')[0].slice(0, 120)}${e.images?.length ? ` [${e.images.length} image(s)]` : ''}`);
    case 'edit.diff':
      return out(e.hunks.flatMap((h: { lines: string[] }) => h.lines).map((l: string) => `  ${l}`).join('\n'));
    case 'approval.requested':
      return out(`? approve ${e.title}: tb approve ${e.threadId.slice(0, 8)} ${e.approvalId} allow|deny`);
    case 'question.requested':
      return out(`? ${e.questions.map((q: { question: string }) => q.question).join(' / ')}: tb answer ${e.threadId.slice(0, 8)} ${e.approvalId} "..."`);
    case 'secret.requested':
      // No tb command answers it: an agent mustn't be able to type its own.
      return out(`? secret: ${e.label} (answer it in the app or on the phone)`);
    case 'approval.resolved':
      return out(`  (${e.decision})`);
    case 'plan.updated':
      return out(e.entries.map((x: { status: string; text: string }) => `  [${x.status === 'completed' ? 'x' : x.status === 'in_progress' ? '>' : ' '}] ${x.text}`).join('\n'));
    case 'plan.proposed':
      return out(`Plan, waiting for approval:\n${e.text}`);
    case 'plan.resolved':
      return out(e.decision === 'go' ? '(plan approved)' : '(plan sent back)');
    case 'turn.started':
      // tb events lists every event, so its seqs have no gaps.
      return prefix ? out('(turn started)') : undefined;
    case 'turn.completed':
      return out(`(${e.outcome}, ${(e.durationMs / 1000).toFixed(1)}s${e.costUsd !== undefined ? `, $${e.costUsd.toFixed(4)}` : ''}${e.error ? `: ${e.error}` : ''})`);
    case 'system.note':
      return out(`(${e.text})`);
    case 'action.run':
      return out(`- ${e.title} (${e.trigger === 'turn.end' ? 'hook, after the turn' : 'action'}, ${e.ok ? 'ok' : 'failed'}, ${(e.durationMs / 1000).toFixed(1)}s)${e.text ? `\n  ${String(e.text).split('\n')[0].slice(0, 120)}` : ''}`);
    case 'error':
      return out(`error: ${e.message}`);
    default:
      return out(`(${e.type})`);
  }
}

async function tail(
  client: RunnerClient,
  threadId: string,
  opts: { from?: number; json: boolean; untilTurn?: string; untilDone?: boolean },
): Promise<number> {
  return new Promise((resolve) => {
    const done = (code: number) => {
      if (midLine) process.stdout.write('\n');
      resolve(code);
    };
    // --until-done waits for the turn running now, so an old
    // turn.completed in the backlog doesn't end the tail; with no turn
    // running it stops after the backlog.
    let running: string | undefined;
    let backlogDone = false;
    const check = (e: any, live: boolean) => {
      if (e.type === 'turn.started') running = e.turnId;
      if (e.type !== 'turn.completed') return;
      if (e.turnId === running) running = undefined;
      const end = opts.untilTurn ? e.turnId === opts.untilTurn : opts.untilDone && (live || backlogDone) && !running;
      if (end) done(e.outcome === 'failed' ? 1 : 0);
    };
    const held: any[] = [];
    client.onNotification((method, params) => {
      if (method !== 'thread.event' || params.threadId !== threadId) return;
      // Live events can land before the subscribe reply; keep them in order.
      if (!backlogDone) return void held.push(params.event);
      printEvent(params.event, opts.json);
      check(params.event, true);
    });
    client
      .call<{ events: PersistedEvent[] }>('threads.subscribe', { threadId, afterSeq: opts.from ?? 0 })
      .then(async (r) => {
        for (const e of r.events) {
          printEvent(e, opts.json);
          check(e, false);
        }
        const last = r.events.at(-1)?.seq ?? opts.from ?? 0;
        backlogDone = true;
        for (const e of held) {
          // Already in the backlog (a delta older than the backlog's last
          // event belongs to an item the backlog already holds).
          if (e.type.endsWith('.delta') ? e.seq < last : e.seq <= last) continue;
          printEvent(e, opts.json);
          check(e, true);
        }
        held.length = 0;
        if (opts.untilDone && !opts.untilTurn && !running) {
          // Nothing running: is the thread busy at all?
          const t = (await client.call<{ threads: ThreadSummary[] }>('threads.list', { include: ['inbox', 'snoozed', 'archived'] })).threads.find((x) => x.id === threadId);
          if (!t || !['starting', 'running', 'waiting'].includes(t.status)) done(0);
        }
      })
      .catch((e: Error) => {
        console.error(e.message);
        done(1);
      });
  });
}

// Exit only once stdout has drained: into a pipe Node writes it
// asynchronously, and exiting straight away cut `tb list --json | ...`
// off partway (at 64 or 128 KB).
main(process.argv.slice(2)).then((code) => process.stdout.write('', () => process.exit(code)));

// ------------------------------------------------------------- projects

// A project by id, prefix or title, as the runner's own lookup would.
async function projectId(client: RunnerClient, q: string): Promise<string> {
  const r = await client.call<{ projects: Project[] }>('projects.list', { archived: true });
  const hit =
    r.projects.find((p) => p.id === q) ??
    one(r.projects.filter((p) => p.id.startsWith(q))) ??
    one(r.projects.filter((p) => p.title.toLowerCase() === q.toLowerCase()));
  if (!hit) throw new Error(`No project ${q}. tb projects lists them.`);
  return hit.id;
}

function one<T>(xs: T[]): T | undefined {
  return xs.length === 1 ? xs[0] : undefined;
}

function projectLine(p: Project): string {
  const bits = [`${p.id}  ${p.title}${p.archived ? ' (archived)' : ''}`, `${p.threadCount} thread${p.threadCount === 1 ? '' : 's'}`];
  if (p.folders.length) bits.push(p.folders.map(tildePath).join(', '));
  bits.push(`by ${p.createdBy}`);
  return bits.join(' · ');
}

function printProject(p: Project, threadIds: string[]): void {
  console.log(projectLine(p));
  console.log(`Goals: ${p.goals || '(none)'}`);
  console.log(`State: ${p.state || '(none)'}${p.stateUpdatedAt ? ` (${p.stateUpdatedAt})` : ''}`);
  if (p.notes) console.log(`\n${p.notes}`);
  if (threadIds.length) console.log(`\nThreads: ${threadIds.map((t) => t.slice(0, 8)).join(' ')}`);
}

function printLibrarian(l: LibrarianStatus): void {
  const state = l.current ? `working on "${l.current.threadTitle}" (${l.current.why})` : l.state + (l.reason ? `: ${l.reason}` : '');
  console.log(`Librarian: ${state}. ${l.looksToday} look${l.looksToday === 1 ? '' : 's'} today, ${l.skippedToday ?? 0} skipped, ${l.tokensToday ?? 0} tokens ($${(l.notionalTodayUsd ?? 0).toFixed(4)} at API prices, on the pool's room).`);
  if (l.queue.length) {
    console.log('\nNext:');
    for (const j of l.queue.slice(0, 20)) console.log(`  ${j.dueAt}  ${j.threadId.slice(0, 8)} "${j.threadTitle}"  ${j.why}`);
    if (l.queue.length > 20) console.log(`  … and ${l.queue.length - 20} more`);
  }
  if (l.recent.length) {
    console.log('\nDone:');
    for (const e of l.recent.slice(0, 15)) console.log(`  ${e.at}  ${e.threadId.slice(0, 8)} "${e.threadTitle}"  ${e.outcome}: ${e.text}`);
  }
}

function tildePath(p: string): string {
  const home = process.env.HOME ?? '';
  return home && p.startsWith(home + '/') ? '~' + p.slice(home.length) : p;
}
