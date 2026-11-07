// Slash commands from the message box (docs/protocol.md, "Slash commands"):
// the parser, what each provider does with one, the runner's own, and the
// picker's list. Fake adapters (fakes.ts); the adapters' own mapping is in
// codex-adapter.test.ts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FakeAccounts, makeHarness, tick, withCodex } from '../helpers/fakes.ts';
import { commandList, parseCommand, planCommand } from '../../src/slash-commands.ts';
import { pickModel } from '../../src/runner/commands.ts';
import { claudeCommands, commandScope } from '../../src/adapters/claude/adapter.ts';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { codexSkillCommands, skillMap } from '../../src/adapters/codex/adapter.ts';

const notes = (h: { events(id: string): any[] }, id: string): string[] => h.events(id).filter((e) => e.type === 'system.note').map((e) => e.text);

function harness() {
  const fake = new FakeAccounts(withCodex());
  return makeHarness(undefined, {}, { accounts: fake });
}

test('parseCommand reads a command and its arguments, and leaves paths alone', () => {
  assert.deepEqual(parseCommand('/compact'), { name: 'compact', args: '' });
  assert.deepEqual(parseCommand('  /model opus  '), { name: 'model', args: 'opus' });
  assert.deepEqual(parseCommand('/code-review high\nthe auth bit'), { name: 'code-review', args: 'high\nthe auth bit' });
  assert.deepEqual(parseCommand('/plugin:skill x'), { name: 'plugin:skill', args: 'x' });
  assert.equal(parseCommand('/Users/mike/notes.md'), undefined);
  assert.equal(parseCommand('/tmp/x is full'), undefined);
  assert.equal(parseCommand('compact /now'), undefined);
  assert.equal(parseCommand('/'), undefined);
  assert.equal(parseCommand('/ hi'), undefined);
});

test('planCommand: Claude runs its own; Codex gets the app-server ones, the runner\'s and notes', () => {
  const p = (provider: 'claude' | 'codex', text: string) => planCommand(provider, parseCommand(text)!);
  assert.deepEqual(p('claude', '/compact'), { kind: 'cli' });
  assert.deepEqual(p('claude', '/code-review high'), { kind: 'cli' });
  assert.deepEqual(p('claude', '/clear'), { kind: 'cli' });
  assert.deepEqual(p('claude', '/model opus'), { kind: 'model', args: 'opus' });
  assert.equal(p('claude', '/rewind')?.kind, 'note');
  assert.deepEqual(p('codex', '/compact'), { kind: 'cli' });
  assert.deepEqual(p('codex', '/review the auth change'), { kind: 'cli' });
  assert.deepEqual(p('codex', '/new'), { kind: 'clear' });
  assert.deepEqual(p('codex', '/context'), { kind: 'status' });
  assert.match((p('codex', '/mcp') as { text: string }).text, /terminal app/);
  // Not one Codex knows: words for the model, as before (a skill's name is
  // added to the turn by the adapter).
  assert.deepEqual(p('codex', '/deslop'), { kind: 'cli' });
  // ...but a skill of that name wins over a terminal-only command.
  assert.deepEqual(planCommand('codex', parseCommand('/init')!, new Set(['init'])), { kind: 'cli' });
});

test('commandList puts Threadbear\'s own first and hides Claude\'s terminal-only ones', () => {
  const claude = commandList('claude', [
    { name: 'compact', source: 'cli' },
    { name: 'model', source: 'cli' },
    { name: 'resume', source: 'cli' },
    { name: 'code-review', source: 'skill' },
  ]);
  assert.deepEqual(claude.map((c) => c.name), ['model', 'effort', 'compact', 'code-review']);
  const codex = commandList('codex', [{ name: 'deslop', source: 'skill' }, { name: 'review', source: 'skill' }]);
  assert.deepEqual(codex.map((c) => c.name), ['model', 'effort', 'compact', 'review', 'clear', 'new', 'status', 'deslop']);
});

test('claudeCommands keeps the builtin row of a shared name and marks the rest skills', () => {
  const out = claudeCommands([
    { name: 'review', description: 'mine', argumentHint: '', builtin: false },
    { name: 'review', description: 'theirs', argumentHint: '<pr>', builtin: true },
    { name: 'deslop', description: 'clean', argumentHint: '' },
  ]);
  assert.deepEqual(out, [
    { name: 'review', source: 'cli', description: 'theirs', argumentHint: '<pr>', scope: 'system' },
    { name: 'deslop', source: 'skill', description: 'clean' },
  ]);
});

