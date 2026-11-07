// Reply buttons (docs/protocol.md, "Reply buttons"): a reply's
// [title](button:<id>) link drawn as a button that starts a thread with a
// brief the agent wrote, or sends a message to a thread. The part with no
// React or Convex in it, so it can be tested alone:
// node --test web/src/reply-buttons.test.ts

// As a message row carries it (convex/schema.ts messageButton).
export type MessageButton = { id: string; title: string; kind: 'start' | 'send'; target?: string; pressedThreadId?: string; failed?: string };

// A press this page queued, as phone:command reports it.
export type PressCommand = { state: 'pending' | 'taken' | 'done' | 'failed'; note?: string; threadId?: string } | null | undefined;

export type ButtonLook =
  | { kind: 'ready'; tip: string }
  | { kind: 'pressing'; tip: string }
  | { kind: 'pressed'; threadId?: string; tip: string }
  | { kind: 'failed'; error: string; tip: string };

// What the button shows: the row's state, with this page's own press on top
// until the row catches up (a row outside the live tail never does).
// asked: a press was queued and phone:command hasn't answered yet.
export function buttonLook(b: MessageButton, command: PressCommand, asked: boolean): ButtonLook {
  const where = b.kind === 'start' ? `Starts a thread${b.target ? ` in ${b.target}` : ''}` : `Sends a message${b.target ? ` to "${b.target}"` : ''}`;
  if (b.pressedThreadId) return { kind: 'pressed', threadId: b.pressedThreadId, tip: b.kind === 'start' ? 'Pressed. Opens the thread it started.' : 'Pressed. Opens the thread it messaged.' };
  if (command?.state === 'done') return { kind: 'pressed', threadId: command.threadId, tip: 'Pressed.' };
  if (asked || command?.state === 'pending' || command?.state === 'taken') {
    return { kind: 'pressing', tip: command?.state === 'pending' ? 'Waiting for the Mac to pick this up' : 'Sent to the Mac' };
  }
  const error = command?.state === 'failed' ? command.note ?? 'unknown error' : b.failed;
  if (error) return { kind: 'failed', error, tip: `Didn't work: ${error}. Press to try again.` };
  return { kind: 'ready', tip: where };
}
