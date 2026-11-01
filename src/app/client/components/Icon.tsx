import type { ReactNode } from 'react';
const shapes: Record<string, ReactNode> = {
  plus: <path d="M12 5v14M5 12h14" />,
  search: (
    <>
      <circle cx="10.5" cy="10.5" r="6.5" />
      <path d="m16 16 4 4" />
    </>
  ),
  play: <path d="m8 5 11 7-11 7Z" />,
  close: <path d="m6 6 12 12M6 18 18 6" />,
  more: <path d="M5 12h.01M12 12h.01M19 12h.01" strokeWidth="3" />,
  pin: <path d="m9 3 6 0-1 6 4 4v2H6v-2l4-4-1-6ZM12 15v6" />,
  archive: <path d="M3 4h18v4H3zM5 8v12h14V8M9 12h6" />,
  unarchive: <path d="M3 4h18v4H3zM5 8v12h14V8m-9 4 4 4m0-4-4 4" />,
  folder: <path d="M3 7V5a1 1 0 0 1 1-1h5l2 3h9a1 1 0 0 1 1 1v11a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1Z" />,
  restore: <path d="M4 9a8 8 0 1 1 0 7M4 3v6h6" />,
  trash: <path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7M14 10v7" />,
  settings: (
    <>
      <path d="M9 3h6l1 3 3 1 2 5-2 5-3 1-1 3H9l-1-3-3-1-2-5 2-5 3-1Z" />
      <circle cx="12" cy="12" r="3" />
    </>
  ),
  theme: <path d="M20 14A8 8 0 0 1 10 4a8 8 0 1 0 10 10Z" />,
  sidebar: (
    <>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M9 4v16" />
    </>
  ),
  check: (
    <>
      <rect x="3" y="4" width="18" height="16" rx="3" />
      <path d="m8 12 3 3 5-6" />
    </>
  ),
  case: (
    <>
      <rect x="5" y="3" width="14" height="18" rx="2" />
      <path d="m8 9 1 1 2-2m2 1h3M8 15h8" />
    </>
  ),
  model: <path d="m12 3 2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5Z" />,
  chevron: <path d="m6 9 6 6 6-6" />,
  branch: (
    <>
      <circle cx="6" cy="5" r="2" />
      <circle cx="6" cy="19" r="2" />
      <circle cx="18" cy="5" r="2" />
      <path d="M6 7v10M18 7c0 6-12 3-12 10" />
    </>
  ),
  options: <path d="M4 7h16M4 17h16M8 4v6M16 14v6" />,
  run: <path d="M12 19V5m-5 5 5-5 5 5" />,
  replay: <path d="M4 10a8 8 0 1 1 1 8M4 4v6h6" />,
  browser: (
    <>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M3 9h18M7 6.5h.01M10 6.5h.01" />
    </>
  ),
  network: <path d="M3 12h4l3-7 4 14 3-7h4" />,
  download: <path d="M12 3v12m-4-4 4 4 4-4M4 16v4h16v-4" />,
  copy: (
    <>
      <rect x="8" y="8" width="12" height="12" rx="2" />
      <path d="M16 8V4H4v12h4" />
    </>
  ),
  pause: <path d="M8 5v14M16 5v14" />,
  shield: (
    <>
      <path d="m12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6Z" />
      <path d="m8 12 3 3 5-6" />
    </>
  ),
};
export function Icon({ name, className }: { name: string; className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {shapes[name]}
    </svg>
  );
}
