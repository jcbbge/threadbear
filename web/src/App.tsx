// Mike's own threads, signed in: the Mac app's window in a browser. The
// sidebar (sidebar.tsx) beside a thread with each finished turn folded to
// "Worked for 4m 12s" and its reply, and the agent's card of asks joined to
// the composer. A shared thread (/s/<slug>) is share.tsx.
import { Component, Fragment, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { useMutation, useQuery } from 'convex/react';
import { useLiveQuery } from './live';
import { InboxProvider, useInbox } from './inbox';
import { useTranscript } from './transcript';
import { ConvexError } from 'convex/values';
import { api } from '../../convex/_generated/api';
import type { Id } from '../../convex/_generated/dataModel';
import { go, threadPath, useRoute } from './route';
import { useToken } from './token';
import { MessageText, Pictures, picturesByRow, ToolRun, Worked, type PageMessage } from './messages';
import { ReplyButton } from './reply-button';
import { CommandState } from './command-state';
import { previewOf, ShareControl, SharePage } from './share';
import { busy, Lists, ResizeHandle, type Row, useSidebarWidth } from './sidebar';
import { Pop } from './menu';
import { pastedOf } from './picture-chips';
import { Rail } from './rail';
import { NewThread, ProjectPage, ProjectsList, RunnerPage, RunnersList, ScheduledList, SchedulePage, UsageList, UsagePage } from './pages';
import { duration, fold, splitTurns, type Item } from './turns';
import { folderName, sender } from './format';
import * as Icon from './icons';

type Approval = NonNullable<Row['pendingApproval']>;
type Ask = NonNullable<Row['asks']>[number];

export function App() {
  const token = useToken();
  const route = useRoute();
  // A shared thread is for anyone, signed in or not.
  if (route.page === 'share') return <SharePage key={route.slug} slug={route.slug} token={token} />;
  if (!token) return <SignIn />;
  // Keyed on the token so a fresh sign-in clears an earlier auth error.
  return (
    <Catch key={token}>
      <InboxProvider token={token}>
        <Shell token={token} route={route} />
      </InboxProvider>
    </Catch>
  );
}

// ------------------------------------------------------------ sign-in

function SignIn({ expired }: { expired?: boolean }) {
  return (
    <main className="signin">
      <img src="/icon.png" alt="" width={72} height={72} />
      <h1>Threadbear</h1>
      <p>{expired ? 'This browser’s sign-in has expired or been revoked.' : 'This browser isn’t signed in yet.'}</p>
      <p>On the Mac, open Threadbear, then Settings › Phone &amp; browser › Open signed in.</p>
      <p className="muted small">
        It opens this site in your browser, signed in. From a terminal instead, in the repo: <code>npm run web:sign-in</code> (add <code>-- --qr</code> for a code to scan on another device).
      </p>
    </main>
  );
}

// Auth and missing-thread errors from Convex land here rather than as a
// blank page.
class Catch extends Component<{ children: ReactNode }, { error: unknown }> {
  state = { error: null as unknown };
  static getDerivedStateFromError(error: unknown) {
    return { error };
  }
  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    const kind = error instanceof ConvexError ? (error.data as { kind?: string })?.kind : undefined;
    if (kind === 'auth') return <SignIn expired />;
    return (
      <main className="signin">
        <h1>{kind === 'notFound' ? 'No such thread' : 'Something went wrong'}</h1>
        <p className="muted">{kind === 'notFound' ? 'It may have been deleted, or the Mac hasn’t mirrored it yet.' : String(error)}</p>
        <p>
          <a
            href="/"
            onClick={(e) => {
              e.preventDefault();
              this.setState({ error: null });
              go('/');
            }}
          >
            Back to the threads
          </a>
        </p>
      </main>
    );
  }
}

// ------------------------------------------------------------ layout

