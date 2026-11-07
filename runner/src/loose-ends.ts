// Loose ends (experiment looseEnds; docs/protocol.md, "Loose ends"): what's
// still open on a thread whose last turn said it's done, checked by the
// runner so the done card can say whether Archive is safe without Mike
// asking the agent. The nightly retro counted 27 typed "anything else, or
// archive?" asks on 6 Nov 2026: Archive puts the thread away straight off,
// and he wanted someone's word that nothing was left first. The one real
// loose end in the threads it looked at was a branch not on main
// (938c1cd1), so these are the things a runner can see for itself.
import type { LooseEnd, Schedule } from './protocol.ts';
import { git, MAIN, type WorktreeRecord } from './worktrees.ts';

// The thread's own worktree: commits on its branch that main doesn't have,
// and files in it that aren't committed. Untracked ones count, as a new
// file the agent wrote and never committed is lost when the worktree goes;
// ignored ones (build output, the linked node_modules) don't show at all.
export async function worktreeLooseEnds(w: WorktreeRecord): Promise<LooseEnd[]> {
  const out: LooseEnd[] = [];
  const ahead = await git(w.mainCheckout, ['rev-list', '--count', `${MAIN}..refs/heads/${w.branch}`]);
  const commits = ahead.ok ? Number.parseInt(ahead.stdout.trim(), 10) : 0;
  if (commits > 0) out.push({ kind: 'unlanded', text: `${commits === 1 ? '1 commit' : `${commits} commits`} on ${w.branch} ${commits === 1 ? "isn't" : "aren't"} on ${MAIN}` });
  const status = await git(w.path, ['status', '--porcelain', '--untracked-files=all']);
  const files = status.ok ? status.stdout.split('\n').filter((l) => l.trim()).length : 0;
  if (files > 0) out.push({ kind: 'uncommitted', text: `${files === 1 ? '1 file' : `${files} files`} in its worktree ${files === 1 ? "isn't" : "aren't"} committed` });
  return out;
}

// A thread this one started that hasn't finished: still working, or
// waiting on Mike. Hibernating or done ones aren't open business here.
export type ChildThread = { id: string; title: string; working: boolean; needsYou: boolean };

export function childLooseEnds(children: ChildThread[]): LooseEnd[] {
  const out: LooseEnd[] = [];
  for (const c of children) {
    if (c.working) out.push({ kind: 'thread', threadId: c.id, text: `"${c.title}", a thread it started, is still working` });
    else if (c.needsYou) out.push({ kind: 'thread', threadId: c.id, text: `"${c.title}", a thread it started, is waiting for you` });
  }
  return out;
}

// A schedule that will message this thread again (a check-in it booked).
// Not a reason to keep it: an archived thread comes back when one runs.
// It's on the card so Mike knows archiving it doesn't lose the check-in.
export function scheduleLooseEnds(threadId: string, schedules: Schedule[]): LooseEnd[] {
  return schedules
    .filter((s) => s.threadId === threadId && !s.paused && s.nextRunAt)
    .sort((a, b) => (a.nextRunAt! < b.nextRunAt! ? -1 : 1))
    .slice(0, 3)
    .map((s) => ({ kind: 'scheduled' as const, text: s.title, at: s.nextRunAt }));
}

// Whether any of them should stop a plain Archive: a booked check-in doesn't.
export function anyOpen(ends: LooseEnd[]): boolean {
  return ends.some((e) => e.kind !== 'scheduled');
}
