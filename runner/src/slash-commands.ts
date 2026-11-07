// Slash commands typed in the message box (docs/protocol.md, "Slash
// commands"). Claude Code runs its own when they arrive as the message's
// text, so most go straight through. Codex's app-server doesn't: it hands
// "/compact" to the model as words. So each command is one of:
//   - the CLI's: sent as typed (Claude's, and the Codex ones its adapter
//     maps to an app-server call: /compact, /review, a skill);
//   - Threadbear's: the runner does it, as the app would (/model, /effort,
//     Codex's /clear and /status), so the thread's settings stay the truth;
//   - one that can't work here: answered with a note saying what does.
// A path ("/Users/mike") isn't a command; a command neither CLI knows goes
// to the model as words, as it did before.
import type { Provider } from './protocol.ts';

export type SlashCommandSource = 'cli' | 'skill' | 'threadbear';

// What the composer's picker lists.
export type SlashCommand = {
  name: string; // without the slash
  description?: string;
  argumentHint?: string;
  source: SlashCommandSource;
  aliases?: string[];
  // Where it was defined (docs/protocol.md, "Slash commands"): user,
  // project, plugin (with `plugin`), claude.ai or system.
  scope?: string;
  plugin?: string;
  path?: string; // its file on this machine, when found
};

export type ParsedCommand = { name: string; args: string };

// "/compact", "/model opus", "/code-review high the auth change". Not a
// path ("/Users/mike", "/tmp/x"): a command's name has no slash in it and is
// followed by a space, a line break or nothing.
export function parseCommand(text: string): ParsedCommand | undefined {
  const m = /^\/([A-Za-z][\w.:-]*)(?:\s+([\s\S]*))?$/.exec(text.trim());
  if (!m) return undefined;
  return { name: m[1], args: (m[2] ?? '').trim() };
}

// Runner-side answers for commands that are part of a CLI's terminal app
// and have a Threadbear equivalent or none. Both providers.
const ELSEWHERE: Record<string, string> = {
  help: 'Type / in the message box to see the commands this thread can run.',
  rewind: 'To go back, edit one of your earlier messages: hover it and click the pencil. The conversation (and the files the agent edited) goes back to just before it.',
  resume: 'Each Threadbear thread keeps its own session. Open the thread you want to carry on from the sidebar, or search for it.',
  login: 'Sign in from Settings > Accounts in the Mac app.',
  logout: 'Sign out from Settings > Accounts in the Mac app.',
  permissions: 'Pick Full access, Auto or Ask before edits from the menu under the message box.',
  approvals: 'Pick Full access, Auto or Ask before edits from the menu under the message box.',
  exit: 'Nothing to quit here: archive the thread when you are done with it.',
  quit: 'Nothing to quit here: archive the thread when you are done with it.',
  config: '',
  mcp: '',
  agents: '',
  hooks: '',
  ide: '',
  terminal: '',
  'terminal-setup': '',
  vim: '',
  theme: '',
  statusline: '',
  doctor: '',
  bug: '',
  feedback: '',
  init: '',
  diff: 'The thread\'s changes are under Highlights, on the right.',
  mention: '',
  fork: '',
  undo: 'To go back, edit one of your earlier messages: hover it and click the pencil.',
  personality: '',
  experimental: '',
};

// The ones Claude's CLI says "isn't available in this environment" to,
// where Threadbear has its own way.
const CLAUDE_ELSEWHERE = new Set(['help', 'rewind', 'resume', 'login', 'logout', 'permissions', 'exit', 'quit']);

// Commands Codex's terminal app has that Threadbear runs for it. Claude's
// own run in its CLI; these are the Codex picker's list.
const CODEX_COMMANDS: SlashCommand[] = [
  { name: 'compact', description: 'Summarise the conversation so far to free up context', source: 'cli' },
  { name: 'review', description: 'Review the uncommitted changes, or what you describe', argumentHint: '[instructions]', source: 'cli' },
  { name: 'clear', description: 'Start a fresh session in this thread (the transcript stays)', source: 'threadbear' },
  { name: 'new', description: 'Start a fresh session in this thread (the transcript stays)', source: 'threadbear' },
  { name: 'status', description: 'The model, effort, context used and the login\'s limits', source: 'threadbear' },
];

// Threadbear's own, on both providers: settings the app also changes.
export const THREADBEAR_COMMANDS: SlashCommand[] = [
  { name: 'model', description: 'Switch this thread\'s model', argumentHint: '[model]', source: 'threadbear' },
  { name: 'effort', description: 'Set this thread\'s effort level', argumentHint: '[low|medium|high|xhigh|max]', source: 'threadbear' },
];

// Claude commands the picker leaves out: ones its CLI says "isn't available
// in this environment" to, or that only make sense in its terminal.
const CLAUDE_HIDDEN = new Set(['help', 'rewind', 'resume', 'login', 'logout', 'permissions', 'exit', 'quit', 'ide', 'terminal-setup', 'vim', 'theme', 'statusline', 'doctor', 'bug', 'feedback', 'hooks', 'agents', 'mcp', 'model', 'effort']);

export type CommandPlan =
  // Send it to the CLI as typed (its adapter knows what to do with it).
  | { kind: 'cli' }
  // The runner does it.
  | { kind: 'model'; args: string }
  | { kind: 'effort'; args: string }
  | { kind: 'clear' }
  | { kind: 'status' }
  // Answered with this note, and nothing sent.
  | { kind: 'note'; text: string };

// What to do with a message that starts with a slash command. skills: the
// Codex thread's skill names when known, which win over a terminal-only
// command of the same name (its adapter adds the skill to the message).
export function planCommand(provider: Provider, cmd: ParsedCommand, skills: ReadonlySet<string> = new Set()): CommandPlan {
  const name = cmd.name.toLowerCase();
  if (name === 'model') return { kind: 'model', args: cmd.args };
  if (name === 'effort') return { kind: 'effort', args: cmd.args };
  if (provider === 'claude') {
    // Claude's CLI runs the rest itself, and answers any others it can't
    // ("/x isn't available in this environment").
    return CLAUDE_ELSEWHERE.has(name) ? { kind: 'note', text: `/${name} is part of Claude Code's terminal app. ${ELSEWHERE[name]}` } : { kind: 'cli' };
  }
  if (name === 'compact' || name === 'review') return { kind: 'cli' };
  if (name === 'clear' || name === 'new') return { kind: 'clear' };
  if (name === 'status' || name === 'context' || name === 'cost' || name === 'usage') return { kind: 'status' };
  if (skills.has(cmd.name)) return { kind: 'cli' };
  if (name in ELSEWHERE) {
    const said = ELSEWHERE[name];
    return { kind: 'note', text: `/${name} is part of Codex's terminal app and doesn't run in Threadbear.${said ? ` ${said}` : ''}` };
  }
  // Its adapter adds the skill when one has this name (the runner may not
  // have its list yet), else Codex gets it as words.
  return { kind: 'cli' };
}

// The picker's list for a thread: Threadbear's own first, then the CLI's.
export function commandList(provider: Provider, cli: SlashCommand[]): SlashCommand[] {
  const own = provider === 'codex' ? [...THREADBEAR_COMMANDS, ...CODEX_COMMANDS] : THREADBEAR_COMMANDS;
  const seen = new Set(own.map((c) => c.name));
  const rest = cli.filter((c) => {
    if (seen.has(c.name) || (provider === 'claude' && CLAUDE_HIDDEN.has(c.name))) return false;
    seen.add(c.name);
    return true;
  });
  return [...own, ...rest];
}