function Shell({ token, route }: { token: string; route: ReturnType<typeof useRoute> }) {
  const selected = route.page === 'thread' ? route.threadId : undefined;
  const id = route.page === 'scheduled' || route.page === 'projects' || route.page === 'runners' || route.page === 'usage' ? route.id : undefined;
  const [width, setWidth] = useSidebarWidth();
  const shell = useRef<HTMLDivElement>(null);
  // On a phone there's one column: a list, or what's open from it.
  const open = !!selected || !!id || route.page === 'new';
  return (
    <div ref={shell} className={`shell ${open ? 'has-thread' : ''}`} style={{ '--sidebar-width': `${width}px` } as CSSProperties}>
      <Rail token={token} route={route} />
      <aside className="sidebar">
        {route.page === 'scheduled' ? (
          <ScheduledList token={token} selected={id} />
        ) : route.page === 'projects' ? (
          <ProjectsList token={token} selected={id} />
        ) : route.page === 'runners' ? (
          <RunnersList token={token} selected={id} />
        ) : route.page === 'usage' ? (
          <UsageList token={token} selected={id} />
        ) : (
          <Lists token={token} selected={selected} isNew={route.page === 'new'} />
        )}
        <ResizeHandle shell={shell} width={width} setWidth={setWidth} />
      </aside>
      <main className="main">
        {selected ? (
          <ThreadView key={selected} token={token} threadId={selected} />
        ) : route.page === 'new' ? (
          <NewThread token={token} />
        ) : route.page === 'scheduled' && id ? (
          <SchedulePage key={id} token={token} id={id} />
        ) : route.page === 'projects' && id ? (
          <ProjectPage key={id} token={token} id={id} />
        ) : route.page === 'runners' && id ? (
          <RunnerPage key={id} token={token} id={id} />
        ) : route.page === 'usage' && id ? (
          <UsagePage key={id} token={token} id={id} />
        ) : (
          <Empty text={route.page === 'scheduled' ? 'Pick a schedule.' : route.page === 'projects' ? 'Pick a project.' : route.page === 'runners' ? 'Pick a runner.' : route.page === 'usage' ? 'Pick a login.' : 'Pick a thread.'} />
        )}
      </main>
    </div>
  );
}

function Empty({ text }: { text: string }) {
  return (
    <div className="empty">
      <img src="/icon.png" alt="" width={88} height={88} />
      <p>{text}</p>
    </div>
  );
}

// ------------------------------------------------------------ thread

