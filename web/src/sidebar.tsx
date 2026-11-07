// The sidebar, working as the Mac's: Starred, Inbox, Running, Hibernating and
// Archived under headings that fold and say how many, a search that cuts every
// section down, a sort on the Inbox heading, and the arrow keys through the
// rows. Which rows go where is sections.ts. On top of the Mac's: a filter
// beside the search, and every heading shows its number, folded or not (Mike
// asked for numbers on them, 5 Nov; the Mac only shows it folded).
import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode, type RefObject } from 'react';
import { useQuery } from 'convex/react';
import { useLiveQuery } from './live';
import { useInbox } from './inbox';
import { api } from '../../convex/_generated/api';
import { go, threadPath } from './route';
import { ago } from './format';
import { MenuChoice, Pop } from './menu';
import { wakeLine, ARCHIVE_FIRST, ARCHIVE_STEP, archived, archiveShown, build, clampWidth, hibernating, isFiltering, neighbour, NO_FILTER, passes, placeChoices, placesOf, readFolded, readOrder, readWidth, shows, SIDEBAR_DEFAULT, wakesOf, type Filter, type InboxOrder, type SectionKey } from './sections';
import * as Icon from './icons';

export type Row = NonNullable<ReturnType<typeof useQuery<typeof api.phone.threads>>>[number];

export const busy = (r: { status: string }) => r.status === 'running' || r.status === 'starting';

const FOLDED_KEY = 'threadbear.foldedSections';
const ORDER_KEY = 'threadbear.inboxOrder';
const WIDTH_KEY = 'threadbear.sidebarWidth';

const ORDERS: { order: InboxOrder; label: string; icon: ReactNode }[] = [
  { order: 'needsYou', label: 'Needs you first', icon: <Icon.Hand /> },
  { order: 'newest', label: 'Newest first', icon: <Icon.Down /> },
  { order: 'oldest', label: 'Oldest first', icon: <Icon.ArrowUp /> },
];

const SHOWS: { show: Filter['show']; label: string; icon: ReactNode }[] = [
  { show: 'all', label: 'All threads', icon: <Icon.Threads /> },
  { show: 'needsYou', label: 'Needs you', icon: <Icon.Hand /> },
  { show: 'unread', label: 'Unread', icon: <Icon.Unread /> },
  { show: 'shared', label: 'Shared by link', icon: <Icon.Link /> },
];

