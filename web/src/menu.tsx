// A small button with a menu under it: the thread's ..., the sidebar's sort
// and filter. A <details>, so it opens with no state of its own; this adds
// what <details> doesn't do, closing on a click outside or Escape.
import { useEffect, useRef, type ReactNode } from 'react';

export function Pop({ title, icon, lit, children }: { title: string; icon: ReactNode; lit?: boolean; children: (close: () => void) => ReactNode }) {
  const ref = useRef<HTMLDetailsElement>(null);
  const close = () => {
    if (ref.current) ref.current.open = false;
  };
  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) ref.current.open = false;
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && ref.current) ref.current.open = false;
    };
    window.addEventListener('click', onClick);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('click', onClick);
      window.removeEventListener('keydown', onKey);
    };
  }, []);
  return (
    <details className="pop" ref={ref}>
      <summary className={`icon-btn ${lit ? 'lit-btn' : ''}`} title={title} aria-label={title}>
        {icon}
      </summary>
      <div className="pop-panel menu">{children(close)}</div>
    </details>
  );
}

// A menu row that's one of a set: its icon, its words, and a tick on the one
// in force.
export function MenuChoice({ icon, label, note, on, pick }: { icon: ReactNode; label: string; note?: ReactNode; on: boolean; pick: () => void }) {
  return (
    <button className="menu-choice" role="menuitemradio" aria-checked={on} title={label} onClick={pick}>
      {icon}
      <span className="menu-label">{label}</span>
      {note !== undefined ? <span className="menu-note">{note}</span> : null}
      <span className="menu-tick">{on ? <Tick /> : null}</span>
    </button>
  );
}

function Tick() {
  return (
    <svg fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 16 16" aria-hidden="true">
      <path d="m3 8.5 3.3 3.3L13 4.7" />
    </svg>
  );
}
