// SF Symbols-style glyphs drawn on a 24×24 grid with round caps, colored by currentColor.
import type { CSSProperties, ReactNode } from 'react'

interface IconDef {
  /** Default stroke width (SF "regular" ≈ 1.7, "semibold" ≈ 2.2). */
  weight: number
  body: ReactNode
}

const dot = (cx: number, cy: number, r = 1.25) => <circle key={`${cx}-${cy}`} cx={cx} cy={cy} r={r} fill="currentColor" stroke="none" />

function gearPath(): string {
  const teeth = 8
  const outer = 9.6
  const inner = 7.4
  const half = Math.PI / teeth
  const pts: string[] = []
  for (let i = 0; i < teeth; i++) {
    const a = (i * 2 * Math.PI) / teeth - Math.PI / 2
    const angles: Array<[number, number]> = [
      [a - half * 0.95, inner],
      [a - half * 0.42, outer],
      [a + half * 0.42, outer],
      [a + half * 0.95, inner],
    ]
    for (const [ang, r] of angles) pts.push(`${(12 + r * Math.cos(ang)).toFixed(2)} ${(12 + r * Math.sin(ang)).toFixed(2)}`)
  }
  return `M${pts.join(' L')} Z`
}

const ICONS = {
  chevronLeft: { weight: 2.4, body: <path d="M15 4.5 7.5 12l7.5 7.5" /> },
  chevronRight: { weight: 2.4, body: <path d="M9 4.5 16.5 12 9 19.5" /> },
  chevronDown: { weight: 2.4, body: <path d="M4.5 8.75 12 16.25l7.5-7.5" /> },
  plus: { weight: 2, body: <path d="M12 4.25v15.5M4.25 12h15.5" /> },
  minus: { weight: 2, body: <path d="M4.25 12h15.5" /> },
  xmark: { weight: 2, body: <path d="M6 6l12 12M18 6 6 18" /> },
  checkmark: { weight: 2.2, body: <path d="M4.75 12.75 9.5 17.5 19.25 6.5" /> },
  person: {
    weight: 1.7,
    body: (
      <>
        <circle cx="12" cy="8" r="3.75" />
        <path d="M4.75 20c0-3.75 3.2-6.25 7.25-6.25s7.25 2.5 7.25 6.25Z" />
      </>
    ),
  },
  person2: {
    weight: 1.7,
    body: (
      <>
        <circle cx="9" cy="8.25" r="3.25" />
        <path d="M2.75 19.5c0-3.4 2.75-5.6 6.25-5.6s6.25 2.2 6.25 5.6Z" />
        <circle cx="16.6" cy="7.6" r="2.6" />
        <path d="M16.6 13.15c2.75.15 4.65 2.05 4.65 4.75v1.6h-3.25" />
      </>
    ),
  },
  gear: {
    weight: 1.7,
    body: (
      <>
        <path d={gearPath()} />
        <circle cx="12" cy="12" r="3.1" />
      </>
    ),
  },
  bell: {
    weight: 1.7,
    body: (
      <>
        <path d="M12 3.5c-3.25 0-5.6 2.55-5.6 5.85v3.55c0 1.05-.45 2-1.2 2.8l-.65.7c-.5.55-.1 1.35.65 1.35h13.6c.75 0 1.15-.8.65-1.35l-.65-.7c-.75-.8-1.2-1.75-1.2-2.8V9.35c0-3.3-2.35-5.85-5.6-5.85Z" />
        <path d="M9.85 20.1a2.3 2.3 0 0 0 4.3 0" />
      </>
    ),
  },
  bellSlash: {
    weight: 1.7,
    body: (
      <>
        <path d="M7.1 6.2A5.9 5.9 0 0 0 6.4 9.35v3.55c0 1.05-.45 2-1.2 2.8l-.65.7c-.5.55-.1 1.35.65 1.35h10.6M17.6 13.9V9.35c0-3.3-2.35-5.85-5.6-5.85-1.35 0-2.55.45-3.5 1.2" />
        <path d="M9.85 20.1a2.3 2.3 0 0 0 4.3 0" />
        <path d="M3.75 3.75l16.5 16.5" />
      </>
    ),
  },
  lock: {
    weight: 1.7,
    body: (
      <>
        <rect x="5" y="10.25" width="14" height="10.5" rx="2.5" />
        <path d="M8.25 10.25V7.5a3.75 3.75 0 0 1 7.5 0v2.75" />
      </>
    ),
  },
  lockOpen: {
    weight: 1.7,
    body: (
      <>
        <rect x="3.25" y="10.25" width="13" height="10.5" rx="2.5" />
        <path d="M12.75 10.25V7a3.75 3.75 0 0 1 7.5 0v1.75" />
      </>
    ),
  },
  share: {
    weight: 1.7,
    body: (
      <>
        <path d="M12 3.25v11.5M8.25 7 12 3.25 15.75 7" />
        <path d="M8.75 10H7.25a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h9.5a2 2 0 0 0 2-2v-7a2 2 0 0 0-2-2h-1.5" />
      </>
    ),
  },
  ellipsis: { weight: 1.7, body: <>{[dot(5.5, 12, 1.65), dot(12, 12, 1.65), dot(18.5, 12, 1.65)]}</> },
  link: {
    weight: 1.8,
    body: (
      <>
        <path d="M10.1 13.9a4.1 4.1 0 0 0 5.8 0l3.1-3.1a4.1 4.1 0 1 0-5.8-5.8l-1.4 1.4" />
        <path d="M13.9 10.1a4.1 4.1 0 0 0-5.8 0L5 13.2A4.1 4.1 0 1 0 10.8 19l1.4-1.4" />
      </>
    ),
  },
  calendar: {
    weight: 1.7,
    body: (
      <>
        <rect x="3.5" y="4.75" width="17" height="15.75" rx="3.25" />
        <path d="M3.5 9.25h17M8 3v3.25M16 3v3.25" />
        {[dot(8, 13, 1.05), dot(12, 13, 1.05), dot(16, 13, 1.05), dot(8, 16.75, 1.05), dot(12, 16.75, 1.05)]}
      </>
    ),
  },
  trophy: {
    weight: 1.7,
    body: (
      <>
        <path d="M7.25 3.75h9.5v5.5a4.75 4.75 0 0 1-9.5 0Z" />
        <path d="M7.25 5.75h-2a.75.75 0 0 0-.75.85c.3 2.2 1.45 3.55 3.25 3.9M16.75 5.75h2c.45 0 .8.4.75.85-.3 2.2-1.45 3.55-3.25 3.9" />
        <path d="M12 14v3.25M8.75 20.25h6.5v-1.5a1.5 1.5 0 0 0-1.5-1.5h-3.5a1.5 1.5 0 0 0-1.5 1.5Z" />
      </>
    ),
  },
  flame: {
    weight: 1.7,
    body: (
      <>
        <path d="M12 21c-3.65 0-6.5-2.6-6.5-6.15 0-2.55 1.3-4.5 2.85-5.95.35 1.4 1.1 2.4 2.15 2.9-.25-3.05 1.05-6.05 3.65-8.3.45 3.6 4.35 5.7 4.35 11.25C18.5 18.35 15.65 21 12 21Z" />
        <path d="M12 21c-1.75 0-3-1.2-3-2.85 0-1.55 1.05-2.6 2.15-3.65.3.9.85 1.45 1.55 1.65.15-.85.65-1.65 1.3-2.2.65 1.05 1.25 2.15 1.25 3.85C15.25 19.65 13.9 21 12 21Z" />
      </>
    ),
  },
  clock: {
    weight: 1.7,
    body: (
      <>
        <circle cx="12" cy="12" r="8.75" />
        <path d="M12 6.75V12l3.5 2.25" />
      </>
    ),
  },
  arrowUpRight: { weight: 2, body: <path d="M6.75 17.25 17.25 6.75M8.25 6.75h9v9" /> },
  trash: {
    weight: 1.7,
    body: (
      <>
        <path d="M3.75 6.25h16.5M9 6.25V4.75c0-.7.55-1.25 1.25-1.25h3.5c.7 0 1.25.55 1.25 1.25v1.5" />
        <path d="M5.75 6.25l.95 12.45a2 2 0 0 0 2 1.8h6.6a2 2 0 0 0 2-1.8l.95-12.45" />
        <path d="M10 10.25v6.25M14 10.25v6.25" />
      </>
    ),
  },
  info: {
    weight: 1.7,
    body: (
      <>
        <circle cx="12" cy="12" r="8.75" />
        <path d="M12 10.75v5.75" />
        {dot(12, 7.75, 1.15)}
      </>
    ),
  },
  addToHomeScreen: {
    weight: 1.7,
    body: (
      <>
        <rect x="3.75" y="3.75" width="16.5" height="16.5" rx="4.25" />
        <path d="M12 8v8M8 12h8" />
      </>
    ),
  },
  copy: {
    weight: 1.7,
    body: (
      <>
        <rect x="8.25" y="8.25" width="12" height="12.5" rx="2.5" />
        <path d="M15.75 8.25V5.75a2.5 2.5 0 0 0-2.5-2.5h-7a2.5 2.5 0 0 0-2.5 2.5v7.5a2.5 2.5 0 0 0 2.5 2.5h2" />
      </>
    ),
  },
  envelope: {
    weight: 1.7,
    body: (
      <>
        <rect x="3" y="5.25" width="18" height="13.5" rx="2.75" />
        <path d="M3.75 6.75 12 13l8.25-6.25" />
      </>
    ),
  },
  signOut: {
    weight: 1.7,
    body: (
      <>
        <path d="M13.75 7.75V5.5a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2h5.75a2 2 0 0 0 2-2v-2.25" />
        <path d="M9.5 12h11M17.25 8.75 20.5 12l-3.25 3.25" />
      </>
    ),
  },
  listBullet: {
    weight: 1.8,
    body: (
      <>
        <path d="M9 6.5h11M9 12h11M9 17.5h11" />
        {[dot(4.75, 6.5, 1.35), dot(4.75, 12, 1.35), dot(4.75, 17.5, 1.35)]}
      </>
    ),
  },
  pencil: {
    weight: 1.7,
    body: (
      <>
        <path d="M15.6 4.65a2.1 2.1 0 0 1 2.95 0l.8.8a2.1 2.1 0 0 1 0 2.95L8.6 19.15l-4.35 1.1 1.1-4.35Z" />
        <path d="M14 6.25 17.75 10" />
      </>
    ),
  },
  sparkles: {
    weight: 1.6,
    body: (
      <>
        <path d="M10 3.5c.55 3.6 2.4 5.45 6 6-3.6.55-5.45 2.4-6 6-.55-3.6-2.4-5.45-6-6 3.6-.55 5.45-2.4 6-6Z" />
        <path d="M17.5 14c.3 1.85 1.15 2.7 3 3-1.85.3-2.7 1.15-3 3-.3-1.85-1.15-2.7-3-3 1.85-.3 2.7-1.15 3-3Z" />
      </>
    ),
  },
  halfCircle: {
    weight: 1.8,
    body: (
      <>
        <circle cx="12" cy="12" r="8.25" />
        <path d="M12 3.75a8.25 8.25 0 0 0 0 16.5Z" fill="currentColor" stroke="none" />
      </>
    ),
  },
  xmarkCircleFill: {
    weight: 1.8,
    body: (
      <>
        <circle cx="12" cy="12" r="9.5" fill="currentColor" stroke="none" />
        <path d="M8.75 8.75l6.5 6.5M15.25 8.75l-6.5 6.5" stroke="var(--icon-knockout, #fff)" strokeWidth="1.9" />
      </>
    ),
  },
  checkmarkCircleFill: {
    weight: 1.8,
    body: (
      <>
        <circle cx="12" cy="12" r="9.5" fill="currentColor" stroke="none" />
        <path d="M7.75 12.25l2.9 2.9 5.6-6.3" stroke="var(--icon-knockout, #fff)" strokeWidth="2" />
      </>
    ),
  },
  chevronUp: { weight: 2.4, body: <path d="M4.5 15.25 12 7.75l7.5 7.5" /> },
  arrowUp: { weight: 2, body: <path d="M12 19.5V4.75M6 10.5l6-6 6 6" /> },
  arrowDown: { weight: 2, body: <path d="M12 4.5v14.75M6 13.5l6 6 6-6" /> },
  plusCircle: {
    weight: 1.7,
    body: (
      <>
        <circle cx="12" cy="12" r="8.75" />
        <path d="M12 7.75v8.5M7.75 12h8.5" />
      </>
    ),
  },
  minusCircle: {
    weight: 1.7,
    body: (
      <>
        <circle cx="12" cy="12" r="8.75" />
        <path d="M7.75 12h8.5" />
      </>
    ),
  },
  /** Spaces tab: stacked cards. */
  squareStack: {
    weight: 1.7,
    body: (
      <>
        <rect x="3.75" y="8.25" width="16.5" height="12" rx="3" />
        <path d="M6.25 5.25h11.5M8.5 2.75h7" />
      </>
    ),
  },
  /** Overview tab. */
  chartBar: {
    weight: 1.7,
    body: (
      <>
        <rect x="3.75" y="12.5" width="4" height="7.75" rx="1.25" />
        <rect x="10" y="7.5" width="4" height="12.75" rx="1.25" />
        <rect x="16.25" y="3.75" width="4" height="16.5" rx="1.25" />
      </>
    ),
  },
  /** Goals tab. */
  target: {
    weight: 1.7,
    body: (
      <>
        <circle cx="12" cy="12" r="8.75" />
        <circle cx="12" cy="12" r="5.25" />
        {dot(12, 12, 1.75)}
      </>
    ),
  },
  /** Money, revenue. */
  banknote: {
    weight: 1.7,
    body: (
      <>
        <rect x="2.75" y="6.25" width="18.5" height="11.5" rx="2.5" />
        <circle cx="12" cy="12" r="2.75" />
        {/* Dots, not bars: at badge sizes bars beside the circle read as "IOI". */}
        {[dot(6.5, 12, 1.05), dot(17.5, 12, 1.05)]}
      </>
    ),
  },
  /** A task with steps (list.bullet.indent). */
  listIndent: {
    weight: 1.8,
    body: (
      <>
        {[dot(4.75, 6, 1.35), dot(9.25, 12, 1.35), dot(9.25, 18, 1.35)]}
        <path d="M8.5 6h11.25M13 12h6.75M13 18h6.75" />
      </>
    ),
  },
  /** Spending (bag). */
  bag: {
    weight: 1.7,
    body: (
      <>
        <path d="M5.25 8.25h13.5l-.9 10.6a2 2 0 0 1-2 1.85h-7.7a2 2 0 0 1-2-1.85Z" />
        <path d="M8.75 10.5V7a3.25 3.25 0 0 1 6.5 0v3.5" />
      </>
    ),
  },
  /** Help (questionmark). */
  questionmark: {
    weight: 2,
    body: (
      <>
        <path d="M7.9 8.4c0-2.85 1.8-4.85 4.2-4.85 2.35 0 4.1 1.75 4.1 4.05 0 1.85-1 2.9-2.4 3.85-1.15.8-1.8 1.6-1.8 3.05v.85" />
        {dot(12, 19.6, 1.45)}
      </>
    ),
  },
} satisfies Record<string, IconDef>

export type IconName = keyof typeof ICONS
export const iconNames = Object.keys(ICONS) as IconName[]

export interface IconProps {
  name: IconName
  /** Rendered size in px (square). Default 22. */
  size?: number
  /** Stroke width on the 24px grid; defaults to the glyph's SF-like weight. */
  weight?: number
  /** Accessible label. Without it the icon is decorative (aria-hidden). */
  title?: string
  className?: string
  style?: CSSProperties
}

export function Icon({ name, size = 22, weight, title, className, style }: IconProps) {
  const def: IconDef = ICONS[name]
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={weight ?? def.weight}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className ? `ui-icon ${className}` : 'ui-icon'}
      style={style}
      role={title ? 'img' : undefined}
      aria-label={title}
      aria-hidden={title ? undefined : true}
      focusable="false"
    >
      {def.body}
    </svg>
  )
}
