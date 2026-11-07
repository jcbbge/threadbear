// Line icons in the SF Symbols style the apps use, drawn here so the page
// needs no icon font. Each takes the text colour.
const base = { fill: 'none', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round', strokeLinejoin: 'round', viewBox: '0 0 16 16', 'aria-hidden': true } as const;

export const Share = () => (
  <svg {...base}>
    <path d="M8 10V2M5 4.5 8 1.6l3 2.9M5.5 7H4v7.5h8V7h-1.5" />
  </svg>
);
export const More = () => (
  <svg {...base} fill="currentColor" stroke="none">
    <circle cx="3.5" cy="8" r="1.3" />
    <circle cx="8" cy="8" r="1.3" />
    <circle cx="12.5" cy="8" r="1.3" />
  </svg>
);
export const Back = () => (
  <svg {...base}>
    <path d="M10 2.5 4.5 8l5.5 5.5" />
  </svg>
);
export const Up = () => (
  <svg {...base} strokeWidth={2}>
    <path d="M8 13.5v-11M3.5 7 8 2.5 12.5 7" />
  </svg>
);
export const Chevron = ({ className }: { className?: string }) => (
  <svg {...base} className={className}>
    <path d="m6 3.5 4.5 4.5L6 12.5" />
  </svg>
);
export const ChevronDown = () => (
  <svg {...base} width={12} height={12}>
    <path d="m3.5 6 4.5 4.5L12.5 6" />
  </svg>
);
export const Link = () => (
  <svg {...base}>
    <path d="M6.8 9.2a2.8 2.8 0 0 0 4 0l2.3-2.3a2.8 2.8 0 0 0-4-4L8.3 3.7M9.2 6.8a2.8 2.8 0 0 0-4 0L2.9 9.1a2.8 2.8 0 0 0 4 4l.8-.8" />
  </svg>
);
export const Inbox = () => (
  <svg {...base}>
    <path d="M1.8 9 3.6 3h8.8l1.8 6v4H1.8zM1.8 9h3.7l.8 1.6h3.4l.8-1.6h3.7" />
  </svg>
);
export const Bolt = () => (
  <svg {...base}>
    <path d="M9 1.5 3.5 9H8l-1 5.5L12.5 7H8z" />
  </svg>
);
export const Moon = () => (
  <svg {...base}>
    <path d="M13.5 9.6A6 6 0 0 1 6.4 2.5a6 6 0 1 0 7.1 7.1z" />
  </svg>
);
export const Archive = () => (
  <svg {...base}>
    <path d="M1.8 2.5h12.4v3H1.8zM2.8 5.5v8h10.4v-8M6.3 8.5h3.4" />
  </svg>
);
export const Sun = () => (
  <svg {...base}>
    <circle cx="8" cy="8" r="2.8" />
    <path d="M8 1.5v1.6M8 12.9v1.6M1.5 8h1.6M12.9 8h1.6M3.4 3.4l1.1 1.1M11.5 11.5l1.1 1.1M3.4 12.6l1.1-1.1M11.5 4.5l1.1-1.1" />
  </svg>
);
export const StarOff = () => (
  <svg {...base}>
    <path d="M6.6 5 8 1.8l1.9 3.9 4.3.6-2.5 2.4M11.4 11.4l.5 2.5L8 11.6l-3.8 2 .7-4.3-3.1-3 2.6-.4M2 2l12 12" />
  </svg>
);
export const Star = () => (
  <svg {...base}>
    <path d="m8 1.8 1.9 3.9 4.3.6-3.1 3 .7 4.3L8 11.6l-3.8 2 .7-4.3-3.1-3 4.3-.6z" />
  </svg>
);
export const Search = () => (
  <svg {...base}>
    <circle cx="7" cy="7" r="4.5" />
    <path d="m10.4 10.4 3.8 3.8" />
  </svg>
);
export const Close = () => (
  <svg {...base}>
    <path d="m4 4 8 8M12 4l-8 8" />
  </svg>
);
export const Filter = () => (
  <svg {...base}>
    <path d="M2 3.5h12M4.5 8h7M7 12.5h2" />
  </svg>
);
export const Sort = () => (
  <svg {...base}>
    <path d="M5 13V3M2.5 5.5 5 3l2.5 2.5M11 3v10M8.5 10.5 11 13l2.5-2.5" />
  </svg>
);
export const Down = () => (
  <svg {...base}>
    <path d="M8 2.5v11M3.5 9 8 13.5 12.5 9" />
  </svg>
);
export const ArrowUp = () => (
  <svg {...base}>
    <path d="M8 13.5v-11M3.5 7 8 2.5 12.5 7" />
  </svg>
);
export const Hand = () => (
  <svg {...base}>
    <path d="M5.5 8V3.2a1 1 0 0 1 2 0V7.5V2.3a1 1 0 0 1 2 0v5.2V3.3a1 1 0 0 1 2 0v6.2c0 3-1.8 5-4.3 5-1.8 0-2.800-.8-3.700-2.3L2.600 9.400c-.6-1 .8-1.900 1.500-1L5.5 10" />
  </svg>
);
export const Unread = () => (
  <svg {...base} fill="currentColor" stroke="none">
    <circle cx="8" cy="8" r="3.5" />
  </svg>
);
export const Threads = () => (
  <svg {...base}>
    <path d="M2.5 4h11M2.5 8h11M2.5 12h11" />
  </svg>
);
export const Folder = () => (
  <svg {...base}>
    <path d="M1.8 13V3h4.3l1.500 2h6.600v8z" />
  </svg>
);
export const Check = () => (
  <svg {...base} strokeWidth={2}>
    <path d="m3 8.5 3.3 3.3L13 4.7" />
  </svg>
);
export const Photo = () => (
  <svg {...base}>
    <path d="M2 3h12v10H2zM2 11l3.5-3.5L8 10l2.5-2.5L14 11" />
    <circle cx="5.5" cy="5.8" r=".8" />
  </svg>
);
export const Bubbles = () => (
  <svg {...base}>
    <path d="M2 3.5h9v6H5.5L3 11.5v-2H2zM12.5 6.5H14V12h-1v1.8L10.8 12H7" />
  </svg>
);
export const Clock = () => (
  <svg {...base}>
    <circle cx="8" cy="8" r="6" />
    <path d="M8 4.5V8l2.5 1.5" />
  </svg>
);
export const Stack = () => (
  <svg {...base}>
    <path d="m8 2 6 3-6 3-6-3zM2 8l6 3 6-3M2 11l6 3 6-3" />
  </svg>
);
export const Bars = () => (
  <svg {...base}>
    <path d="M2.5 13.5V9M6.2 13.5v-8M9.9 13.5V8M13.5 13.5v-11" />
  </svg>
);
export const Gear = () => (
  <svg {...base}>
    <circle cx="8" cy="8" r="2.2" />
    <path d="M8 1.8v2M8 12.2v2M1.8 8h2M12.2 8h2M3.6 3.6 5 5M11 11l1.4 1.4M3.6 12.4 5 11M11 5l1.4-1.4" />
  </svg>
);
export const Pencil = () => (
  <svg {...base}>
    <path d="M9 3H2.5v10.5H13V7M6.5 9.5l.5-2.5 6-5 1.5 1.5-5 6z" />
  </svg>
);
export const SignOut = () => (
  <svg {...base}>
    <path d="M6.5 2.5h-4v11h4M10 5l3 3-3 3M13 8H6" />
  </svg>
);
export const Globe = () => (
  <svg {...base}>
    <circle cx="8" cy="8" r="6" />
    <path d="M2 8h12M8 2c2 2 2.8 4 2.8 6S10 12 8 14c-2-2-2.8-4-2.8-6S6 4 8 2z" />
  </svg>
);
export const Server = () => (
  <svg {...base}>
    <path d="M2.5 2.5h11V7h-11zM2.5 9h11v4.5h-11zM5 4.75h.01M5 11.25h.01" />
  </svg>
);
export const Pause = () => (
  <svg {...base}>
    <path d="M5.5 3v10M10.5 3v10" />
  </svg>
);
export const Play = () => (
  <svg {...base}>
    <path d="M4.5 2.5 13 8l-8.5 5.5z" />
  </svg>
);