test('Codex skills become picker rows and a name-to-path map, without disabled ones', () => {
  const r = { data: [{ cwd: '/w', skills: [
    { name: 'deslop', description: 'long', shortDescription: 'short', path: '/s/deslop/SKILL.md', enabled: true },
    { name: 'off', description: 'x', path: '/s/off/SKILL.md', enabled: false },
  ] }] };
  assert.deepEqual(codexSkillCommands(r), [{ name: 'deslop', source: 'skill', description: 'short', path: '/s/deslop/SKILL.md' }]);
  assert.deepEqual([...skillMap(r)], [['deslop', '/s/deslop/SKILL.md']]);
});

test('pickModel matches ids, titles and the start of one, and Claude aliases', () => {
  const codex = withCodex().find((a) => a.provider === 'codex')!;
  assert.equal(pickModel(codex, 'gpt-6-luna'), 'gpt-6-luna');
  assert.equal(pickModel(codex, 'GPT-6.1-Sol'), 'gpt-6.1-sol');
  assert.equal(pickModel(codex, 'luna'), undefined);
  assert.equal(pickModel(codex, 'gpt-6-l'), 'gpt-6-luna');
  assert.equal(pickModel(codex, 'opus'), undefined);
  const claude = withCodex()[0];
  assert.equal(pickModel(claude, 'Opus'), 'opus');
  assert.equal(pickModel(claude, 'claude-sonnet-5-5[1m]'), 'claude-sonnet-5-5[1m]');
});