function ThreadView({ token, threadId }: { token: string; threadId: string }) {
  const t = useLiveQuery(api.phone.threadRow, { token, threadId });
  const shown = useTranscript(token, threadId);
  // For thread: links, as agents may give only the start of an id.
  const inbox = useInbox();
  const update = useMutation(api.phone.update);
  const [pending, setPending] = useState<Id<'commands'> | null>(null);
  const bottom = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const keepFromBottom = useRef<number | null>(null);
  const seen = useRef(false);
  const lastSeq = shown?.messages.at(-1)?.seq;
  useEffect(() => {
    bottom.current?.scrollIntoView({ block: 'end' });
  }, [lastSeq, t?.status]);
  // After loading earlier messages, stay where you were rather than jumping.
  useEffect(() => {
    const el = list.current;
    if (!el || keepFromBottom.current === null) return;
    el.scrollTop = el.scrollHeight - keepFromBottom.current;
    keepFromBottom.current = null;
  }, [shown?.messages.length]);

  // Opening a thread here counts as reading it, like opening it on the Mac.
  useEffect(() => {
    if (!t || seen.current) return;
    seen.current = true;
    if (t.unread || t.needsYou) void update({ token, threadId, change: { markSeen: true } });
  }, [t, token, threadId, update]);

  useEffect(() => {
    if (t) document.title = `${t.title || 'Untitled'} · Threadbear`;
    return () => {
      document.title = 'Threadbear';
    };
  }, [t?.title]);

  const messages = (shown?.messages ?? []) as PageMessage[];
  const items = useMemo(() => fold(messages, t ? busy(t) : false), [messages, t?.status]);
  if (!shown || !t) return <div className="pad muted">Loading…</div>;

  const pictures = shown.images ?? [];
  const inText = new Map(pictures.filter((p) => p.src).map((p) => [p.src!, p.url]));
  const after = picturesByRow(messages, pictures);
  const linkTo = (id: string) => threadPath(inbox?.find((r) => r.threadId.startsWith(id))?.threadId ?? id);
  const act = async (change: Parameters<typeof update>[0]['change']) => setPending(await update({ token, threadId, change }));

  // The meta line under the last reply: how long its turn took and what the
  // thread has cost, as on the Mac.
  const lastTurn = splitTurns(messages).at(-1);
  const lastReply = [...items].reverse().find((i) => i.kind === 'message');
  const meta = !busy(t) && lastReply?.kind === 'message' && lastReply.m.role === 'assistant' ? [lastTurn?.ms && lastTurn.ms >= 1000 ? duration(lastTurn.ms) : null, t.costUsd ? `$${t.costUsd.toFixed(2)}` : null].filter(Boolean).join(' · ') : '';

  // A reply's [title](button:<id>) links, drawn from the row's buttons. An id
  // the row doesn't carry (an older runner, a button the thread no longer
  // keeps) is just its title.
  const buttonFor = (m: PageMessage) => (id: string, title: ReactNode) => {
    const b = m.buttons?.find((x) => x.id === id);
    return b ? <ReplyButton key={id} token={token} threadId={threadId} button={b} title={title} threadPath={linkTo} /> : <>{title}</>;
  };

  const renderItem = (item: Item<PageMessage>): ReactNode => {
    if (item.kind === 'worked') {
      return (
        <Worked key={`w${item.key}`} ms={item.ms}>
          {item.items.map((w) => (w.kind === 'tools' ? <ToolRun key={w.items[0]!.seq} items={w.items} open source={{ token, threadId }} /> : renderItem(w)))}
        </Worked>
      );
    }
    if (item.kind === 'tools') {
      return (
        <div key={item.items[0]!.seq}>
          <ToolRun items={item.items} source={{ token, threadId }} />
          <Pictures items={item.items.flatMap((m) => after.get(m.seq) ?? [])} />
        </div>
      );
    }
    const m = item.m;
    const from = sender(m);
    return (
      <div key={m.seq} className={`msg ${m.role}`}>
        {from ? <div className="origin">{from.who}</div> : m.role === 'user' && m.origin && m.origin !== 'user' && m.origin !== 'phone' ? <div className="origin">{originLabel(m.origin)}</div> : null}
        {from ? <MessageText text={from.body} pictures={inText} seq={m.seq} rows={messages} threadPath={linkTo} /> : <MessageText text={m.text} pictures={inText} seq={m.seq} rows={messages} threadPath={linkTo} pictureChips={m.role === 'user'} pasted={m.role === 'user' ? pastedOf(pictures, m.seq, m.text).byNumber : undefined} button={m.role === 'assistant' ? buttonFor(m) : undefined} />}
        <Pictures items={[...(after.get(m.seq) ?? []), ...(m.role === 'user' ? pastedOf(pictures, m.seq, m.text).unplaced : [])]} />
      </div>
    );
  };

  return (
    <article className="thread">
      <header className="thread-head">
        <button className="icon-btn back" onClick={() => go('/')} aria-label="Back to the threads" title="Back to the threads">
          <Icon.Back />
        </button>
        <div className="crumbs" title={t.cwd}>
          <span className="folder">{folderName(t.cwd)}</span>
          <span className="sep">/</span>
          <h1>{t.title || 'Untitled'}</h1>
        </div>
        <ShareControl token={token} threadId={threadId} share={t.share} preview={previewOf(t.title, messages, pictures.filter((p) => !p.src?.startsWith('picture:')))} />
        <MoreMenu
          items={[
            { label: 'Copy link', icon: <Icon.Link />, run: () => void navigator.clipboard.writeText(location.origin + location.pathname) },
            { label: t.starredAt ? 'Unstar' : 'Star', icon: t.starredAt ? <Icon.StarOff /> : <Icon.Star />, run: () => void act({ star: !t.starredAt }) },
            t.view === 'hibernating' || t.snoozedUntil ? { label: 'Wake', icon: <Icon.Sun />, run: () => void act({ wake: true }) } : t.view === 'inbox' ? { label: 'Hibernate', icon: <Icon.Moon />, run: () => void act({ snooze: { untilRestart: true } }) } : null,
            t.view === 'den' ? { label: 'Bring back', icon: <Icon.Inbox />, run: () => void act({ unarchive: true }) } : { label: 'Archive', icon: <Icon.Archive />, run: () => void act({ archive: true }) },
          ]}
        />
      </header>

      <div className="messages" ref={list}>
        {shown.hasMore ? (
          <button
            className="btn earlier"
            disabled={shown.loadingMore}
            onClick={() => {
              const el = list.current;
              keepFromBottom.current = el ? el.scrollHeight - el.scrollTop : null;
              shown.loadMore();
            }}
          >
            {shown.loadingMore ? 'Loading…' : 'Load earlier messages'}
          </button>
        ) : null}
        {items.map(renderItem)}
        {meta ? <div className="meta">{meta}</div> : null}
        {busy(t) ? (
          <div className="working">
            <span className="spinner" /> {t.working || 'Working…'}
          </div>
        ) : t.status === 'error' ? (
          <div className="failed-note">The last turn failed. Send a message to try again.</div>
        ) : null}
        <div ref={bottom} />
      </div>

      <div className="dock">
        {pending ? <CommandState token={token} commandId={pending} onDone={() => setPending(null)} /> : null}
        <Dock token={token} thread={t} lastSeq={lastSeq} onSent={setPending} onArchive={() => void act({ archive: true })} />
      </div>
    </article>
  );
}

