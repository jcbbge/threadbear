// A reply button on Mike's own thread page (reply-buttons.ts). A shared page
// never draws one: its links are just their titles (messages.tsx).
import { useState, type ReactNode } from 'react';
import { useMutation, useQuery } from 'convex/react';
import { api } from '../../convex/_generated/api';
import type { Id } from '../../convex/_generated/dataModel';
import { go } from './route';
import * as Icon from './icons';
import { buttonLook, type MessageButton } from './reply-buttons';

export function ReplyButton({ token, threadId, button, title, threadPath }: { token: string; threadId: string; button: MessageButton; title: ReactNode; threadPath: (id: string) => string }) {
  const press = useMutation(api.phone.press);
  const [commandId, setCommandId] = useState<Id<'commands'> | null>(null);
  // Between the click and phone:press answering, so a second click can't queue another.
  const [asking, setAsking] = useState(false);
  const [queueError, setQueueError] = useState<string | null>(null);
  const command = useQuery(api.phone.command, commandId ? { token, commandId } : 'skip');
  const look = queueError && !commandId ? { kind: 'failed' as const, error: queueError, tip: `Didn't work: ${queueError}. Press to try again.` } : buttonLook(button, command, asking || (commandId !== null && command === undefined));
  const onClick = async () => {
    if (look.kind === 'pressing') return;
    if (look.kind === 'pressed') {
      if (look.threadId) go(threadPath(look.threadId));
      return;
    }
    setAsking(true);
    setQueueError(null);
    try {
      setCommandId(await press({ token, threadId, buttonId: button.id }));
    } catch (e) {
      setCommandId(null);
      setQueueError(String((e as { data?: { message?: string } })?.data?.message ?? (e as Error)?.message ?? e));
    } finally {
      setAsking(false);
    }
  };
  return (
    <span className="reply-button-wrap">
      <button className={`reply-button rb-${button.kind} rb-${look.kind}`} disabled={look.kind === 'pressing' || (look.kind === 'pressed' && !look.threadId)} title={look.tip} onClick={() => void onClick()}>
        {look.kind === 'pressing' ? <span className="spinner" /> : look.kind === 'pressed' ? <Icon.Check /> : null}
        {/* The title the runner keeps, not the link's words: an agent can't
            label a button one thing and have it do another (Codex's review). */}
        <span>{button.title || title}</span>
      </button>
      {look.kind === 'failed' ? <span className="reply-button-error">{look.error}</span> : null}
    </span>
  );
}