test('a Claude command reaches the CLI as typed, with no phone line or project news in front', async () => {
  const h = harness();
  const { thread } = h.runner.create({ text: 'hi', accountId: 'claude-main' });
  const s = h.adapter.last;
  s.init();
  s.result();
  h.runner.send(thread.id, '/compact', [], { origin: 'phone' });
  await tick();
  assert.equal(s.sent.at(-1)!.text, '/compact');
  // Words from the phone still say so.
  s.result();
  h.runner.send(thread.id, 'and now?', [], { origin: 'phone' });
  await tick();
  assert.match(s.sent.at(-1)!.text, /^\[Sent from the iPhone app/);
});

test('a command sent during a turn waits for it rather than going into it', async () => {
  const h = harness();
  const { thread } = h.runner.create({ text: 'hi', accountId: 'claude-main' });
  const s = h.adapter.last;
  s.init();
  h.runner.send(thread.id, 'more words');
  await tick();
  assert.equal(s.sent.length, 2, 'words steer in');
  h.runner.send(thread.id, '/compact');
  await tick();
  assert.equal(s.sent.length, 2, 'the command waits');
  s.result('completed', undefined, undefined, { answered: [s.sent[0].id!, s.sent[1].id!] });
  await tick();
  assert.equal(s.sent.at(-1)!.text, '/compact');
});

test('/model on a Codex thread changes the thread\'s model, with no CLI turn', async () => {
  const h = harness();
  const { thread } = h.runner.create({ text: 'hi', accountId: 'codex-main' });
  const s = h.codex.last;
  s.init('cx-1', 'gpt-6.1-sol');
  s.result();
  h.runner.send(thread.id, '/model gpt-6-luna');
  await tick();
  assert.equal(s.sent.length, 1, 'nothing sent to the CLI');
  assert.equal(h.runner.get(thread.id).model, 'gpt-6-luna');
  assert.deepEqual(s.models, ['gpt-6-luna']);
  const n = notes(h, thread.id);
  assert.ok(n.includes('This thread is on GPT-6-Luna from here.'), n.join('\n'));
  assert.ok(!n.some((t) => /next turn/.test(t)), 'no "applies from the next turn" for its own turn');
  const done = h.events(thread.id).filter((e) => e.type === 'turn.completed');
  assert.equal(done.length, 2);
  assert.equal(done[1].outcome, 'completed');
  assert.equal(h.runner.status(thread.id), 'idle');
  h.runner.send(thread.id, '/model nope');
  await tick();
  assert.match(notes(h, thread.id).at(-1)!, /no model called "nope".*GPT-6.1-Sol, GPT-6-Luna/);
});

test('/effort sets the level, and default puts it back', async () => {
  const h = harness();
  const { thread } = h.runner.create({ text: 'hi', accountId: 'codex-main' });
  const s = h.codex.last;
  s.init('cx-1', 'gpt-6.1-sol');
  s.result();
  h.runner.send(thread.id, '/effort high');
  await tick();
  assert.equal(h.runner.get(thread.id).effort, 'high');
  h.runner.send(thread.id, '/effort default');
  await tick();
  assert.equal(h.runner.get(thread.id).effort, undefined);
  assert.equal(notes(h, thread.id).at(-1), "Back to the model's own effort level.");
});

test('/clear on Codex starts a fresh session from the next message', async () => {
  const h = harness();
  const { thread } = h.runner.create({ text: 'hi', accountId: 'codex-main' });
  const s = h.codex.last;
  s.init('cx-1', 'gpt-6.1-sol');
  s.result();
  h.runner.send(thread.id, '/clear');
  await tick();
  assert.equal(s.sent.length, 1);
  assert.match(notes(h, thread.id).at(-1)!, /^Cleared the conversation/);
  h.runner.send(thread.id, 'fresh');
  await tick();
  const next = h.codex.last;
  assert.notEqual(next, s, 'a new CLI');
  assert.equal(next.opts.resume, false);
  assert.equal(next.sent[0].text, 'fresh');
});

test('/status on Codex says the model, effort and context', async () => {
  const h = harness();
  const { thread } = h.runner.create({ text: 'hi', accountId: 'codex-main' });
  const s = h.codex.last;
  s.init('cx-1', 'gpt-6.1-sol');
  s.out({ kind: 'context', contextTokens: 50_000, contextWindow: 200_000 });
  s.result();
  h.runner.send(thread.id, '/status');
  await tick();
  assert.equal(s.sent.length, 1);
  assert.match(notes(h, thread.id).at(-1)!, /Context: 50k of 200k tokens \(25%\)/);
});

test('/rewind on Claude says how Threadbear does it, without a CLI turn', async () => {
  const h = harness();
  const { thread } = h.runner.create({ text: 'hi', accountId: 'claude-main' });
  const s = h.adapter.last;
  s.init();
  s.result();
  h.runner.send(thread.id, '/rewind');
  await tick();
  assert.equal(s.sent.length, 1);
  assert.match(notes(h, thread.id).at(-1)!, /edit one of your earlier messages/);
});

test('threads.commands lists the CLI\'s commands for the thread\'s folder, cached', async () => {
  const h = harness();
  let asked = 0;
  h.adapter.commands = async () => {
    asked++;
    return [{ name: 'compact', source: 'cli' }, { name: 'code-review', source: 'skill', description: 'Review' }];
  };
  const { thread } = h.runner.create({ text: 'hi', accountId: 'claude-main' });
  const a = await h.runner.threadCommands(thread.id);
  assert.deepEqual(a.commands.map((c) => c.name), ['model', 'effort', 'compact', 'code-review']);
  await h.runner.threadCommands(thread.id);
  assert.equal(asked, 1);
});

test('a CLI command\'s output leaves no card, as it asks nothing', async () => {
  const h = harness();
  const { thread } = h.runner.create({ text: 'hi', accountId: 'claude-main' });
  const s = h.adapter.last;
  s.init();
  s.result();
  h.runner.send(thread.id, '/cost');
  await tick();
  assert.equal(s.sent.at(-1)!.text, '/cost');
  s.text('m1', 'Your usage this week. Want to see more?');
  s.result();
  await tick();
  const done = h.events(thread.id).filter((e) => e.type === 'turn.completed').at(-1);
  assert.equal(done.needs, undefined);
});

test('words sent during a command\'s turn wait for the next one', async () => {
  const h = harness();
  const { thread } = h.runner.create({ text: '/compact', accountId: 'claude-main' });
  const s = h.adapter.last;
  s.init();
  await tick();
  h.runner.send(thread.id, 'then this');
  await tick();
  assert.equal(s.sent.length, 1);
  s.result();
  await tick();
  assert.equal(s.sent.at(-1)!.text, 'then this');
});

test('a command with a move to another login waiting asks for a message first; /clear drops the move\'s catch-up', async () => {
  const h = harness();
  const { thread } = h.runner.create({ text: 'hi', accountId: 'claude-main' });
  const s = h.adapter.last;
  s.init();
  s.result();
  h.runner.update({ threadId: thread.id, accountId: 'codex-main' });
  h.runner.send(thread.id, '/compact');
  await tick();
  assert.match(notes(h, thread.id).at(-1)!, /just moved to .*Send one first, then \/compact again/);
  assert.equal(h.codex.sessions.length, 0, 'no Codex CLI for it');
  h.runner.send(thread.id, '/clear');
  await tick();
  h.runner.send(thread.id, 'fresh start');
  await tick();
  const c = h.codex.last;
  assert.equal(c.opts.resume, false);
  assert.equal(c.sent[0].text, 'fresh start', 'no handoff note in front');
});

test('threads.commands lists a folder whose Claude settings aren\'t trusted without them', async () => {
  const h = harness();
  let got: unknown = 'unset';
  h.adapter.commands = async (_a, _cwd, untrusted) => {
    got = untrusted;
    return [];
  };
  (h.runner as any).patchTrust = { ...(h.runner as any).patchTrust, checkClaude: () => ({ trusted: false, hash: 'h1' }) };
  const { thread } = h.runner.create({ text: 'hi', accountId: 'claude-main' });
  h.adapter.last.init();
  h.adapter.last.result();
  await h.runner.threadCommands(thread.id);
  assert.notEqual(got, 'unset');
  assert.equal(typeof got, 'object', 'the settings without their commands');
});

test('a Codex skill named like a terminal command runs, found from the folder\'s list', async () => {
  const h = harness();
  h.codex.commands = async () => [{ name: 'init', source: 'skill' }];
  const { thread } = h.runner.create({ text: 'hi', accountId: 'codex-main' });
  const s = h.codex.last;
  s.init('cx-1', 'gpt-6.1-sol');
  s.result();
  h.runner.send(thread.id, '/init');
  await tick();
  assert.equal(s.sent.at(-1)!.text, '/init');
});

test('words go into a skill\'s turn, as into any other', async () => {
  const h = harness();
  const { thread } = h.runner.create({ text: '/deslop the runner', accountId: 'claude-main' });
  const s = h.adapter.last;
  s.init();
  await tick();
  h.runner.send(thread.id, 'only runner/src/foo.ts');
  await tick();
  assert.equal(s.sent.length, 2);
});

test('commandScope takes the CLI\'s tag off a description and says where it came from', () => {
  assert.deepEqual(commandScope('Mike voice. (user)'), { text: 'Mike voice.', scope: 'user' });
  assert.deepEqual(commandScope('Docs (claude.ai sync)'), { text: 'Docs', scope: 'claude.ai' });
  assert.deepEqual(commandScope('Ship it (ship-tools)'), { text: 'Ship it', scope: 'plugin', plugin: 'ship-tools' });
  assert.deepEqual(commandScope('Read it (see below)'), { text: 'Read it (see below)' }, 'words in brackets stay');
  assert.deepEqual(commandScope('Plain'), { text: 'Plain' });
});

test('claudeCommands finds a user skill\'s file and a project command\'s, and keeps aliases', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-cmds-'));
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-cmds-cwd-'));
  fs.mkdirSync(path.join(home, 'skills', 'voice'), { recursive: true });
  fs.writeFileSync(path.join(home, 'skills', 'voice', 'SKILL.md'), 'x');
  fs.mkdirSync(path.join(cwd, '.claude', 'commands', 'ops'), { recursive: true });
  fs.writeFileSync(path.join(cwd, '.claude', 'commands', 'ops', 'deploy.md'), 'x');
  const out = claudeCommands([
    { name: 'usage', description: 'Usage', argumentHint: '', builtin: true, aliases: ['cost', 'stats'] },
    { name: 'voice', description: 'Write as Mike (user)', argumentHint: '' },
    { name: 'ops:deploy', description: 'Deploy (project)', argumentHint: '' },
    { name: 'gone', description: 'Missing (user)', argumentHint: '' },
  ], { cwd, configDir: home });
  assert.deepEqual(out[0], { name: 'usage', source: 'cli', description: 'Usage', aliases: ['cost', 'stats'], scope: 'system' });
  assert.deepEqual(out[1], { name: 'voice', source: 'skill', description: 'Write as Mike', scope: 'user', path: path.join(home, 'skills', 'voice', 'SKILL.md') });
  assert.equal(out[2].path, path.join(cwd, '.claude', 'commands', 'ops', 'deploy.md'));
  assert.equal(out[3].path, undefined);
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(cwd, { recursive: true, force: true });
});
