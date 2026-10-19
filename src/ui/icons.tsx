// Original icon set drawn for Planar (16×16, stroke based).
import type { ReactElement } from 'react';

const paths: Record<string, ReactElement> = {
  select: <path d="M3.5 2.5 12 8.2l-3.9.8 2.2 4.3-1.6.8-2.2-4.3-3 2.6z" fill="currentColor" stroke="none" />,
  hand: (
    <path d="M5 8V4.2a1 1 0 0 1 2 0V7.5m0-4a1 1 0 0 1 2 0v4m0-3a1 1 0 0 1 2 0v3.6m0-2a1 1 0 0 1 2 0V10a4.5 4.5 0 0 1-4.5 4.5H8.2A4 4 0 0 1 5 12.8L2.8 9.6a1 1 0 0 1 1.6-1.2L5 9.2" />
  ),
  frame: <path d="M5 1.5v13M11 1.5v13M1.5 5h13M1.5 11h13" />,
  rectangle: <rect x="2.5" y="3.5" width="11" height="9" rx="0.5" />,
  ellipse: <circle cx="8" cy="8" r="5.5" />,
  line: <path d="M3 13 13 3" />,
  pen: (
    <>
      <path d="M8 1.8 12 9l-4 5-4-5z" />
      <circle cx="8" cy="8.5" r="1" />
    </>
  ),
  text: <path d="M3 4V2.5h10V4M8 2.5v11M6 13.5h4" />,
  menu: <path d="M2.5 4.5h11M2.5 8h11M2.5 11.5h11" />,
  eye: (
    <>
      <path d="M1.5 8S4 3.5 8 3.5 14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8z" />
      <circle cx="8" cy="8" r="2" />
    </>
  ),
  eyeOff: <path d="M2 2l12 12M6.3 4A6.5 6.5 0 0 1 8 3.5C12 3.5 14.5 8 14.5 8a12 12 0 0 1-1.7 2.2M10.2 11.9A6 6 0 0 1 8 12.5C4 12.5 1.5 8 1.5 8a12 12 0 0 1 2.4-2.9" />,
  lock: (
    <>
      <rect x="3.5" y="7" width="9" height="6.5" rx="1" />
      <path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2" />
    </>
  ),
  unlock: (
    <>
      <rect x="3.5" y="7" width="9" height="6.5" rx="1" />
      <path d="M5.5 7V5a2.5 2.5 0 0 1 4.9-.7" />
    </>
  ),
  plus: <path d="M8 3v10M3 8h10" />,
  minus: <path d="M3 8h10" />,
  chevron: <path d="M6 4l4 4-4 4" />,
  group: (
    <>
      <rect x="2" y="2" width="12" height="12" rx="1" strokeDasharray="2 2" />
      <rect x="5" y="5" width="6" height="6" />
    </>
  ),
  vector: <path d="M2.5 12.5 6 4l4 6 3.5-6.5" />,
  page: <path d="M4 1.5h5.5L12.5 4.5v10H4zM9.5 1.5v3h3" />,
  alignLeft: <path d="M2.5 2v12M5 5h8M5 11h5" />,
  alignHCenter: <path d="M8 2v12M3.5 5h9M5 11h6" />,
  alignRight: <path d="M13.5 2v12M3 5h8M6 11h5" />,
  alignTop: <path d="M2 2.5h12M5 5v8M11 5v5" />,
  alignVCenter: <path d="M2 8h12M5 3.5v9M11 5v6" />,
  alignBottom: <path d="M2 13.5h12M5 3v8M11 6v5" />,
  textLeft: <path d="M2.5 4h11M2.5 8h7M2.5 12h9" />,
  textCenter: <path d="M2.5 4h11M4.5 8h7M3.5 12h9" />,
  textRight: <path d="M2.5 4h11M6.5 8h7M4.5 12h9" />,
  undo: <path d="M5 3 2 6l3 3M2.5 6H10a3.5 3.5 0 0 1 0 7H6" />,
  redo: <path d="M11 3l3 3-3 3M13.5 6H6a3.5 3.5 0 0 0 0 7h4" />,
  layoutH: (
    <>
      <rect x="2" y="4.5" width="3.5" height="7" rx="0.5" />
      <rect x="6.25" y="4.5" width="3.5" height="7" rx="0.5" />
      <rect x="10.5" y="4.5" width="3.5" height="7" rx="0.5" />
    </>
  ),
  layoutV: (
    <>
      <rect x="4.5" y="2" width="7" height="3.5" rx="0.5" />
      <rect x="4.5" y="6.25" width="7" height="3.5" rx="0.5" />
      <rect x="4.5" y="10.5" width="7" height="3.5" rx="0.5" />
    </>
  ),
  component: <path d="M8 1.8 10.2 4 8 6.2 5.8 4zM4 5.8 6.2 8 4 10.2 1.8 8zM12 5.8 14.2 8 12 10.2 9.8 8zM8 9.8l2.2 2.2L8 14.2 5.8 12z" />,
  instance: <path d="M8 1.5 14.5 8 8 14.5 1.5 8z" />,
  variable: <path d="M8 1.8 13.5 5v6L8 14.2 2.5 11V5z M8 1.8v6.2m0 0 5.5-3m-5.5 3-5.5-3M8 8v6.2" />,
  link: <path d="M6.5 9.5 9.5 6.5M7 4.5l1-1a2.8 2.8 0 0 1 4 4l-1 1M9 11.5l-1 1a2.8 2.8 0 0 1-4-4l1-1" />,
  target: (
    <>
      <circle cx="8" cy="8" r="5.5" />
      <circle cx="8" cy="8" r="2" />
    </>
  ),
  close: <path d="M4 4l8 8M12 4l-8 8" />,
  trash: <path d="M2.5 4h11M6 4V2.5h4V4M4 4l.7 9.5h6.6L12 4" />,
};

export type IconName = keyof typeof paths;

export function Icon({ name, size = 16 }: { name: IconName; size?: number }) {
  return (
    <svg
      className="icon"
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.25"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {paths[name]}
    </svg>
  );
}

export const NODE_ICONS: Record<string, IconName> = {
  frame: 'frame',
  component: 'component',
  componentSet: 'component',
  instance: 'instance',
  group: 'group',
  rectangle: 'rectangle',
  ellipse: 'ellipse',
  vector: 'vector',
  text: 'text',
  page: 'page',
};