function MoreMenu({ items }: { items: ({ label: string; icon: ReactNode; run: () => void } | null)[] }) {
  return (
    <Pop title="More" icon={<Icon.More />}>
      {(close) =>
        items.map((i) =>
          i ? (
            <button
              key={i.label}
              onClick={() => {
                i.run();
                close();
              }}
            >
              {i.icon}
              {i.label}
            </button>
          ) : null,
        )
      }
    </Pop>
  );
}

// ------------------------------------------------------------ the dock

// What sits at the bottom, in one rounded box as on the Mac: an approval or
// question the CLI is waiting on, else the end_turn card of asks, else the
// done card's follow-ups, then the composer under it.
function Dock({ token, thread: t, lastSeq, onSent, onArchive }: { token: string; thread: Row; lastSeq?: number; onSent: (id: Id<'commands'>) => void; onArchive: () => void }) {
  const send = useMutation(api.phone.send);
  const [text, setText] = useState('');
  // Picks on the card of asks: ask index to choice index, for one card.
  const [picks, setPicks] = useState<{ card?: number; by: Record<number, number> }>({ by: {} });
  const [ticked, setTicked] = useState<{ seq?: number; set: Set<number> }>({ set: new Set() });
  const asks = !busy(t) && !t.pendingApproval ? (t.asks ?? []) : [];
  const by = picks.card === t.asksSeq ? picks.by : {};
  const done = !busy(t) && !t.needsYou && !t.pendingApproval && !asks.length && !t.archivedAt && !t.working && (t.next?.length ?? 0) > 0;
  const next = done ? (t.next ?? []) : [];
  const follow = ticked.seq === lastSeq ? [...ticked.set].sort().map((i) => next[i]).filter((x): x is string => !!x) : [];

  const submit = async () => {
    const answers = asks.flatMap((a, i) => (by[i] !== undefined && choices(a)[by[i]!] !== undefined ? [{ index: i, action: a.action, answer: choices(a)[by[i]!]! }] : []));
    const extra = text.trim();
    const body = follow.length ? followUpMessage(follow, extra) : answers.length ? answerMessage(asks.length, answers, extra) : extra;
    if (!body) return;
    setText('');
    setPicks({ by: {} });
    setTicked({ set: new Set() });
    onSent(await send({ token, threadId: t.threadId, text: body, ...(answers.length ? { answers: answers.map(({ action, answer }) => ({ action, answer })) } : {}) }));
  };

  const card = t.pendingApproval ? (
    <ApprovalCard token={token} threadId={t.threadId} approval={t.pendingApproval} onSent={onSent} />
  ) : asks.length ? (
    <section className="card">
      <h2>
        ✋ {asks.length === 1 ? 'Decision needed' : 'Decisions needed'}
      </h2>
      {asks.map((a, i) => (
        <Fragment key={i}>
          <div className="ask-q">
            <MessageText text={`${asks.length > 1 ? `${i + 1}. ` : ''}${a.action.replace(/\s*\n\s*/g, ' ').trim()}`} />
            {a.why?.trim() ? (
              <div className="ask-why">
                <MessageText text={a.why.trim()} />
              </div>
            ) : null}
          </div>
          {a.links?.length ? (
            <div className="ask-links">
              {a.links.map((l) => (
                <a key={l.url} className="btn primary" href={l.url} target="_blank" rel="noreferrer">
                  {l.title} ↗
                </a>
              ))}
            </div>
          ) : null}
          {choices(a).length ? (
            <div className="choices">
              {choices(a).map((c, n) => (
                <button key={n} className={`choice ${by[i] === n ? 'on' : ''}`} onClick={() => setPicks({ card: t.asksSeq, by: { ...by, [i]: by[i] === n ? -1 : n } })}>
                  <span className="radio" />
                  <span>
                    {c}
                    {a.suggested === n ? <span className="pick">my pick</span> : null}
                  </span>
                </button>
              ))}
            </div>
          ) : null}
        </Fragment>
      ))}
    </section>
  ) : next.length ? (
    <section className="card">
      <h2>
        Done
        <button className="btn plain" style={{ marginLeft: 'auto' }} onClick={onArchive}>
          Archive
        </button>
      </h2>
      <div className="choices">
        {next.map((n, i) => {
          const on = ticked.seq === lastSeq && ticked.set.has(i);
          return (
            <button
              key={i}
              className={`choice ${on ? 'on' : ''}`}
              onClick={() => {
                const set = new Set(ticked.seq === lastSeq ? ticked.set : []);
                if (on) set.delete(i);
                else set.add(i);
                setTicked({ seq: lastSeq, set });
              }}
            >
              <span className="radio check" />
              <span>{n}</span>
            </button>
          );
        })}
      </div>
    </section>
  ) : null;

  const ready = !!text.trim() || Object.values(by).some((n) => n >= 0) || follow.length > 0;
  return (
    <div className={`box ${t.pendingApproval || asks.length ? 'asking' : ''}`}>
      {card}
      <form
        className="composer"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <textarea
          value={text}
          rows={Math.min(10, Math.max(1, text.split('\n').length))}
          placeholder={busy(t) ? 'Steer the agent' : asks.length ? 'Reply, or pick above' : 'Reply'}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            // Return sends, Shift-Return is a new line, as on the Mac. On a
            // phone's keyboard Return is a new line and the button sends.
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing && !matchMedia('(pointer: coarse)').matches) {
              e.preventDefault();
              void submit();
            }
          }}
        />
        <div className="tools-row">
          <span className="grow" />
          <button className="send" disabled={!ready} aria-label="Send" title="Send">
            <Icon.Up />
          </button>
        </div>
      </form>
    </div>
  );
}