export function Lists({ token, selected, isNew }: { token: string; selected?: string; isNew?: boolean }) {
  const inbox = useInbox();
  const counts = useLiveQuery(api.phone.counts, { token });
  const schedules = useLiveQuery(api.phone.wakes, { token });
  const [folded, setFolded] = useState(() => readFolded(localStorage.getItem(FOLDED_KEY)));
  const [order, setOrder] = useState(() => readOrder(localStorage.getItem(ORDER_KEY)));
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<Filter>(NO_FILTER);
  const [archiveLimit, setArchiveLimit] = useState(ARCHIVE_FIRST);
  const nav = useRef<HTMLElement>(null);
  useTick();

  const q = query.trim();
  // Searching or filtering looks in the put-away threads too, so they're
  // loaded for it. Otherwise only while their heading is open.
  const narrowing = !!q || isFiltering(filter);
  const snoozed = useLiveQuery(api.phone.threads, narrowing || !folded.has('hibernating') ? { token, view: 'hibernating' } : 'skip');
  const den = useLiveQuery(api.phone.threads, narrowing || !folded.has('archived') ? { token, view: 'den' } : 'skip');
  // The den list stops at the newest 100; this finds the older ones.
  const sought = useDebounced(q, 250);
  const older = useLiveQuery(api.phone.search, sought ? { token, text: sought } : 'skip');

  // Keeps the open thread in view when the arrow keys or a link change it.
  useEffect(() => {
    nav.current?.querySelector('.row.on')?.scrollIntoView({ block: 'nearest' });
  }, [selected]);

  const toggle = (section: SectionKey) => {
    const next = new Set(folded);
    if (next.has(section)) next.delete(section);
    else next.add(section);
    setFolded(next);
    localStorage.setItem(FOLDED_KEY, JSON.stringify([...next]));
  };
  const pickOrder = (next: InboxOrder) => {
    setOrder(next);
    localStorage.setItem(ORDER_KEY, next);
  };

  const ready = inbox && schedules;
  const now = Date.now();
  const wakes = wakesOf(schedules ?? []);
  const split = build(inbox ?? [], now, wakes, order);
  // A thread can sit in two lists for a moment while the runner moves it, so
  // the first one drawn has it.
  const seen = new Set<string>();
  const keep = (rows: Row[]) => rows.filter((r) => shows(r, q, filter, selected) && !seen.has(r.threadId) && seen.add(r.threadId));
  const starred = keep(split.starred);
  const inInbox = keep(split.inbox);
  const running = keep(split.running);
  const asleep = hibernating(keep(split.scheduled), keep(snoozed ?? []), wakes);
  const put = keep(archived(den ?? []));
  // Convex matched these on whole words, so they aren't searched again.
  const allArchived = [...put, ...(older ?? []).filter((r) => passes(r, filter) && !seen.has(r.threadId) && seen.add(r.threadId))];
  const archive = archiveShown(allArchived, archiveLimit, narrowing, selected);

  const count: Record<SectionKey, number> = {
    starred: starred.length,
    inbox: inInbox.length,
    running: running.length,
    // Folded and not narrowing, the backend's count stands in for a list
    // that isn't loaded, plus the scheduled ones it doesn't count.
    hibernating: snoozed ? asleep.length : (counts?.hibernating ?? 0) + asleep.length,
    archived: narrowing ? allArchived.length : (counts?.den ?? allArchived.length),
  };
  const rows: Record<SectionKey, Row[]> = { starred, inbox: inInbox, running, hibernating: asleep, archived: archive.rows };
  const isOpen = (s: SectionKey) => narrowing || !folded.has(s);
  const drawn = (['starred', 'inbox', 'running', 'hibernating', 'archived'] as SectionKey[]).filter(isOpen).flatMap((s) => rows[s].map((r) => r.threadId));
  const settling = narrowing && (!snoozed || !den || (!!q && (q !== sought || !older)));
  const nothing = narrowing && !settling && drawn.length === 0;

  // Up and down move through the rows, as on the Mac, from the search box or
  // the list, but not while a menu is open under the focus.
  const onKeyDown = (e: ReactKeyboardEvent) => {
    if ((e.key !== 'ArrowDown' && e.key !== 'ArrowUp') || (e.target as HTMLElement).closest('.pop')) return;
    e.preventDefault();
    const next = neighbour(drawn, selected, e.key === 'ArrowDown' ? 1 : -1);
    if (next) go(threadPath(next));
  };

  const section = (key: SectionKey, title: string, icon: ReactNode, accessory?: ReactNode, after?: ReactNode) => (
    <>
      <Heading icon={icon} title={title} count={count[key]} collapsed={!isOpen(key)} toggle={narrowing ? undefined : () => toggle(key)} accessory={accessory} />
      {isOpen(key) ? (
        <>
          {rows[key].length ? <Rows rows={rows[key]} selected={selected} focusList={() => nav.current?.focus({ preventScroll: true })} /> : null}
          {after}
        </>
      ) : null}
    </>
  );

  return (
    <div className="lists-wrap" onKeyDown={onKeyDown}>
      <div className="search-row">
        <SearchBox value={query} onChange={setQuery} />
        <FilterMenu filter={filter} setFilter={setFilter} rows={[...(inbox ?? []), ...(snoozed ?? []), ...(den ?? [])]} />
        <a
          className={`icon-btn ${isNew ? 'lit-btn' : ''}`}
          href="/new"
          title="Start a new thread"
          aria-label="Start a new thread"
          onClick={(e) => {
            e.preventDefault();
            go('/new');
          }}
        >
          <Icon.Pencil />
        </a>
      </div>
      {!ready ? (
        <div className="lists muted pad">Loading…</div>
      ) : (
        <nav className="lists" ref={nav} tabIndex={-1}>
          {nothing ? <div className="list note">No threads match.</div> : null}
          {count.starred > 0 ? section('starred', 'Starred', <Icon.Star />) : null}
          {count.inbox > 0 || !narrowing ? section('inbox', 'Inbox', <Icon.Inbox />, <OrderMenu order={order} pick={pickOrder} />, count.inbox === 0 ? <div className="list note">Nothing waiting.</div> : null) : null}
          {count.running > 0 ? section('running', 'Running', <Icon.Bolt />) : null}
          {count.hibernating > 0 ? section('hibernating', 'Hibernating', <Icon.Moon />, undefined, !snoozed ? <div className="list note">Loading…</div> : null) : null}
          {count.archived > 0
            ? section(
                'archived',
                'Archived',
                <Icon.Archive />,
                undefined,
                !den ? (
                  <div className="list note">Loading…</div>
                ) : archive.more > 0 ? (
                  <button className="more-row" title={`${archive.more} older archived ${archive.more === 1 ? 'thread' : 'threads'} not shown`} onClick={() => setArchiveLimit((n) => n + ARCHIVE_STEP)}>
                    <Icon.More />
                    Show {Math.min(archive.more, ARCHIVE_STEP)} more
                  </button>
                ) : !narrowing && (counts?.den ?? 0) > allArchived.length ? (
                  <div className="list note">Search finds the older ones.</div>
                ) : null,
              )
            : null}
          {settling && drawn.length === 0 ? <div className="list note">Searching…</div> : null}
        </nav>
      )}
    </div>
  );
}

