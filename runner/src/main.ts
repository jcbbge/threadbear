// Runner entry point: `node src/main.ts`. launchd runs this (see
// scripts/install-runner.sh); tests run it with THREADBEAR_HOME and
// THREADBEAR_PORT pointing at temp places.
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig, ensureHome, readToken, paths, recordListening, defaultHome, DEFAULT_CWD, RUNNER_VERSION } from './config.ts';
import { startHousekeeping } from './housekeeping.ts';
import { RELEASE, markGoodLater, onSupervisorGone, ownCheckout, readRelease, readState, requestHandover, supervised, takeRollbackNotice, tellLaunchListening } from './release.ts';
import { PatchTrust } from './patch-trust.ts';
import type { RunnerUpdates } from './runner.ts';
import { Peers, PrimaryLink, ThreadRouter, drainChildrenName, peersElsewhere, phoneCommands, primaryElsewhere, projectRouter, removeDrainInfo, scheduleRouter, writeDrainInfo, type CrossRunnerHooks, type Elsewhere } from './handover.ts';
import { RunnerUpdater, releaseTreeAt } from './update.ts';
import { RELEASE_NOTES_SYSTEM, SETTLE_MS, Upstream } from './upstream.ts';
import { BringIn } from './bring-in.ts';
import { UpdateFixer } from './fix-update.ts';
import { bringInSetting } from './settings.ts';
import { Restarter, restartMethods } from './restart.ts';
import { AppRestarts } from './app-restarts.ts';
import { Scheduler, scheduleMethods } from './schedules.ts';
import { StuckJobs } from './stuck-jobs.ts';
import { FrozenClis } from './frozen-cli.ts';
import { KeepAwake } from './keep-awake.ts';
import { experimentOn } from './experiments.ts';
import { MacScreen } from './mac-screen.ts';
import { Projects, drainProjectMethods, projectMethods } from './projects.ts';
import { Librarian, librarianMethods } from './librarian.ts';
import { ConnectorsMonitor, connectorsMethods } from './connectors.ts';
import { TaskBoards, gatewayCaller, helperHeaders } from './notion-tasks.ts';
import { createLogger } from './log.ts';
import { hidIdleMs, isAtMac } from './presence.ts';
import { ThreadStore } from './store.ts';
import { AccountRegistry } from './accounts.ts';
import { ClaudeAdapter } from './adapters/claude/adapter.ts';
import { ProcessRegistry } from './proc.ts';
import { Runner } from './runner.ts';
import { CodexAdapter } from './adapters/codex/adapter.ts';
import { resolveCodexBinary } from './adapters/codex/appserver.ts';
import { checkSurface, testedVersion } from './adapters/codex/surface.ts';
import { CliUpdates } from './updates/manager.ts';
import { UsageStore } from './usage.ts';
import { UsageHistory } from './usage-history.ts';
import { TokenTally } from './token-tally.ts';
import { usageStatsMethods } from './usage-stats.ts';
import { Relay } from './relay.ts';
import { RpcServer } from './rpc.ts';
import { realClock } from './clock.ts';
import { acquireLock } from './lock.ts';
import { removeTempFiles } from './fsutil.ts';
import { Models } from './models/index.ts';
import { SettingsService, modelMethods, settingsMethods } from './settings.ts';
import { InstructionsStore, instructionsMethods } from './instructions.ts';
import { ConvexSync, defaultRunnerName, ensureRunnerId, readSyncKey } from './sync.ts';
import { pushFailingText } from './push-failing.ts';
import { Scrubber } from './scrub.ts';
import { useScrubForCuts } from './safe-cut.ts';
import { redactSecrets } from './redaction.ts';
import { SecretCheck } from './secret-check.ts';
import { SharedPools } from './shared-pools.ts';
import { sandboxFor } from './sandbox.ts';
import { readPools } from './pools.ts';
import { machineSampler } from './runner-stats.ts';
import { detectMachineIcon } from './machine.ts';
import { filesMethods } from './files.ts';
import { devicesMethods } from './devices.ts';
import { flushSentry, reportException, reportLoggedError, reportLoggedWarning, startSentry } from './sentry.ts';
import { ALWAYS_ASK_TOOLS, NEVER_ASK_TOOLS, RICH_BLOCKS_LINE, SERVER_NAME, buildThreadbearTools, threadbearMcpServer, type RemoteControl } from './threadbear-mcp.ts';
import { CrossRunner } from './cross-runner.ts';
import { EFFORT_LEVELS, ErrorCode, RpcError, isPermissionMode, type EffortLevel, type PermissionMode } from './protocol.ts';

// Tells launch.mjs this runner calls its listening() hook (release.ts), so
// it may stop one that hasn't started listening in time.
export const REPORTS_LISTENING = true;

