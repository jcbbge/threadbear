// Starting a thread that fixes a failed update to main (update.ts), in
// place of the "couldn't update to main" banner.
//
// Mike, 6 Nov 2026: the banner came up often (mostly tests that flaked on a
// busy Mac), told him nothing he could act on, and left him to start a
// thread himself. Now the runner starts that thread in the background. It
// reads the output, fixes the cause on main (or clears the failed record
// when a rerun is all it takes), watches the runner build, and archives
// itself once main goes through, so Mike only hears about it when it needs
// him.
//
// Never more than one: while the last one is open, a failure at a newer
// commit goes to it as a message; the same failure again says nothing.
// Archiving it (it does that itself when it's done) lets the next failure
// start a fresh one.
import fs from 'node:fs';
import path from 'node:path';
import type { Logger } from './log.ts';

export type UpdateFailure = {
  // build: deploy.mjs's checks, snapshot or smoke test; backend: the Convex
  // backend and website deploy that runs first (update.ts).
  kind: 'build' | 'backend';
  commit: string;
  short: string;
  subject: string;
  error: string;
  logFile: string;
};

type State = { threadId: string; kind: UpdateFailure['kind']; commit: string };

export type UpdateFixerDeps = {
  home: string;
  log: Logger;
  // Starts the thread; returns its id.
  start: (r: { text: string; title: string; why: string }) => string;
  // Whether a thread is still there and not archived.
  open: (threadId: string) => boolean;
  // Queues a message to it.
  send: (threadId: string, text: string) => void;
};

export class UpdateFixer {
  private readonly deps: UpdateFixerDeps;

  constructor(deps: UpdateFixerDeps) {
    this.deps = deps;
  }

  private file(): string {
    return path.join(this.deps.home, 'runner', 'fix-update.json');
  }

  private read(): State | undefined {
    try {
      const s = JSON.parse(fs.readFileSync(this.file(), 'utf8')) as State;
      return typeof s.threadId === 'string' ? s : undefined;
    } catch {
      return undefined;
    }
  }

  private write(s: State): void {
    fs.mkdirSync(path.dirname(this.file()), { recursive: true });
    fs.writeFileSync(this.file(), JSON.stringify(s, null, 2) + '\n');
  }

  // When an update to main fails. Throws if the thread can't be started or
  // messaged, so the caller falls back to the banner.
  failed(f: UpdateFailure): 'started' | 'sent' | 'already' {
    const s = this.read();
    if (s && this.deps.open(s.threadId)) {
      if (s.commit === f.commit && s.kind === f.kind) return 'already';
      this.deps.send(s.threadId, followUp(f));
      this.write({ threadId: s.threadId, kind: f.kind, commit: f.commit });
      this.deps.log.info('told the fix-update thread about a newer failure', { threadId: s.threadId, commit: f.short });
      return 'sent';
    }
    const threadId = this.deps.start({ text: firstMessage(f, this.deps.home), title: title(f), why: 'an update to main that failed' });
    this.write({ threadId, kind: f.kind, commit: f.commit });
    this.deps.log.info('started a thread to fix a failed update', { threadId, commit: f.short, kind: f.kind });
    return 'started';
  }
}

function title(f: UpdateFailure): string {
  return f.kind === 'backend' ? `Fix the backend deploy at main ${f.short}` : `Fix the runner update to main ${f.short}`;
}

function what(f: UpdateFailure): string {
  return f.kind === 'backend'
    ? `The Convex backend couldn't be deployed at main ${f.short} (${f.subject}), so the runner is staying where it is: ${f.error}`
    : `The runner couldn't update to main at ${f.short} (${f.subject}): ${f.error}`;
}

function firstMessage(f: UpdateFailure, home: string): string {
  const retry = f.kind === 'backend'
    ? 'The runner deploys the backend again each time main moves to a new commit, so landing the fix is what retries it.'
    : `The runner builds main again within seconds of it moving. If nothing needed landing (it was a one-off), remove "${path.join(home, 'runner', 'update.json')}" and it tries again within 5 minutes.`;
  return `${what(f)}. The whole output is in ${f.logFile}.

Threadbear started this thread in the background in place of a banner. Fix it without me if you can:

1. Read the output and work out why. Fetch main first: if a commit since ${f.short} already fixes it, or another thread is on it, don't do it twice.
2. Fix the cause. A test that failed because the Mac was busy, or that flakes, gets made to hold up under load rather than just run again. Land the fix on main the usual way (AGENTS.md).
3. ${retry} Watch \`tb status\` until its "Following main" line no longer says failed (a release built and waiting to start, or up to date).
4. Once it's through, call end_turn with needs "nothing" and archive: true, so this never reaches my inbox. Only leave it for me if it needs a decision only I can make, you can't push from this machine, or it still fails after a real attempt. Then tell me in a few lines what's wrong and what you tried.`;
}

function followUp(f: UpdateFailure): string {
  return `It failed again at a newer commit. ${what(f)}. The whole output is in ${f.logFile}. Carry on the same way, and archive this thread once main goes through.`;
}
