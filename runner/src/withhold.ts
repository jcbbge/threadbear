// Tool calls whose output must never upload, whatever it looks like. Rules
// can't reliably spot a key that `sed`, `cut` or `sort` has mangled, and that's
// how most leaks went (docs/convex-backend.md, "Secret scrubbing"), so where
// the output came from decides it. A false alarm only costs someone a tap to
// fetch that output from the runner, so this errs towards holding back.
//
// Full sync asks this before sending a tool (full-sync.ts), and a tapped picture too.

export type WithholdReason = 'environment' | 'secret command' | 'secret file' | 'too long to check' | 'output of an earlier command';

// A word that names a file holding secrets. Matched against each word of a
// command and each path a tool was given.
const SECRET_FILE = new RegExp(
  [
    // .env, .env.local, prod.env. Not .env.example and friends.
    String.raw`(?:^|[/\\])(?:[\w-]+)?\.env(?:\.(?!example\b|sample\b|template\b|dist\b|defaults?\b)[\w-]+)*\*?$`,
    String.raw`\.(?:p8|p12|pfx|pem|key|keystore|jks|ppk|kdbx|gpg|asc)$`,
    String.raw`(?:^|[/\\])(?:id_rsa|id_dsa|id_ecdsa|id_ed25519)$`,
    String.raw`(?:^|[/\\])(?:\.npmrc|\.netrc|\.pypirc|\.pgpass|\.git-credentials|\.htpasswd|\.boto)$`,
    // Agents' and CLIs' own logins: Codex's auth.json, Claude's .credentials.json, tokens.json.
    String.raw`(?:^|[/\\])(?:\.?credentials|auth|tokens?)\.json$`,
    String.raw`(?:^|[/\\])(?:credentials?|secrets?|service[-_]?account[\w.-]*|client_secret[\w.-]*)(?:\.(?:json|ya?ml|toml|txt|ini|csv))?$`,
    // Any file in a folder that's for secrets.
    String.raw`(?:^|[/\\])(?:secrets|\.ssh|\.aws|\.gnupg|\.kube|\.azure|\.docker|keychains)[/\\]`,
    String.raw`(?:^|[/\\])\.config[/\\](?:gh|gcloud|op|sops|doctl)(?:[/\\]|$)`,
  ].join('|'),
  'i',
);
// Keys people publish on purpose.
// And `process.env` in a command is code, not a file called process.env.
const PUBLIC_FILE = /\.pub$|known_hosts$|[/\\]\.ssh[/\\]config$|authorized_keys$|\.asc\.txt$|^process\.env$/i;

// Commands that print the environment or a secret, wherever it's kept.
const ENV_COMMAND = new RegExp(
  [
    String.raw`\bprintenv\b`,
    // `env` on its own or into a pipe; `env FOO=1 cmd` runs a command instead.
    String.raw`(?:^|[;&|(]\s*|\bsudo\s+)(?:\S*/)?env\s*(?:$|[;&|>)]|-0\b|--null\b)`,
    String.raw`(?:^|[;&|(]\s*)(?:export\s+-p|declare\s+-[xp]+|typeset\s+-x|set)\s*(?:$|[;&|>)])`,
    String.raw`\benv\s+(?:list|ls|get|pull|show|view|export|dump)\b`,
    String.raw`\benv:(?:list|get|pull)\b`,
    String.raw`\b(?:heroku|dokku|fly|flyctl)\b[^|;&\n]*\b(?:config|secrets)\b`,
    String.raw`\bprocess\.env\b[^|;&\n]*\b(?:console\.log|JSON\.stringify)\b|\b(?:console\.log|JSON\.stringify)\b[^|;&\n]*\bprocess\.env\b(?!\.)`,
    String.raw`\bos\.environ\b(?![.\[])`,
    // A one-liner that reads the environment. Source that mentions it isn't one.
    String.raw`\b(?:node|bun|deno)\b[^\n]*\s-(?:e|p|pe|-eval|-print)\b[^\n]*\bprocess\.env\b`,
    String.raw`\bpython[\d.]*\b[^\n]*\s-c\b[^\n]*\b(?:os\.environ|getenv)\b`,
    String.raw`\bruby\b[^\n]*\s-e\b[^\n]*\bENV\b`,
    // Printing a variable named as a secret.
    String.raw`\b(?:echo|printf)\b[^|;&\n]*\$\{?[A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIALS?)\b`,
  ].join('|'),
  'i',
);
const SECRET_COMMAND = new RegExp(
  [
    String.raw`\bsecurity\s+(?:-\S+\s+)*(?:find-[\w-]*password|dump-keychain|export)\b`,
    String.raw`\bgh\s+auth\s+(?:token|status\s+[^|;&\n]*--show-token)\b`,
    String.raw`\bop\s+(?:read|inject|run|item\s+get|document\s+get)\b`,
    String.raw`\baws\b[^|;&\n]*\b(?:configure\s+(?:get|export)|get-secret-value|get-session-token|assume-role[\w-]*|get-federation-token|get-login-password|get-parameters?\b[^|;&\n]*--with-decryption)\b`,
    String.raw`\bgcloud\s+[^|;&\n]*\b(?:print-access-token|print-identity-token|secrets\s+versions\s+access)\b`,
    String.raw`\baz\s+[^|;&\n]*\bkeyvault\s+secret\s+show\b`,
    String.raw`\bkubectl\s+[^|;&\n]*\b(?:get|describe)\s+secrets?\b`,
    String.raw`\bvault\s+(?:kv\s+get|read)\b`,
    String.raw`\b(?:gpg|sops|age)\b[^|;&\n]*(?:--decrypt|-d)\b`,
    String.raw`\b(?:openssl\s+(?:genrsa|genpkey|rsa|ec|pkcs8|pkcs12)|ssh-keygen\s+[^|;&\n]*-y)\b`,
    String.raw`\b(?:npm\s+token|docker\s+login\b[^|;&\n]*--password|pass\s+show)\b`,
    String.raw`\bgit\s+credential\s+fill\b`,
    String.raw`\btb\s+(?:phone-token|pair)\b|\btokens:issue\b|\bdeployment\s+token\s+create\b`,
  ].join('|'),
  'i',
);