async function main(): Promise<void> {
  const cfg = loadConfig();
  ensureHome(cfg.home);
  const log = createLogger(cfg.logFile, { echo: process.env.THREADBEAR_LOG_STDERR === '1', debug: process.env.THREADBEAR_DEBUG === '1', onError: reportLoggedError, onWarn: reportLoggedWarning });
  // Only the installed runner reports to Sentry (sentry.ts says why).
  const reporting = await startSentry(cfg.home);
  log.info('runner starting', { version: RUNNER_VERSION, home: cfg.home, port: cfg.port, pid: process.pid, sentry: reporting });

  // The SDK warns when canUseTool is set in bypass mode; it's deliberate
  // (AskUserQuestion still goes through it), so keep it out of the log.
  process.removeAllListeners('warning');
  process.on('warning', (w) => {
    if ((w as { code?: string }).code !== 'CLAUDE_SDK_CAN_USE_TOOL_SHADOWED') log.warn('node warning', { message: w.message });
  });

  // Before anything else touches the data dir: only one runner may own it.
  const lock = acquireLock(paths.run(cfg.home));
  if ('heldBy' in lock) {
    log.error('another runner is already using this data dir', { pid: lock.heldBy, home: cfg.home });
    process.stderr.write(`Another runner (pid ${lock.heldBy}) is already using ${cfg.home}; not starting.\n`);
    process.exit(1);
  }
  process.on('exit', () => lock.release());

  if (!fs.existsSync(cfg.claudePath)) log.warn('claude CLI not found', { path: cfg.claudePath });
  // A sync or gateway URL that would send keys in the clear (secure-url.ts):
  // left unused, and said here as well as in tb status and the Connectors panel.
  if (cfg.sync.urlRefused) log.warn('sync URL refused, so sync is off', { reason: cfg.sync.urlRefused });
  if (cfg.connectorsRefused) log.warn('Connectors gateway URL refused, so it is off', { reason: cfg.connectorsRefused });

  // Temp files from atomic writes a crash interrupted.
  removeTempFiles(cfg.home, paths.run(cfg.home), paths.threads(cfg.home));

  const registry = new ProcessRegistry(paths.run(cfg.home), log);
  // Waits until the old CLIs are gone, so a resume never runs beside them.
  const swept = await registry.sweepOrphans();
  if (swept) log.warn('stopped process groups left from a previous run', { count: swept });

  const store = new ThreadStore(cfg.home);
  const token = readToken(cfg.home);
  // Token Stats' limits.json as a baseline, plus what the threads' own
  // turns report; the registry puts it on every account.
  // What each login shows over time, and its tokens by the hour, for the
  // Usage panel's charts (docs/protocol.md, "Usage history").
  const usageHistory = new UsageHistory({ dataDir: cfg.home, clock: realClock, log });
  const usage = new UsageStore({ limitsFile: cfg.tokenStatsLimitsFile, dataDir: cfg.home, clock: realClock, log, history: usageHistory });
  usage.start();
  const accounts = new AccountRegistry(cfg, usage);
  const tally = new TokenTally({ dataDir: cfg.home, clock: realClock, log, accounts: () => accounts.list() });
  if (cfg.tokenTally !== false) tally.start();
  // Every session gets tools for driving Threadbear itself, bound to its
  // own thread. Sessions only start after the runner exists.
  let runner!: Runner;
  let scheduler!: Scheduler;
  // Threads waiting to hear the Mac app has restarted onto a new build
  // (app-restarts.ts); made once the runner is.
  let appRestarts!: AppRestarts;
  // Asked for per thread, as sync is made after the runner. No tool while sync is off: the Pocket lives in the backend.
  const pocketControl = () => (sync.status().state === 'off' ? undefined : sync);
  let restarter!: Restarter;
  // Where the agent tools reach threads this runner doesn't have: draining
  // runners' (Peers) while this is the primary, the primary's once this one
  // is draining (docs/protocol.md, "Handovers").
  let elsewhere: Elsewhere | undefined;
  let primaryLink: PrimaryLink | undefined;
  const router = (): ThreadRouter => (routerCache ??= new ThreadRouter(runner, () => elsewhere, () => crossHooks));
  // Other runners (cross-runner.ts), set once the relay is made.
  let crossHooks: CrossRunnerHooks | undefined;
  let routerCache: ThreadRouter | undefined;
  let updaterReady = false;
  // Set once this runner has handed over and is finishing its kept turns.
  let draining = false;
  const scheduleControl = () => scheduleRouter(scheduler, () => primaryLink);
  // Projects belong to the primary: a draining runner's agent tools change
  // them there rather than write projects.json beside it, and a kept thread
  // joins or leaves one here (docs/protocol.md, "Handovers").
  const projectControl = () => projectRouter(projects, () => primaryLink, { draining: () => draining, holds: (threadId) => runner.has(threadId) });
  // Keeps both CLIs current (E). Its hooks call back into the runner and
  // the Restarter, made below; nothing calls them before start().
  const updates = new CliUpdates({
    cfg,
    log,
    clock: realClock,
    hooks: {
      restartPending: () => Boolean(restarter?.status().pendingRestart),
      releaseIdle: (p, v) => runner.releaseIdle(p, v),
      versionsInUse: (p) => runner.versionsInUse(p),
      codexBinariesInUse: () => runner.codexBinariesInUse(),
    },
    codex: { resolve: (start) => resolveCodexBinary(start), checkSurface, testedVersion },
    notice: (level, message) => runner.notice(level, message),
  });
  // The gateway's own word on which services are signed out, asked fresh
  // when a turn's gateway call failed: a sign-in ask comes only from that,
  // never from what a tool result says (connectors.ts, signInSignal).
  // `connectors` is the monitor made below; this only runs during a turn.
  // Other runners' threads for the agent tools (threadbear-mcp.ts
  // RemoteControl), through the relay made further down, as the Mac app
  // reaches them. With nothing heard yet (no app connected since the
  // runner started) the list starts the watch and waits up to 3 seconds
  // for the backend's first answer; after that it never waits.
  // Once a wait has run out (the backend not answering), the next minute's
  // calls use what's there rather than each waiting again.
  let remoteWaitSpentAt = 0;
  const remoteControl = (): RemoteControl | undefined => {
    const relay = relayRef;
    // A draining runner has stopped its sync, so its list would go stale:
    // its last turns see this runner's and the primary's threads only.
    if (!relay || draining || !sync.relaySource()) return undefined;
    return {
      list: async () => {
        let r = sync.remoteThreads();
        if (!sync.remoteHeard() && Date.now() - remoteWaitSpentAt > 60_000) {
          for (let waited = 0; !sync.remoteHeard() && waited < 3000; waited += 200) {
            await new Promise((res) => setTimeout(res, 200));
          }
          if (!sync.remoteHeard()) remoteWaitSpentAt = Date.now();
          r = sync.remoteNow();
        }
        return relay.overlay(r);
      },
      call: (threadId, method, params) => relay.call(threadId, method, { threadId, ...params }),
    };
  };
  const gatewayHealth = async () => {
    const s = await connectors.refresh(true);
    return s.state === 'ok' ? s.services : undefined;
  };
  const claude = new ClaudeAdapter({
    claudePath: cfg.claudePath,
    registry,
    log,
    mcpServersFor: (threadId) => ({ [SERVER_NAME]: threadbearMcpServer(router(), threadId, scheduleControl(), projectControl(), appRestarts, () => cfg.bulletReplies, pocketControl, () => cfg.oneReply, () => cfg.connectorsUrl, gatewayHealth, () => experimentOn(cfg.home, 'scheduleChecks'), remoteControl, () => experimentOn(cfg.home, 'richBlocks'), () => experimentOn(cfg.home, 'replyButtons')) }),
    oneReply: () => cfg.oneReply,
    sandboxFor: (cwd) => sandboxFor(cfg.sandbox, cwd),
    alwaysAsk: ALWAYS_ASK_TOOLS,
    neverAsk: NEVER_ASK_TOOLS,
  });
  // One app-server per live Codex thread, each starting what E says is
  // current, with the same threadbear tools as dynamic tools.
  const codex = new CodexAdapter({
    codexBinary: () => updates.codexBinary(),
    codexArgs: cfg.codexArgs,
    registry,
    log,
    toolsFor: (threadId) => buildThreadbearTools(router(), threadId, Date.now, scheduleControl(), projectControl(), appRestarts, { provider: 'codex', bulletReplies: () => cfg.bulletReplies, oneReply: () => cfg.oneReply, pocket: pocketControl, gateway: () => cfg.connectorsUrl, gatewayHealth, scheduleChecks: () => experimentOn(cfg.home, 'scheduleChecks'), remote: remoteControl, replyButtons: () => experimentOn(cfg.home, 'replyButtons') }),
    onNotice: (text) => runner.notice('warning', text),
    extraGuidance: () => (experimentOn(cfg.home, 'richBlocks') ? RICH_BLOCKS_LINE : ''),
  });
  // The runner's own small-model calls, on the settings' Claude pool.
  const models = new Models({
    home: cfg.home,
    clock: realClock,
    log,
    settings: () => cfg.models,
    claudePath: cfg.claudePath,
    registry,
    poolHost: { pool: (id) => runner.smallModelPool(id), ranDry: (id) => runner.noteRanDry(id) },
  });
  const projects = new Projects({ home: cfg.home, clock: realClock, log });
  // Presence as the Convex mirror last checked it, for the line a phone
  // message gets (Runner.forAgent). Only phone messages read it, and they
  // only come through that mirror.
  let atMac: boolean | undefined;
  const instructions = new InstructionsStore({ home: cfg.home, token, publish: (n) => runner.publish(n) });
  runner = new Runner({
    standingInstructions: () => instructions.given(),
    projects,
    atMac: () => atMac,
    config: cfg,
    store,
    adapters: { claude, codex },
    accounts,
    // A draining runner's readings go to the primary, which owns
    // usage.json (docs/protocol.md, "Handovers").
    usage: {
      record: (accountId, reading) => (draining ? runner.publish({ method: 'drain.usage', params: { accountId, reading } }) : usage.record(accountId, reading)),
      onChange: (fn) => usage.onChange(fn),
    },
    clock: realClock,
    log,
    models,
    patchTrust: new PatchTrust({ file: path.join(cfg.home, 'patch-trust.json'), always: [ownCheckout()] }),
    // Keeps any text end_turn's own sign-up or wait_for_app_restart gave.
    appRestartAsked: (threadId) => {
      if (!appRestarts.isWatching(threadId)) appRestarts.watch(threadId);
    },
  });
  // Until it is listening (below): see Runner.holdWaits.
  runner.holdWaits = true;
  const settings = new SettingsService({ config: cfg, publish: (n) => runner.publish(n), poolIds: () => runner.listPools().pools.map((p) => p.id) });
  // Runners still finishing turns after a handover: connected before the
  // threads load, so the ones they have are left to them. Nothing after the
  // await below yields until runner.start(), so no thread can arrive first.
  const peers = new Peers({
    home: cfg.home,
    token,
    log,
    runner: {
      adopt: (threadId, o) => {
        // Only the primary takes threads in. A draining runner has closed
        // its peers, but one already on its way in mustn't land here.
        if (draining) return undefined;
        const t = runner.adopt(threadId, o);
        restarter?.resumeAdopted(threadId);
        // Cut off mid-turn if the old runner crashed with it: carried on.
        if (o?.crashed) runner.carryOnStopped(threadId);
        // A review the old runner couldn't start (runner/lab-review.ts),
        // after the resume, which it would otherwise turn away.
        runner.startOwedReviews(threadId);
        // It may have finished on the old runner while a thread waiting on
        // it had already come across. After its own carry-ons, which are
        // new work, so a finish they replace doesn't count.
        runner.reconcileWaits();
        // Told now if the app restarted while it was over there.
        if (t) appRestarts?.adopted(threadId);
        return t;
      },
      // A thread here may be waiting on one deleted over there.
      waitedOnDeleted: (threadId) => runner.waitedOnDeleted(threadId),
      publish: (n) => runner.publish(n),
    },
    usage: (accountId, reading) => usage.record(accountId, reading),
    onChange: () => publishUpdates(),
    sweep: async (pid) => {
      const theirs = new ProcessRegistry(paths.run(cfg.home), log, drainChildrenName(pid));
      const n = await theirs.sweepOrphans();
      theirs.removeFile();
      if (n) log.warn('stopped process groups a draining runner left', { pid, count: n });
    },
  });
  const kept = await peers.connectAll();
  elsewhere = peersElsewhere(peers);
  runner.start({ skip: kept });
  // Answers to ask_secret go after a day (docs/protocol.md, "Secrets").
  runner.secrets.startSweeping((e) => log.warn('secret sweep failed', { error: String(e) }));
  // After the threads are loaded, so a schedule that came due while the
  // runner was stopped finds its thread.
  appRestarts = new AppRestarts({ runner, home: cfg.home, clock: realClock, log, away: (threadId) => peers.owns(threadId) });
  // Its runner id and name are the mirror's (sync.ts), since that's how other
  // runners and the backend know this one (step 6, docs/step6-plan.md).
  const syncRunnerId = cfg.sync.runnerId ?? ensureRunnerId(cfg.home);
  // When this process started: the heartbeat sends it, and runners.list
  // gives it for this runner too (the app's Runners panel says "up 3h").
  const startedAt = new Date().toISOString();
  // The kind of Mac this is, for its icon in lists (machine.ts).
  const runnerIcon = cfg.sync.icon ?? (await detectMachineIcon());
  scheduler = new Scheduler({
    runner,
    home: cfg.home,
    clock: realClock,
    log,
    elsewhere: (id) => peers.owns(id),
    self: { id: syncRunnerId, name: cfg.sync.name ?? defaultRunnerName(), icon: runnerIcon, version: RUNNER_VERSION, release: RELEASE.release, startedAt },
    syncOn: Boolean(cfg.sync.enabled && cfg.sync.url && readSyncKey(cfg.home)),
  });
  scheduler.start();
  // The done card's loose ends list the check-ins booked for a thread.
  runner.schedulesFor = (id) => scheduler.list(id);
  // Projects need the threads loaded (their counts, and the thread side of
  // membership); the librarian needs both.
  projects.start(runner);
  const librarian = new Librarian({ host: runner, projects, models, clock: realClock, log, home: cfg.home, pocket: pocketControl });
  librarian.start();
  // Background jobs that look stuck get their thread a message.
  const stuckJobs = new StuckJobs({ host: runner, clock: realClock, log, home: cfg.home });
  stuckJobs.start();
  // A CLI frozen on something only a person can answer says so in its thread.
  const frozenClis = new FrozenClis({ host: runner, clock: realClock, log, machine: cfg.sync.name ?? defaultRunnerName() });
  frozenClis.start();
  // Keeps the Mac out of idle sleep while threads work (experiment
  // keepAwake, read each sweep so runner.json's switch needs no restart).
  const keepAwake = new KeepAwake({ busy: () => runner.workingThreads(), on: () => experimentOn(cfg.home, 'keepAwake'), clock: realClock, log });
  keepAwake.start();
  // A dialog waiting on this Mac's screen says so, from the installed runner
  // only: a dev runner's Mac is the one you're sat at, and a throwaway data
  // dir shouldn't get a thread about it. THREADBEAR_MAC_SCREEN=on to try it
  // on a dev runner, off to stop it.
  const macScreenSetting = process.env.THREADBEAR_MAC_SCREEN;
  const macScreen = process.platform === 'darwin' && macScreenSetting !== 'off' && (macScreenSetting === 'on' || readRelease())
    ? new MacScreen({ host: runner, clock: realClock, log, machine: cfg.sync.name ?? defaultRunnerName(), stateFile: path.join(cfg.home, 'mac-screen.json') })
    : undefined;
  macScreen?.start();
  // The Connectors gateway's /health, for the app's Connectors panel
  // (docs/protocol.md, "Connectors"). Off when there's no gateway.
  const connectors = new ConnectorsMonitor({
    url: cfg.connectorsUrl,
    ...(cfg.connectorsRefused ? { offReason: cfg.connectorsRefused } : {}),
    log,
    onChange: (s) => runner.publish({ method: 'connectors.updated', params: { connectors: s } }),
  });
  connectors.start();
  // Projects' task boards in Notion, read through the same gateway
  // (notion-tasks.ts). With no gateway, a project with a Notion page
  // shows why its board is empty.
  projects.useTaskBoards(
    new TaskBoards({
      home: cfg.home,
      ...(cfg.connectorsClient ? { call: gatewayCaller({ mcpUrl: cfg.connectorsClient.mcpUrl, headers: helperHeaders(cfg.connectorsClient.headersHelper) }) } : {}),
      log,
      onChange: () => projects.boardChanged(),
    }),
  );
  // The Convex mirror the phone reads (docs/convex-backend.md). Best
  // effort: off without a URL and key, and never in the way of a turn.
  // The RPC server is made further down; presence asks it once it's there.
  let rpcServer: RpcServer | undefined;
  // Pools shared with the other runners through the backend, once it has
  // them (docs/protocol.md, "Pools"); the last list seen is kept on disk.
  const sharedPools = new SharedPools({
    cachePath: `${cfg.home}/shared-pools.json`,
    runnerId: syncRunnerId,
    accounts: () => runner.safeAccounts(),
    // runner.json's own pools, shaped as the runner reads them.
    localPools: () => (Array.isArray(runner.cfg.pools) && runner.cfg.pools.length ? readPools({ pools: runner.cfg.pools }, runner.safeAccounts()) : undefined),
    onChange: () => runner.poolsMaybeChanged(),
    log,
  });
  const syncKey = readSyncKey(cfg.home);
  if (cfg.sync.enabled && cfg.sync.url && syncKey) {
    sharedPools.loadCache();
    runner.sharedPools = sharedPools;
  }
  const scrubber = new Scrubber({ secretsDir: paths.secrets(cfg.home), log });
  // Text cut short anywhere in the runner is cut where none of these values
  // (nor anything the rules know) is split in two (safe-cut.ts). Not counted
  // in the scrubber's status: nothing is taken out here.
  useScrubForCuts((text) => redactSecrets(scrubber.known.mask(text)).text);
  runner.secrets.onWritten = (value) => scrubber.known.add(value);
  // Set once the relay is made, further down; sync's list goes through it.
  let relayRef: Relay | undefined;
  const sync = new ConvexSync({
    config: { ...cfg.sync, runnerId: syncRunnerId, icon: runnerIcon },
    key: syncKey,
    statePath: `${cfg.home}/sync-state.json`,
    cachePath: `${cfg.home}/sync-sent.json`,
    presence: async () => (atMac = isAtMac(rpcServer?.appConnected() ?? false, await hidIdleMs())),
    appConnected: () => rpcServer?.appConnected() ?? false,
    runner: {
      onNotification: (fn) => runner.onNotification(fn),
      list: (include) => runner.list(include),
      get: (id) => runner.get(id),
      events: (id, o) => runner.events(id, o),
      cuts: (id) => runner.cuts(id),
      listProjects: () => projects.list({ archived: true }),
      listSchedules: () => scheduler.list(),
      listAccounts: () => runner.hello().accounts,
      buttons: (id) => runner.listButtons(id).buttons,
    },
    // The phone's commands, through the same methods the app's RPCs use,
    // on whichever runner has the thread.
    commands: {
      ...phoneCommands(runner, peers),
      // A schedule's own runner gets its command, so the scheduler here is its.
      schedule: ({ scheduleId, action }) => (action === 'run' ? scheduler.runNow(scheduleId) : scheduler.update({ scheduleId, paused: action === 'pause' })),
    },
    sample: machineSampler(cfg.home),
    secretBox: runner.secrets,
    schedules: scheduler,
    pools: sharedPools,
    sharedUsage: usage,
    // The sidebar's list carries what the relay has changed that the
    // backend's rows don't show yet (relay.ts overlay); made below.
    publish: (n) => runner.publish(n.method === 'remoteThreads.updated' && relayRef ? { ...n, params: relayRef.overlay(n.params) } : n),
    home: cfg.home,
    // A key the backend turns down (sync.ts KEY_REJECTED): said in the app,
    // and once tb runner add has written a new one, a restart onto it.
    notice: (level, message) => runner.notice(level, message),
    readKey: () => readSyncKey(cfg.home),
    restart: (reason) => void restarter.request({ when: 'idle', reason }),
    scrubber,
    elsewhere: (id) => peers.owns(id) || peers.isArriving(id),
    elsewhereIds: () => [...peers.summaries(['inbox', 'snoozed', 'archived']).map((t) => t.id), ...peers.arrivingIds()],
    version: RUNNER_VERSION,
    release: RELEASE.release,
    startedAt,
    clock: realClock,
    log,
  });
  sync.start();
  // Counts only, and off unless runner.json asks (src/secret-check.ts).
  const secretCheck = new SecretCheck({ home: cfg.home, enabled: cfg.secretCheck === true, log });
  if (secretCheck.on) {
    secretCheck.start();
    runner.onNotification((n) => {
      if (n.method === 'thread.event') secretCheck.see(n.params.threadId, n.params.event as Parameters<SecretCheck['see']>[1]);
    });
  }
  if (swept) runner.startupNotice('info', `Stopped ${swept === 1 ? 'a process group' : `${swept} process groups`} left running by the previous runner.`);

  // launch.mjs went back to this release because a newer one kept crashing
  // at startup. Every client that says hello hears about it, not just the
  // first few minutes' worth.
  const rollback = takeRollbackNotice(cfg.home, log);
  const rolledBack = rollback?.message;
  // runner.restart: when it's time, stop the same way SIGTERM does and
  // exit 0 so launchd starts the runner again.
  restarter = new Restarter({
    runner,
    home: cfg.home,
    clock: realClock,
    log,
    release: RELEASE.release,
    branch: RELEASE.branch,
    logFile: cfg.logFile,
    rolledBack,
    rolledBackFrom: rollback?.from,
    restart: () => void stop('restart'),
    updateStatus: () => updater.status(),
    canHandOver: () => supervised() && !draining,
    handOver: (keeps) => void handOver(keeps),
    elsewhere: (id) => peers.owns(id),
  });
  const openThread = (threadId: string): boolean => {
    try {
      return !runner.get(threadId).archivedAt;
    } catch {
      return false;
    }
  };
  // A thread in the background when an update to main fails, in place of
  // a banner (fix-update.ts).
  const updateRelease = readRelease();
  const updateFixer = new UpdateFixer({
    home: cfg.home,
    log,
    start: ({ text, title, why }) => runner.create({
      text,
      title,
      cwd: updateRelease?.checkout,
      // It fixes, lands and watches the build without anyone to approve.
      permissionMode: 'full',
      startedBy: { kind: 'runner', label: 'Threadbear', why },
    }).thread.id,
    open: openThread,
    send: (threadId, text) => void runner.send(threadId, text, [], { queue: true }),
  });
  // Follows main once this release has been marked good (below).
  const updater = new RunnerUpdater({
    home: cfg.home,
    release: updateRelease,
    enabled: cfg.followMain,
    clock: realClock,
    log,
    notice: (level, message) => runner.notice(level, message),
    // Only with a checkout to work in (a release that records one).
    onFailed: (f) => Boolean(updateRelease?.checkout) && (updateFixer.failed(f), true),
    restart: (p) => restarter.request({ when: 'idle', ...p }),
    pendingRestart: () => Boolean(restarter.status().pendingRestart),
    onChange: () => publishUpdates(),
  });
  // Mike's releases for a fork, and on Mike's own runner the tagging of
  // them (upstream.ts). Starts with the updater, once this release is good.
  const thisRelease = readRelease();
  const bootedAt = Date.now();
  // A thread every few days to bring Mike's releases in (bring-in.ts).
  const bringIn = new BringIn({
    home: cfg.home,
    clock: realClock,
    log,
    setting: () => bringInSetting(cfg.home),
    start: ({ text, title, why }) => runner.create({
      text,
      title,
      cwd: thisRelease?.checkout,
      // As Bring Them In does: it merges and runs the checks in its worktree.
      permissionMode: 'full',
      startedBy: { kind: 'runner', label: 'Threadbear', why },
    }).thread.id,
    open: openThread,
    send: (threadId, text) => void runner.send(threadId, text, [], { queue: true }),
    // The app's Bring Them In and Let's Discuss titles (UpdatesPanel).
    openByHand: () => runner.list(['inbox', 'snoozed']).find((t) => /^(Bring in|Discuss) Mike's release /.test(t.title))?.id,
  });
  const upstream = new Upstream({
    home: cfg.home,
    checkout: thisRelease?.checkout,
    clock: realClock,
    log,
    publish: cfg.releases,
    // Main's tip is what this runner runs (its runner/ at least), and this
    // release has been marked good and up for a while.
    runningMainSettled: () => {
      if (!thisRelease?.checkout || !thisRelease.tree || thisRelease.dirty) return false;
      if (Date.now() - bootedAt < SETTLE_MS) return false;
      if (readState(cfg.home)?.lastGood !== thisRelease.id) return false;
      return releaseTreeAt(thisRelease.checkout, thisRelease.prefix ?? 'runner/', 'refs/heads/main') === thisRelease.tree;
    },
    onChange: () => publishUpdates(),
    onChecked: (status) => void bringIn.consider(status),
    // Only asked on Mike's runner, once a day as it tags a release.
    writeNotes: async (commits) => {
      const res = await models.generate({ feature: 'release-notes', cwd: thisRelease?.checkout, system: RELEASE_NOTES_SYSTEM, prompt: commits, maxTokens: 800, strong: true });
      return res.ok ? res.value : undefined;
    },
  });
  // runner.updates: sent when what hello's `updates` says changes.
  let lastUpdates = '';
  const runnerUpdates = (): RunnerUpdates => {
    const u = updater.status();
    const out: RunnerUpdates = { state: u.state, oldRunners: peers.status().map((d) => ({ version: d.version, threads: d.threads })) };
    if (u.commit) out.commit = u.commit.slice(0, 7);
    if (u.subject) out.subject = u.subject;
    if (u.reason) out.reason = u.reason;
    if (u.launcherChanged) out.launcherChanged = true;
    if (u.launcherReason) out.launcherReason = u.launcherReason;
    const up = upstream.status();
    if (up.state !== 'off' || up.published) out.upstream = up;
    return out;
  };
  function publishUpdates(): void {
    // Peers can call this before the updater exists (at startup).
    if (!updaterReady || draining) return;
    const updates = runnerUpdates();
    const key = JSON.stringify(updates);
    if (key === lastUpdates) return;
    lastUpdates = key;
    runner.publish({ method: 'runner.updates', params: { updates } });
  }
  updaterReady = true;

  runner.attachClis(updates);
  const methods = { ...restartMethods(restarter), ...scheduleMethods(scheduler), ...projectMethods(projects), ...drainProjectMethods(projects), ...librarianMethods(librarian), ...connectorsMethods(connectors), ...settingsMethods(settings), ...instructionsMethods(instructions), ...modelMethods(models), ...devicesMethods(sync), ...usageStatsMethods({ tally, history: usageHistory, clock: realClock }) };
  // runner.status carries the CLI statuses too (protocol, "runner.status").
  const restartStatus = methods['runner.status'];
  methods['runner.status'] = (p) => {
    const draining = peers.status();
    return { ...(restartStatus(p) as Record<string, unknown>), clis: updates.list(), sync: sync.status(), secretCheck: secretCheck.status(), relay: relay.status(), upstream: upstream.status(), ...(draining.length ? { draining } : {}), ...(macScreen ? { macScreen: macScreen.status() } : {}) };
  };
  // tb updates (docs/protocol.md, "Mike's releases").
  methods['upstream.status'] = () => ({ upstream: upstream.status() });
  // Other runners' threads, for the Mac app's sidebar (step 6 part 2).
  methods['remoteThreads.list'] = () => relayRef?.overlay(sync.remoteThreads()) ?? sync.remoteThreads();
  // Every runner's machine figures, for the Mac app's Runners panel.
  methods['runners.stats'] = async () => ({ stats: await sync.runnerStats() });
  // Mike's runner order (docs/protocol.md, "Other runners' threads"): every
  // runner's id, this one's too. The answer comes back as remoteThreads.updated.
  methods['runners.setOrder'] = async (p) => {
    const ids = (p as { runnerIds?: unknown } | undefined)?.runnerIds;
    if (!Array.isArray(ids) || !ids.every((x) => typeof x === 'string')) throw new RpcError(ErrorCode.badParams, 'runnerIds must be a list of runner ids');
    await sync.setRunnerOrder(ids);
    return {};
  };
  // A file here, for a Mac app showing one of this runner's threads from
  // another Mac (files.ts).
  Object.assign(methods, filesMethods());
  methods['upstream.check'] = async () => ({ upstream: await upstream.check() });
  const codexWarning = missingCodex(updates.codexBinary(), cfg);
  if (codexWarning) log.warn('codex CLI not found', { path: updates.codexBinary() });
  // Other runners' threads through the backend, for the Mac app (relay.ts).
  const relay = (relayRef = new Relay({
    source: () => sync.relaySource(),
    remote: () => sync.remoteNow(),
    subscribed: (threadId) => rpcServer?.isSubscribed(threadId) ?? false,
    publish: (n) => rpcServer?.notifyClients(n),
    clock: realClock,
    log,
  }));
  // Starting threads on other runners, and a runner key's requests for
  // that (docs/protocol.md, "Asking another runner").
  // A request's mode as the card showed it: none is the default (full
  // access, as the card says), and one this runner doesn't know is refused
  // rather than dropped to that default (Daybreak, 7 Nov 2026).
  const permission = (m: string | undefined): PermissionMode | undefined => {
    if (m === undefined || m === '') return undefined;
    if (!isPermissionMode(m)) throw new RpcError(ErrorCode.badParams, `Unknown permission mode ${JSON.stringify(m)}, so the thread wasn't started.`);
    return m;
  };
  const cross = new CrossRunner({
    self: () => ({ id: syncRunnerId, name: cfg.sync.name ?? defaultRunnerName() }),
    backend: () => sync,
    runners: async () => (await scheduler.runners()).map((r) => ({ id: r.id, name: r.name, self: r.self, online: r.online })),
    createHere: async (p) => {
      const mode = permission(p.permissionMode);
      const r = await router().create({ text: p.text, ...(p.title ? { title: p.title } : {}), ...(p.cwd ? { cwd: p.cwd } : {}), ...(p.model ? { model: p.model } : {}), ...(p.effort && EFFORT_LEVELS.includes(p.effort as EffortLevel) ? { effort: p.effort as EffortLevel } : {}), ...(mode ? { permissionMode: mode } : {}), ...(p.startedBy ? { startedBy: p.startedBy } : {}) });
      return { id: r.thread.id };
    },
    createThere: async (runnerId, p) => {
      const r = (await relay.create(runnerId, { ...p })) as { thread: { id: string } };
      return { id: r.thread.id };
    },
    card: (threadId, c) => runner.requestCard(threadId, c),
    openCard: async (threadId) => {
      const src = sync.relaySource();
      if (!src) return undefined;
      const row = (await src.post('query', 'relay:remoteThread', { key: src.key, threadId })) as { pendingApproval?: { approvalId?: string } } | null;
      return row?.pendingApproval?.approvalId;
    },
    respondThere: async (threadId, approvalId, decision, message) => {
      await relay.call(threadId, 'approvals.respond', { threadId, approvalId, decision, ...(message ? { message } : {}) });
    },
  });
  crossHooks = {
    start: (threadId, req) => cross.start(threadId, req),
  };
  methods['requests.get'] = (p) => cross.get(String(p.threadId ?? ''), String(p.approvalId ?? ''));
  methods['requests.answer'] = (p) => cross.answer(String(p.threadId ?? ''), String(p.approvalId ?? ''), p.allow === true, typeof p.runnerId === 'string' ? p.runnerId : undefined, typeof p.fingerprint === 'string' ? p.fingerprint : undefined);
  const server = (rpcServer = new RpcServer({
    host: cfg.host,
    port: cfg.port,
    token,
    runner,
    log,
    clis: updates,
    methods,
    remote: peers,
    relay,
    updates: () => (draining ? undefined : runnerUpdates()),
    appHello: (build) => appRestarts.appHello(build),
    helloNotices: () => {
      // Like a missing claude: said to every client, until it's there.
      const noCodex = missingCodex(updates.codexBinary(), cfg);
      // Pushes failing (sync.ts notePushFailing) is said once as it starts;
      // an app that wasn't connected then hears it here.
      const pushFailing = sync.status().pushFailing;
      return [
        ...(pushFailing ? [{ level: 'warning' as const, message: pushFailingText(pushFailing) }] : []),
        ...(rolledBack ? [{ level: 'warning' as const, message: rolledBack }] : []),
        ...(noCodex ? [{ level: 'warning' as const, message: noCodex }] : []),
        ...restarter.helloNotices(),
        ...instructions.helloNotices(),
      ];
    },
  }));
  let port: number;
  try {
    ({ port } = await server.listen());
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    const why = err.code === 'EADDRINUSE' ? `port ${cfg.port} is already in use` : err.message;
    log.error('could not listen', { port: cfg.port, error: why });
    process.stderr.write(`runner can't listen on ${cfg.host}:${cfg.port}: ${why}\n`);
    await registry.killAll(1000);
    process.exit(1);
  }
  recordListening(cfg.home, port, DEFAULT_CWD);
  log.info('runner listening', { url: `ws://${cfg.host}:${port}/rpc` });
  // Tests read this line to know the runner is up.
  process.stdout.write(`threadbear-runner listening on ${port}\n`);
  tellLaunchListening();
  // Checks start a minute after this; installs never while a restart waits.
  updates.start();
  // The runner's log is held open by launchd too, so it's emptied in place.
  // The app's update log sits beside it, but only for the real data dir: a
  // dev runner's log is in its temp home.
  const stopHousekeeping = startHousekeeping({
    home: cfg.home,
    logs: [
      { file: cfg.logFile, inPlace: true },
      ...(cfg.home === defaultHome() ? [{ file: path.join(path.dirname(cfg.logFile), 'threadbear-update.log') }] : []),
    ],
    log,
  });
  const cancelMarkGood = markGoodLater(cfg.home, RELEASE.release, log, process.env, () => {
    restarter.proven();
    updater.start();
    upstream.start();
  });
  // Only once listening: a runner that can't listen exits, and the next
  // one should still find the resume.
  restarter.resumeAfterRestart();
  runner.tellStoppedWork();
  runner.carryOnStopped();
  // A thread waited on may have finished while the runner was down. Only
  // now: waking one starts its CLI, whose tools need what's set up above.
  runner.holdWaits = false;
  runner.reconcileWaits();
  // Reviews a runner that went away owed (runner/lab-review.ts).
  runner.startOwedReviews();

  let stopping = false;
  const stop = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    cancelMarkGood();
    updater.stop();
    upstream.stop();
    stopHousekeeping();
    log.info('runner stopping', { signal });
    // Whatever stopped it, a pending restart has now happened. A draining
    // runner's restart was the handover, which the new runner has taken.
    if (!draining) restarter.stopping();
    // A restart "now" stops the draining runners too (docs/protocol.md).
    if (signal === 'restart' && restarter.status().pendingRestart?.when === 'now') await peers.stopAll();
    peers.close();
    primaryLink?.close();
    scheduler.stop();
    // A check under way keeps what it prints for the next runner, but only
    // if this one is still here when it ends.
    // launch.mjs gives a runner 20 s after its own SIGTERM (STOP_GRACE_MS);
    // a restart of its own has no deadline.
    const checksDone = scheduler.settled(/^SIG|supervisor/.test(signal) ? 15_000 : undefined);
    librarian.stop();
    stuckJobs.stop();
    frozenClis.stop();
    macScreen?.stop();
    keepAwake.stop();
    connectors.stop();
    projects.stop();
    usage.stop();
    tally.stop();
    updates.stop();
    // A restart's new release writes everything again under the same
    // runnerId; only a stop for good tells the phone this runner is gone.
    secretCheck.stop();
    await sync.stop({ bye: signal !== 'restart' && !draining });
    try {
      await runner.shutdown();
      await server.close().catch(() => {});
      await drainServer?.close().catch(() => {});
      await registry.killAll(3000);
      if (draining) {
        registry.removeFile();
        removeDrainInfo(cfg.home, process.pid);
      }
      await checksDone;
    } finally {
      log.info('runner stopped');
      process.exit(0);
    }
  };

  // ------------------------------------------------------------ handover
  // docs/protocol.md, "Handovers". This runner keeps `keeps` (busy threads)
  // until their turns end and launch.mjs starts the current release beside
  // it, which takes everything else. The order matters: the new runner
  // must find this one's drain file, a free port and a free lock.
  let drainServer: RpcServer | undefined;
  let primaryHeard = false;
  const handOver = async (keeps: string[]) => {
    if (draining || stopping) return;
    draining = true;
    log.info('starting the handover', { keeps });
    try {
      cancelMarkGood();
      updater.stop();
      upstream.stop();
      stopHousekeeping();
      scheduler.stop();
      librarian.stop();
      // stuckJobs goes on: background work can hold a thread here for hours,
      // and a wait that can never end should still be noticed. It only looks
      // at this runner's threads, so the primary's check doesn't cover them.
      frozenClis.stop();
      macScreen?.stop();
    keepAwake.stop();
      connectors.stop();
      projects.freeze();
      updates.stop();
      usage.stopWriting();
      tally.stopWriting();
      // The new release mirrors from here on.
      secretCheck.stop();
      void sync.stop();
      // The older runners it was connected to are the new primary's now:
      // it connects to every one of them, and each thread they hand over
      // must go only there (27 Oct: three runners adopted the same one).
      peers.close();
      elsewhere = undefined;
      // Every thread not kept lets go now; resolves once their CLIs exit.
      await runner.beginDrain(keeps, {
        // Only while a new runner is connected to hear it; otherwise it
        // would load the thread as after a crash.
        ready: () => primaryHeard && (drainServer?.connectedClients() ?? 0) > 0,
        onHandedOver: (threadId) => {
          // To the primary, over the drain port.
          runner.publish({ method: 'drain.handedOver', params: { threadId } });
          if (runner.keeping()?.length === 0) finishDrain();
        },
      });
      // The new runner sweeps children.json; this one's CLIs are listed
      // apart so they're left alone.
      registry.moveTo(drainChildrenName(process.pid));
      drainServer = new RpcServer({
        host: '127.0.0.1',
        port: 0,
        token,
        runner,
        log,
        onlyOwn: true,
        methods: {
          'drain.hello': () => {
            primaryHeard = true;
            // After this answer, so the primary has subscribed first.
            setTimeout(() => runner.recheckHandovers(), 1000);
            return { pid: process.pid, version: RUNNER_VERSION, release: RELEASE.release, threads: runner.keeping() ?? [] };
          },
          'drain.stop': () => {
            setImmediate(() => void stop('drain.stop'));
            return {};
          },
          'runner.status': (p) => ({ ...(restartStatus(p) as Record<string, unknown>), draining: true, keeping: runner.keeping() }),
        },
      });
      const { port: drainPort } = await drainServer.listen();
      writeDrainInfo(cfg.home, { pid: process.pid, port: drainPort, version: RUNNER_VERSION, release: RELEASE.release, since: new Date().toISOString(), threads: runner.keeping() ?? [], auth: 'challenge' });
      await server.close().catch(() => {});
      lock.release();
      // The agent tools reach the new runner over the port from here.
      primaryLink = new PrimaryLink(cfg.host, cfg.port, token);
      elsewhere = primaryElsewhere(primaryLink, runner);
      log.info('draining', { port: drainPort, keeps: runner.keeping() });
    } catch (e) {
      log.error('could not hand over; restarting instead', { error: (e as Error)?.stack ?? String(e) });
      void stop('restart');
      return;
    }
    const reply = await requestHandover();
    if (!reply.ok) {
      // Nothing can start the new runner, and this one no longer listens on
      // the port: restart the old way, which ends the kept turns.
      log.error('launch.mjs would not start the new runner; restarting instead', { error: reply.error });
      void stop('restart');
      return;
    }
    log.info('the new runner is starting', { pid: reply.pid });
    if (runner.keeping()?.length === 0) finishDrain();
  };
  // Every kept thread has gone across: nothing left to do here.
  let finishing = false;
  const finishDrain = () => {
    if (finishing) return;
    finishing = true;
    log.info('handed every thread over; exiting');
    // A moment for the last drain.handedOver to reach the primary.
    setTimeout(() => void stop('drained'), 500);
  };
  // The supervisor is gone: nothing would restart this runner, and its
  // children would be orphans.
  onSupervisorGone(() => void stop('supervisor gone'));
  process.on('SIGTERM', () => void stop('SIGTERM'));
  process.on('SIGINT', () => void stop('SIGINT'));
  process.on('SIGHUP', () => void stop('SIGHUP'));
  process.on('uncaughtException', (e) => {
    log.error('uncaught exception', { error: e?.stack ?? String(e) });
    reportException(e, 'uncaught exception');
  });
  process.on('unhandledRejection', (e) => {
    log.error('unhandled rejection', { error: (e as Error)?.stack ?? String(e) });
    reportException(e, 'unhandled rejection');
  });
  // Last resort if the process exits some other way: kill the CLI groups
  // synchronously so they never outlive the runner.
  process.on('exit', () => {
    for (const pid of registry.pids()) {
      try {
        process.kill(-pid, 'SIGKILL');
      } catch {
        // gone
      }
    }
  });
}

// A warning when the Codex binary new sessions would start isn't there, or
// undefined. Threadbear's own copy may still be on its way.
function missingCodex(start: string, cfg: ReturnType<typeof loadConfig>): string | undefined {
  const bin = resolveCodexBinary(start);
  if (fs.existsSync(bin.command)) return undefined;
  if (cfg.codexPath) return `The codex CLI isn't at ${cfg.codexPath} (codexPath in runner.json), so Codex threads can't start.`;
  if (cfg.cliUpdates.codex !== 'off') return `The codex CLI isn't at ${start} yet, so Codex threads can't start until Threadbear has installed its own copy (Usage shows how that's going).`;
  return `The codex CLI isn't at ${start}, so Codex threads can't start. Install @openai/codex next to the runner's Node, or set codexPath in runner.json.`;
}

main().catch(async (e) => {
  process.stderr.write(`runner failed to start: ${e?.stack ?? e}\n`);
  reportException(e, 'runner failed to start');
  await flushSentry();
  process.exit(1);
});
