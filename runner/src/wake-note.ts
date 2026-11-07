// What a hibernating thread waits for, in a few words, when it's more than
// a time: "\"Convex I/O\" finishes", "you talk about woodworking", "the
// runner updates". The phone and the website show it on the row (synced as
// wakeNote, sync.ts), and the agent tools say it; the Mac app builds its
// own from the same fields (WakeWords in Snooze.swift). A time alone gives
// nothing, as each client says a time in its own way.
import type { ThreadSummary } from './protocol.ts';
import { cutSafely } from './safe-cut.ts';

// Short enough for a row, and to keep a thread's synced row well under the
// backend's size cap however long the titles and conditions it names.
export const WAKE_NOTE_MAX = 160;

// `scrub`: what the sync takes secrets out with. The whole note is scrubbed
// and only then cut, as a cut first could leave half a secret no rule knows
// (Daybreak, 6 Nov: postgres://alice:password@host with the "@" past the cut
// kept the password). Without one (the agent tools, on the Mac), the cut still
// never lands inside a secret (safe-cut.ts).
export function wakeNote(t: Parameters<typeof longNote>[0], scrub?: (text: string) => string): string | undefined {
  const note = longNote(t);
  if (!note) return note;
  return cutSafely(scrub ? scrub(note) : note, WAKE_NOTE_MAX, '…');
}

function longNote(t: Pick<ThreadSummary, 'waitingOn' | 'wakeWhen' | 'snoozedUntil' | 'snoozedUntilRestart' | 'snoozedUntilRelease'>): string | undefined {
  if (!t.snoozedUntil) return undefined;
  const left = (t.waitingOn ?? []).filter((w) => !w.done);
  if (left.length) {
    if (left.every((w) => !w.until)) return `${left.map((w) => `"${w.title}"`).join(left.length === 2 ? ' and ' : ', ')} ${left.length === 1 ? 'finishes' : 'finish'}`;
    return left.map((w) => `"${w.title}" ${w.until ?? 'finishes'}`).join('; ');
  }
  if (t.wakeWhen?.topic) return `you talk about ${t.wakeWhen.topic}`;
  if (t.snoozedUntilRelease) return 'the runner updates';
  if (t.snoozedUntilRestart) return 'the runner restarts';
  return undefined;
}