// What an ask offers: its options, else the reply it wants ("done").
function choices(a: Ask): string[] {
  if (a.options?.length) return a.options;
  return a.reply?.trim() ? [a.reply.trim()] : [];
}

// The message the Mac sends for picked asks (Decisions.message): each
// question then its answer, numbered when the card had several, then
// anything else typed.
function answerMessage(count: number, answers: { index: number; action: string; answer: string }[], extra: string): string {
  const parts = answers.map((a) => (count === 1 ? `${a.action}\n${a.answer}` : `${a.index + 1}. ${a.action}\n   ${a.answer.replace(/\n/g, '\n   ')}`));
  if (extra) parts.push(extra);
  return parts.join('\n\n');
}

// Ticked follow-ups (Decisions.followUpMessage): one on its own, several as
// a list, then anything else typed.
function followUpMessage(follow: string[], extra: string): string {
  let body = follow.length === 1 ? follow[0]! : follow.map((f) => `- ${f}`).join('\n');
  if (extra) body += `\n\n${extra}`;
  return body;
}

function ApprovalCard({ token, threadId, approval, onSent }: { token: string; threadId: string; approval: Approval; onSent: (id: Id<'commands'>) => void }) {
  const respond = useMutation(api.phone.respond);
  const answer = useMutation(api.phone.answer);
  const secret = useMutation(api.phone.secret);
  const [answers, setAnswers] = useState<Record<string, string[]>>({});

  if (approval.kind === 'approval') {
    const label = { allow: 'Allow', allowAlways: 'Always allow', deny: 'Deny' } as Record<string, string>;
    return (
      <section className="card">
        <h2>{approval.title || approval.name}</h2>
        {approval.inputSummary ? <pre className="approval-input">{approval.inputSummary}</pre> : null}
        <div className="ask-links">
          {approval.options.map((o) => (
            <button key={o} className={`btn ${o === 'allow' ? 'primary' : ''}`} onClick={async () => onSent(await respond({ token, threadId, approvalId: approval.approvalId, decision: o as 'allow' | 'allowAlways' | 'deny' }))}>
              {label[o] ?? o}
            </button>
          ))}
        </div>
      </section>
    );
  }

  if (approval.kind === 'secret') {
    // The browser doesn't take secrets (docs/protocol.md, "Secrets"): the
    // Mac app and the iPhone app do, the phone sealing it to the runner.
    return (
      <section className="card">
        <h2>{approval.label}</h2>
        <p>{approval.reason}</p>
        <p className="desc">Answer this in Threadbear on your Mac or iPhone.</p>
        <div className="ask-links">
          <button className="btn" onClick={async () => onSent(await secret({ token, threadId, approvalId: approval.approvalId, decline: true }))}>
            Decline
          </button>
        </div>
      </section>
    );
  }

  const ready = approval.questions.every((q) => answers[q.question]?.length);
  return (
    <section className="card">
      {approval.questions.map((q) => (
        <Fragment key={q.question}>
          <div className="ask-q">{q.question}</div>
          <div className="choices">
            {q.options.map((o) => {
              const chosen = answers[q.question]?.includes(o.label) ?? false;
              return (
                <button
                  key={o.label}
                  className={`choice ${chosen ? 'on' : ''}`}
                  onClick={() =>
                    setAnswers((a) => {
                      const cur = a[q.question] ?? [];
                      const next = q.multiSelect ? (chosen ? cur.filter((x) => x !== o.label) : [...cur, o.label]) : [o.label];
                      return { ...a, [q.question]: next };
                    })
                  }
                >
                  <span className={`radio ${q.multiSelect ? 'check' : ''}`} />
                  <span>
                    {o.label}
                    {o.description ? <span className="desc">{o.description}</span> : null}
                  </span>
                </button>
              );
            })}
          </div>
        </Fragment>
      ))}
      <div className="ask-links">
        <button
          className="btn primary"
          disabled={!ready}
          onClick={async () => {
            // Multi-select choices go in one comma-joined string, as the Mac app sends them.
            const flat = Object.fromEntries(Object.entries(answers).map(([k, v]) => [k, v.join(', ')]));
            onSent(await answer({ token, threadId, approvalId: approval.approvalId, answers: flat }));
          }}
        >
          Answer
        </button>
      </div>
    </section>
  );
}

// ------------------------------------------------------------ bits

function originLabel(origin: string): string {
  return origin === 'schedule' ? 'Scheduled' : origin === 'runner' ? 'From Threadbear' : origin === 'agent' ? 'From another thread' : origin;
}