function Heading({ icon, title, count, collapsed, toggle, accessory }: { icon: ReactNode; title: string; count: number; collapsed: boolean; toggle?: () => void; accessory?: ReactNode }) {
  const label = (
    <>
      {icon}
      <span className="section-title">{title}</span>
      <span className="rule" />
      {count > 0 ? <span className="count">{count}</span> : null}
      {toggle ? <Icon.ChevronDown /> : null}
    </>
  );
  return (
    <div className={`section-head ${collapsed ? 'folded' : ''}`}>
      {toggle ? (
        <button className="fold" onClick={toggle} aria-expanded={!collapsed} title={collapsed ? `Show ${title}` : `Hide ${title}`}>
          {label}
        </button>
      ) : (
        <div className="fold">{label}</div>
      )}
      {accessory}
    </div>
  );
}

function SearchBox({ value, onChange }: { value: string; onChange: (text: string) => void }) {
  return (
    <div className="search">
      <Icon.Search />
      <input
        type="text"
        value={value}
        placeholder="Search threads"
        aria-label="Search threads"
        spellCheck={false}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') onChange('');
        }}
      />
      {value ? (
        <button className="clear" title="Clear the search" aria-label="Clear the search" onClick={() => onChange('')}>
          <Icon.Close />
        </button>
      ) : null}
    </div>
  );
}

function FilterMenu({ filter, setFilter, rows }: { filter: Filter; setFilter: (f: Filter) => void; rows: Row[] }) {
  const places = placeChoices(rows);
  const on = isFiltering(filter);
  const words = [filter.show !== 'all' ? SHOWS.find((s) => s.show === filter.show)?.label : null, filter.place].filter(Boolean).join(', ');
  return (
    <Pop title={on ? `Filter: ${words}` : 'Filter threads'} icon={<Icon.Filter />} lit={on}>
      {(close) => (
        <>
          {SHOWS.map((s) => (
            <MenuChoice
              key={s.show}
              icon={s.icon}
              label={s.label}
              on={filter.show === s.show}
              pick={() => {
                setFilter({ ...filter, show: s.show });
                close();
              }}
            />
          ))}
          <hr />
          <MenuChoice
            icon={<Icon.Folder />}
            label="Every project"
            on={filter.place === undefined}
            pick={() => {
              setFilter({ show: filter.show });
              close();
            }}
          />
          <div className="menu-scroll">
            {places.map((p) => (
              <MenuChoice
                key={p.place}
                icon={<Icon.Folder />}
                label={p.place}
                note={p.count}
                on={filter.place === p.place}
                pick={() => {
                  setFilter({ ...filter, place: p.place });
                  close();
                }}
              />
            ))}
          </div>
        </>
      )}
    </Pop>
  );
}

function OrderMenu({ order, pick }: { order: InboxOrder; pick: (o: InboxOrder) => void }) {
  const current = ORDERS.find((o) => o.order === order)!;
  return (
    <Pop title={`Sort: ${current.label}`} icon={<Icon.Sort />} lit={order !== 'needsYou'}>
      {(close) =>
        ORDERS.map((o) => (
          <MenuChoice
            key={o.order}
            icon={o.icon}
            label={o.label}
            on={order === o.order}
            pick={() => {
              pick(o.order);
              close();
            }}
          />
        ))
      }
    </Pop>
  );
}

