import fs from 'node:fs';

// Builds and tests Threadbear starts itself (the land's check, a new
// worktree's setup, turn hooks like the runner typecheck, the release
// builds) run at macOS's background priority, as Mike asks of everything
// heavy on his M5 ("Heavy compute" in his CLAUDE.md): `taskpolicy -b`
// throttles CPU and disk and keeps it off the cores he's using, and every
// process it starts inherits that. The agent-side hook only adds it to
// commands an agent runs itself, not to what the runner or `tb land`
// spawns, and a land's check once held the load above 24 for ten minutes
// (6 Nov). Elsewhere (Linux, no taskpolicy) the command runs as it is.
export const TASKPOLICY = '/usr/sbin/taskpolicy';

export function inBackground(
  bin: string,
  args: string[],
  opts: { platform?: NodeJS.Platform; exists?: (p: string) => boolean } = {},
): [string, string[]] {
  const platform = opts.platform ?? process.platform;
  const exists = opts.exists ?? fs.existsSync;
  if (platform !== 'darwin' || !exists(TASKPOLICY)) return [bin, args];
  return [TASKPOLICY, ['-b', bin, ...args]];
}
