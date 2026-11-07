// The runner runs on Linux too. A macOS-only tool path (/usr/sbin/lsof,
// /bin/zsh) failed a fresh Ubuntu runner's pre-install tests and stopped
// the Hetzner runner updating (5 Nov 2026). These tests catch the next one.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loginShell } from '../../src/system-tools.ts';
import { lsofPath } from '../../src/handover.ts';

const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../src');

// Every absolute tool path the runner's code names, and why it's fine on
// Linux. "everywhere": a path both macOS and Ubuntu have. Anything else
// says what keeps it off Linux (a platform check, or a failure that's
// already handled), and the files it may appear in.
// It doesn't see a name built at run time (`'/bin/' + name`) or a bare
// name left to PATH (`spawn('zsh')`); those want a reviewer's eye.
const KNOWN: Record<string, { everywhere: true } | { linux: string; files: string[] }> = {
  '/bin/sh': { everywhere: true },
  '/bin/ps': { everywhere: true },
  '/bin/ls': { linux: 'only on darwin, for its access lists (aclProblem)', files: ['shell-allowlist.ts'] },
  '/bin/bash': { everywhere: true },
  '/usr/bin/bash': { linux: 'one of the shells loginShell looks for', files: ['system-tools.ts'] },
  '/bin/zsh': { linux: 'only on darwin; Linux gets loginShell()', files: ['system-tools.ts'] },
  '/usr/sbin/lsof': { linux: "lsofPath's Mac place", files: ['handover.ts'] },
  '/usr/bin/lsof': { linux: "lsofPath's Linux place", files: ['handover.ts'] },
  '/usr/bin/sips': { linux: 'behind MAC; ImageMagick on Linux', files: ['images.ts'] },
  '/usr/bin/qlmanage': { linux: 'behind MAC; rsvg-convert on Linux, or ffmpeg for a review clip', files: ['images.ts', 'review-media.ts'] },
  '/usr/sbin/system_profiler': { linux: 'behind a darwin check', files: ['machine.ts'] },
  '/usr/bin/vm_stat': { linux: 'behind a darwin check; /proc/meminfo on Linux', files: ['runner-stats.ts'] },
  '/usr/bin/sw_vers': { linux: 'behind a darwin check; /etc/os-release on Linux', files: ['runner-stats.ts'] },
  '/usr/sbin/ioreg': { linux: 'behind a darwin check', files: ['presence.ts'] },
  '/usr/bin/osascript': { linux: 'the Mac screen check, only started on darwin (main.ts)', files: ['mac-screen.ts'] },
  '/usr/bin/sandbox-exec': { linux: "a failed sample counts as not stuck", files: ['frozen-cli.ts'] },
  '/usr/bin/sample': { linux: "a failed sample counts as not stuck", files: ['frozen-cli.ts'] },
  '/usr/bin/open': { linux: "rejects with Couldn't open", files: ['runner.ts'] },
  '/usr/sbin/taskpolicy': { linux: 'behind a darwin check: the secret check is Mac only, and inBackground skips it off a Mac', files: ['secret-check.ts', 'background.ts'] },
  '/usr/bin/xcrun': { linux: 'behind a darwin check: the secret check is Mac only', files: ['secret-check.ts'] },
  '/usr/bin/pmset': { linux: 'behind darwin checks: the secret check and keeping awake are Mac only', files: ['secret-check.ts', 'keep-awake.ts'] },
  '/usr/bin/caffeinate': { linux: 'behind a darwin check: keeping awake is Mac only', files: ['keep-awake.ts'] },
  '/usr/bin/lockf': { linux: 'behind a darwin check; flock on Linux', files: ['worktrees.ts'] },
};

function sources(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? sources(path.join(dir, e.name)) : e.name.endsWith('.ts') ? [path.join(dir, e.name)] : [],
  );
}

test('every absolute tool path in src is known to work, or be kept off, on Linux', () => {
  const unknown: string[] = [];
  for (const file of sources(SRC)) {
    const rel = path.relative(SRC, file);
    fs.readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
      // Comments name paths too (Codex's `/bin/zsh -lc` wrapper); only code runs them.
      const code = line.replace(/^\s*\/\/.*$/, '').replace(/\s\/\/\s.*$/, '');
      for (const m of code.matchAll(/['"`](\/(?:usr\/)?(?:local\/)?(?:s?bin|libexec)\/[\w.-]+)/g)) {
        const known = KNOWN[m[1]];
        if (!known) unknown.push(`${rel}:${i + 1} runs ${m[1]}, which this test doesn't know. Is it on Linux? If not, look it up by platform (src/system-tools.ts, or lsofPath in handover.ts) and add it to KNOWN.`);
        else if (!('everywhere' in known) && !known.files.includes(path.basename(rel))) {
          unknown.push(`${rel}:${i + 1} runs ${m[1]}, which isn't on Linux (${known.linux}, in ${known.files.join(', ')}). Go through src/system-tools.ts, or keep it behind a platform check and add the file to KNOWN.`);
        }
      }
    });
  }
  assert.deepEqual(unknown, []);
});

const has = (...files: string[]) => (f: string) => files.includes(f);

test("the login shell: zsh on a Mac; on Linux, $SHELL if it's POSIX-style, else bash, else sh", () => {
  assert.deepEqual(loginShell({ platform: 'darwin', executable: () => false }), ['/bin/zsh', '-lc']);
  assert.deepEqual(loginShell({ platform: 'linux', executable: has('/bin/bash'), env: { SHELL: '/usr/bin/zsh' } }), ['/bin/bash', '-lc']);
  assert.deepEqual(loginShell({ platform: 'linux', executable: has('/bin/bash', '/usr/bin/zsh'), env: { SHELL: '/usr/bin/zsh' } }), ['/usr/bin/zsh', '-lc']);
  assert.deepEqual(loginShell({ platform: 'linux', executable: has('/bin/bash', '/usr/bin/fish'), env: { SHELL: '/usr/bin/fish' } }), ['/bin/bash', '-lc']);
  assert.deepEqual(loginShell({ platform: 'linux', executable: () => false, env: {} }), ['/bin/sh', '-lc']);
});

test('the lsof and login shell this machine picks are really there', () => {
  assert.ok(fs.existsSync(lsofPath()), `no lsof at ${lsofPath()}`);
  assert.ok(fs.existsSync(loginShell()[0]), `no shell at ${loginShell()[0]}`);
});