function Rows({ rows, selected, focusList }: { rows: Row[]; selected?: string; focusList: () => void }) {
  return (
    <ul className="list">
      {rows.map((r) => (
        <li key={r.threadId}>
          <a
            href={threadPath(r.threadId)}
            className={`row ${r.threadId === selected ? 'on' : ''} ${r.unread ? 'unread' : ''} ${r.needsYou ? 'needs' : ''}`}
            onClick={(e) => {
              if (e.metaKey || e.ctrlKey) return;
              e.preventDefault();
              // So the arrow keys carry on from here, as on the Mac.
              focusList();
              go(threadPath(r.threadId));
            }}
          >
            <span className="row-top">
              {r.needsYou ? <span className="mark needs" title="Needs you" /> : r.unread ? <span className="mark unread" title="Unread" /> : null}
              <span className="title">{r.title || 'Untitled'}</span>
              {r.share?.access === 'link' ? (
                <span className="shared" title="Shared by link">
                  <Icon.Link />
                </span>
              ) : null}
              <When row={r} />
            </span>
            {/* Its place, as on the Mac and the phone, with the last thing
                Mike said to it on hover. While it works, what it's doing. */}
            <span className="sub" title={r.asked ? `You: ${r.asked}` : undefined}>
              {r.working && busy(r) ? r.working : (wakeLine(r, placesOf(r), Date.now()) ?? placesOf(r).join(', '))}
            </span>
          </a>
        </li>
      ))}
    </ul>
  );
}

// The time at the right of a row, or the status instead of it, as the Mac.
function When({ row: r }: { row: Row }) {
  if (busy(r) && !r.needsYou) {
    return (
      <span className="when running" title="Working">
        <span className="spinner" />
      </span>
    );
  }
  if (r.status === 'error') return <span className="when failed">Failed</span>;
  return (
    <span className={`when ${r.needsYou ? 'waiting' : ''}`} title={r.needsYou ? 'Waiting for you' : undefined}>
      {ago(r.lastActivityMs)}
    </span>
  );
}

// ------------------------------------------------------------ width

export function useSidebarWidth() {
  return useState(() => readWidth(localStorage.getItem(WIDTH_KEY)));
}

// The strip on the sidebar's edge. A drag moves the shell's CSS variable
// directly and only tells React at the end: re-rendering the thread's Markdown
// on every pointer move made it lag behind the hand. The stylesheet clamps the
// variable too, for a window made narrower later.
export function ResizeHandle({ shell, width, setWidth }: { shell: RefObject<HTMLDivElement | null>; width: number; setWidth: (w: number) => void }) {
  const drag = useRef<{ x: number; from: number; to: number } | null>(null);
  // The width now, not as of the last render: a double-click's second press
  // can come before React has rendered the first's, and a drag starting from
  // that older width put the old width back.
  const latest = useRef(width);
  const show = (w: number) => shell.current?.style.setProperty('--sidebar-width', `${w}px`);
  const commit = (w: number) => {
    latest.current = w;
    setWidth(w);
    show(w);
    localStorage.setItem(WIDTH_KEY, String(w));
  };
  const current = () => clampWidth(latest.current, window.innerWidth);
  return (
    <div
      className="resize-handle"
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize the sidebar"
      aria-valuenow={clampWidth(width, window.innerWidth)}
      tabIndex={0}
      title="Drag to resize, double-click to reset"
      onPointerDown={(e) => {
        e.preventDefault();
        e.currentTarget.setPointerCapture(e.pointerId);
        drag.current = { x: e.clientX, from: current(), to: current() };
        document.documentElement.classList.add('resizing');
      }}
      onPointerMove={(e) => {
        if (!drag.current) return;
        drag.current.to = clampWidth(drag.current.from + e.clientX - drag.current.x, window.innerWidth);
        show(drag.current.to);
      }}
      onLostPointerCapture={() => {
        if (!drag.current) return;
        // A press with no drag (half a double-click) changes nothing.
        if (drag.current.to !== drag.current.from) commit(drag.current.to);
        drag.current = null;
        document.documentElement.classList.remove('resizing');
      }}
      onDoubleClick={() => commit(SIDEBAR_DEFAULT)}
      onKeyDown={(e) => {
        if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
        e.preventDefault();
        commit(clampWidth(current() + (e.key === 'ArrowRight' ? 16 : -16), window.innerWidth));
      }}
    />
  );
}

// ------------------------------------------------------------ bits

function useDebounced(value: string, ms: number): string {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setSettled(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  // Clearing takes effect at once, so no search runs for text that's gone.
  return value ? settled : '';
}

// Re-renders every half minute so "5m" stays honest between query updates.
function useTick() {
  const [, setNow] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);
}
