// 内联 SVG 图标(统一 24x24 viewBox,currentColor 着色)

import type { SVGProps } from 'react';

type IconProps = SVGProps<SVGSVGElement>;

const base = {
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 2,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
};

export const IconPin = (p: IconProps) => (
  <svg {...base} {...p}>
    <path d="M12 21s-7-5.1-7-11a7 7 0 0 1 14 0c0 5.9-7 11-7 11z" />
    <circle cx="12" cy="10" r="2.6" />
  </svg>
);

export const IconCrosshair = (p: IconProps) => (
  <svg {...base} {...p}>
    <circle cx="12" cy="12" r="8" />
    <path d="M12 2v3M12 19v3M2 12h3M19 12h3" />
    <circle cx="12" cy="12" r="2.2" fill="currentColor" stroke="none" />
  </svg>
);

export const IconRoute = (p: IconProps) => (
  <svg {...base} {...p}>
    <circle cx="5.5" cy="18.5" r="2.5" />
    <circle cx="18.5" cy="5.5" r="2.5" />
    <path d="M8 18h6a4 4 0 0 0 0-8H10a4 4 0 0 1 0-8h6" strokeDasharray="0" />
  </svg>
);

export const IconPlay = (p: IconProps) => (
  <svg viewBox="0 0 24 24" fill="currentColor" stroke="none" {...p}>
    <path d="M8 5.6c0-.9 1-1.5 1.8-1L19 11a1.2 1.2 0 0 1 0 2l-9.2 6.4c-.8.5-1.8-.1-1.8-1V5.6z" />
  </svg>
);

export const IconPause = (p: IconProps) => (
  <svg viewBox="0 0 24 24" fill="currentColor" stroke="none" {...p}>
    <rect x="6" y="5" width="4" height="14" rx="1.4" />
    <rect x="14" y="5" width="4" height="14" rx="1.4" />
  </svg>
);

export const IconStop = (p: IconProps) => (
  <svg viewBox="0 0 24 24" fill="currentColor" stroke="none" {...p}>
    <rect x="6" y="6" width="12" height="12" rx="2.5" />
  </svg>
);

export const IconTrash = (p: IconProps) => (
  <svg {...base} {...p}>
    <path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a1.6 1.6 0 0 0 1.6 1.5h6.8A1.6 1.6 0 0 0 17 19l1-12M9 7V5a1.5 1.5 0 0 1 1.5-1.5h3A1.5 1.5 0 0 1 15 5v2" />
  </svg>
);

export const IconUndo = (p: IconProps) => (
  <svg {...base} {...p}>
    <path d="M9 14 4 9l5-5" />
    <path d="M4 9h10.5A5.5 5.5 0 0 1 20 14.5v0a5.5 5.5 0 0 1-5.5 5.5H11" />
  </svg>
);

export const IconUpload = (p: IconProps) => (
  <svg {...base} {...p}>
    <path d="M12 16V4M7 9l5-5 5 5" />
    <path d="M4 15v3.5A1.5 1.5 0 0 0 5.5 20h13a1.5 1.5 0 0 0 1.5-1.5V15" />
  </svg>
);

export const IconUsb = (p: IconProps) => (
  <svg {...base} {...p}>
    <circle cx="12" cy="20" r="2" />
    <path d="M12 18V6" />
    <path d="m8 9 4-5 4 5" />
    <path d="M12 12l-4 2v3" />
    <path d="M12 10l4 2v3" />
  </svg>
);

export const IconWifi = (p: IconProps) => (
  <svg {...base} {...p}>
    <path d="M2.5 9.5a14 14 0 0 1 19 0" />
    <path d="M6 13a9 9 0 0 1 12 0" />
    <path d="M9.5 16.5a4 4 0 0 1 5 0" />
    <circle cx="12" cy="20" r="1" fill="currentColor" stroke="none" />
  </svg>
);

export const IconBattery = (p: IconProps) => (
  <svg {...base} {...p}>
    <rect x="2.5" y="8" width="17" height="9" rx="2.4" />
    <path d="M22 11.5v2.5" />
  </svg>
);

export const IconRefresh = (p: IconProps) => (
  <svg {...base} {...p}>
    <path d="M20 12a8 8 0 1 1-2.5-5.8" />
    <path d="M20 3v4h-4" />
  </svg>
);

export const IconX = (p: IconProps) => (
  <svg {...base} {...p}>
    <path d="M6 6l12 12M18 6 6 18" />
  </svg>
);

export const IconCheck = (p: IconProps) => (
  <svg {...base} {...p}>
    <path d="m4.5 12.5 5 5 10-11" />
  </svg>
);

export const IconInfo = (p: IconProps) => (
  <svg {...base} {...p}>
    <circle cx="12" cy="12" r="9" />
    <path d="M12 11v5" />
    <circle cx="12" cy="7.6" r="0.9" fill="currentColor" stroke="none" />
  </svg>
);

export const IconAlert = (p: IconProps) => (
  <svg {...base} {...p}>
    <path d="M12 3 2.8 19h18.4L12 3z" />
    <path d="M12 9.5V14" />
    <circle cx="12" cy="16.8" r="0.9" fill="currentColor" stroke="none" />
  </svg>
);

export const IconLocate = (p: IconProps) => (
  <svg {...base} {...p}>
    <circle cx="12" cy="12" r="3.2" />
    <circle cx="12" cy="12" r="8" />
    <path d="M12 2v2.6M12 19.4V22M2 12h2.6M19.4 12H22" />
  </svg>
);

export const IconLayers = (p: IconProps) => (
  <svg {...base} {...p}>
    <path d="m12 3 9 5-9 5-9-5 9-5z" />
    <path d="m4.5 12.5 7.5 4.2 7.5-4.2" />
    <path d="m4.5 16.5 7.5 4.2 7.5-4.2" />
  </svg>
);

export const IconPower = (p: IconProps) => (
  <svg {...base} {...p}>
    <path d="M12 3v8" />
    <path d="M6.6 6.8a8 8 0 1 0 10.8 0" />
  </svg>
);

export const IconGauge = (p: IconProps) => (
  <svg {...base} {...p}>
    <path d="M4 17a8 8 0 1 1 16 0" />
    <path d="m12 14 3.5-4.5" />
    <circle cx="12" cy="15" r="1.6" fill="currentColor" stroke="none" />
  </svg>
);

export const IconMap = (p: IconProps) => (
  <svg {...base} {...p}>
    <path d="m9 4-6 3v13l6-3 6 3 6-3V4l-6 3-6-3z" />
    <path d="M9 4v13M15 7v13" />
  </svg>
);

export const IconTarget = (p: IconProps) => (
  <svg {...base} {...p}>
    <circle cx="12" cy="12" r="9" />
    <circle cx="12" cy="12" r="5" />
    <circle cx="12" cy="12" r="1.4" fill="currentColor" stroke="none" />
  </svg>
);
