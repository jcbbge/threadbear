// What someone else's copy of this repo shows from its own patches
// (.threadbear/patches): every chip and panel a thread in their fork gets.
// Wayne opened a thread in his fork on 6 Nov and found a Sentry chip
// pointing at Mike's Sentry, which he couldn't open and wasn't meant to see.
//
// The patches load here as on a stranger's Mac: a home folder with nothing
// of Mike's in it (no ~/dev/me/poddle, no keys), so a `when` that looks for
// something of Mike's comes out false. What's left must match SHOWN below.
// Adding to SHOWN means every fork shows it: only things anyone can use
// (public pages, the repo's own scripts), never Mike's accounts. Something
// only Mike needs gets a `when` that checks for something only he has, as
// app-store.ts's onMikesMac does.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tmpDir } from '../helpers/fakes.ts';
import { applyLive, loadPatchSet, type CommandOutcome } from '../../src/patches.ts';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

const SHOWN = {
  actions: [['Website', 'https://threadbear.mikecann.app/']],
  panels: ['Worktrees'],
};

// Things of Mike's that a stranger's copy must never show, whatever SHOWN
// says, so a careless update to SHOWN still fails.
const MIKES = [/mikec\.sentry\.io/, /appstoreconnect\.apple\.com/, /~\/dev\/me\//, /\/Users\/m5-mike/, /mikecann@|mike@cannstudios/];

test("a fork's own patches show nothing of Mike's", async () => {
  const home = tmpDir();
  const copy = path.join(home, 'dev', 'threadbear');
  fs.cpSync(path.join(REPO, '.threadbear'), path.join(copy, '.threadbear'), { recursive: true });
  const base = await loadPatchSet(copy, home);
  assert.deepEqual(base.patches.filter((p) => p.error).map((p) => `${p.id}: ${p.error}`), []);
  // Commands run in the real checkout, for git, but with the stranger's home.
  const run = async (command: string): Promise<CommandOutcome> => {
    const r = spawnSync('/bin/sh', ['-c', command], { cwd: REPO, env: { ...process.env, HOME: home }, encoding: 'utf8', timeout: 20_000 });
    return { ok: r.status === 0, exitCode: r.status ?? undefined, text: `${r.stdout ?? ''}${r.stderr ?? ''}`, truncated: false, durationMs: 0 };
  };
  const set = await applyLive(base, { cwd: copy, threadId: 'fork-view', run });

  const shown = JSON.stringify([set.actions, set.panels]);
  for (const mark of MIKES) assert.doesNotMatch(shown, mark);
  assert.deepEqual(
    {
      actions: set.actions.map((a) => [a.title, a.url ?? a.command ?? a.prompt]),
      panels: set.panels.map((p) => p.title),
    },
    SHOWN,
  );
});