// A command's words, near enough: split on what the shell splits on, with
// quotes off. It only has to find file names, so it needn't be a real parser.
function commandWords(command: string): string[] {
  return command.split(/[\s;&|<>()=`'"]+/).filter(Boolean);
}

function secretPath(p: string): boolean {
  return SECRET_FILE.test(p) && !PUBLIC_FILE.test(p);
}

// A tool reading what an earlier command printed, by that command's id
// (BashOutput, TaskOutput). What it reads is only as safe as that command, which
// full-sync.ts knows.
export function outputOfJob(input: Record<string, unknown> | undefined): string | undefined {
  for (const k of ['bash_id', 'shell_id', 'task_id', 'session_id']) {
    const v = input?.[k];
    if (typeof v === 'string' && v) return v;
    if (typeof v === 'number') return String(v);
  }
  return undefined;
}

// The file a background job writes its output to, read directly: nothing here says
// which command it was, so it's held back.
const JOB_OUTPUT_FILE = /\/tasks\/[^/\s'"]+\.output\b/;

/** A file a tool changed: its diff can hold what the file did. */
export function withholdPath(p: string): WithholdReason | undefined {
  return secretPath(p) ? 'secret file' : undefined;
}

export function withholdReason(call: { kind?: string; name?: string; title?: string; input?: Record<string, unknown> }): WithholdReason | undefined {
  const input = call.input ?? {};
  const given = typeof input.command === 'string' ? input.command : typeof input.cmd === 'string' ? input.cmd : undefined;
  // The start of a long one: the patterns aren't linear on a very long line, and
  // this runs on every tool call as it happens.
  const command = given?.slice(0, 16_384);
  if (command !== undefined) {
    // What's past that wasn't looked at, or was already cut before it got here
    // (tools.ts truncateInput), so nothing can say it's safe.
    if (given!.length > 16_384 || given!.endsWith('\n[truncated]')) return 'too long to check';
    if (JOB_OUTPUT_FILE.test(command)) return 'output of an earlier command';
    if (ENV_COMMAND.test(command)) return 'environment';
    if (SECRET_COMMAND.test(command)) return 'secret command';
    if (commandWords(command).some(secretPath)) return 'secret file';
  }
  for (const k of ['file_path', 'path', 'notebook_path', 'filename', 'file', 'target_file']) {
    const v = input[k];
    if (typeof v === 'string' && (secretPath(v) || JOB_OUTPUT_FILE.test(v))) return secretPath(v) ? 'secret file' : 'output of an earlier command';
  }
  // Lists of paths: Codex's patches, and tools that take several files.
  for (const k of ['paths', 'file_paths', 'files', 'filenames']) {
    const v = input[k];
    if (Array.isArray(v) && v.some((x) => typeof x === 'string' && secretPath(x))) return 'secret file';
  }
  // A search over files by name: Grep's glob, or a path list.
  if (typeof input.glob === 'string' && /\.env\b|\.pem\b|\.p8\b/.test(input.glob)) return 'secret file';
  return undefined;
}
