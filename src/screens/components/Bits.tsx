// Small presentational pieces shared by several screens.
import { useId } from 'react'
import type { ReactNode } from 'react'
import { ActivityIndicator, Icon, ScoreRing, cx } from '../../ui/index.ts'
import { formatScore } from './format.ts'

export { formatScore } from './format.ts'
export { markLabel } from './marks.ts'

export function ErrorText({ children }: { children: ReactNode }) {
  return (
    <span className="c-red" role="alert">
      {children}
    </span>
  )
}

/** Centered spinner that only appears after a beat, so fast loads don't flash. */
export function Loading({ label = 'Loading' }: { label?: string }) {
  return (
    <div className="s-loading">
      <ActivityIndicator size="large" color="var(--secondary-label)" label={label} />
    </div>
  )
}

/** Read-only check-off state for someone else's task. */
export function CheckDot({ done, label }: { done: boolean; label?: string }) {
  return (
    <span className={cx('s-dot', done && 's-dot--done')} role="img" aria-label={label ?? (done ? 'Checked off' : 'Not checked off')}>
      {done && <Icon name="checkmark" size={13} weight={3} />}
    </span>
  )
}

/** A task's final mark: full, half or none (averages round to the nearest of the three). */
export function MarkGlyph({ mark }: { mark: number }) {
  const kind = mark >= 0.75 ? 'done' : mark >= 0.25 ? 'half' : 'none'
  return (
    <span className={cx('s-mark', `s-mark--${kind}`)} role="img" aria-label={`${Math.round(mark * 100)} percent`}>
      <Icon name={kind === 'done' ? 'checkmark' : kind === 'half' ? 'halfCircle' : 'xmark'} size={kind === 'half' ? 16 : 13} weight={kind === 'half' ? 1.8 : 3} />
    </span>
  )
}

/** Small score ring with the number beside it, for list rows. A provisional value stays graphite. */
export function MiniScore({ value, threshold = 90, caption, iridescent = true }: { value: number | null; threshold?: number; caption?: string; iridescent?: boolean }) {
  return (
    <span className="s-mini-score">
      <span className="s-mini-score__text">
        <span className="s-mini-score__value t-tabular">{value == null ? '—' : formatScore(value)}</span>
        {caption && <span className="s-mini-score__caption">{caption}</span>}
      </span>
      <ScoreRing key={value == null ? 'empty' : 'score'} value={value} threshold={threshold} iridescent={iridescent} size={40} stroke={5} aria-label={value == null ? 'No score' : formatScore(value)} />
    </span>
  )
}

/** UIKit's continuous corner (top right, clockwise), as [inset from the right edge, down from the top] in corner radii. */
const CORNER: Array<Array<[number, number]>> = [
  [[1.08849323, 0], [0.86840689, 0.02221656], [0.66993427, 0.065496]],
  [[0.63149399, 0.074911]],
  [[0.37282392, 0.16905899], [0.16905899, 0.37282392], [0.074911, 0.63149399]],
  [[0.065496, 0.66993427]],
  [[0.02221656, 0.86840689], [0, 1.08849323], [0, 1.52866483]],
]

/** A square of side `s` with continuous ("squircle") corners of radius `r`, like an iOS app icon. */
function squircle(s: number, r: number): string {
  const at = (a: number, b: number, quarter: number) => {
    let [x, y] = [s - a * r, b * r]
    for (let i = 0; i < quarter; i++) [x, y] = [s - y, x] // a quarter turn clockwise about the center
    return `${+x.toFixed(3)} ${+y.toFixed(3)}`
  }
  let d = `M${at(1.52866483, 0, 0)}`
  for (let q = 0; q < 4; q++) {
    d += `L${at(1.52866483, 0, q)}`
    for (const seg of CORNER) d += (seg.length === 3 ? 'C' : 'L') + seg.map(([a, b]) => at(a, b, q)).join(' ')
  }
  return `${d}Z`
}

const TILE = squircle(100, 22.5)

/** The app icon as the Home Screen draws it: continuous corners, a soft shadow, a hairline edge in dark mode. */
export function AppIcon({ size, className }: { size: number; className?: string }) {
  const clip = `${useId().replace(/:/g, '')}-tile`
  return (
    <svg className={cx('s-app-tile', className)} width={size} height={size} viewBox="0 0 100 100" aria-hidden>
      <defs>
        <clipPath id={clip}>
          <path d={TILE} />
        </clipPath>
      </defs>
      <g clipPath={`url(#${clip})`}>
        <rect width="100" height="100" className="s-app-tile__fill" />
        <image href="./icons/icon-512.png" width="100" height="100" preserveAspectRatio="xMidYMid slice" />
        <path d={TILE} className="s-app-tile__edge" />
      </g>
    </svg>
  )
}

/** Free-form block inside a Section group, with the row hairline below it. */
export function Block({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cx('s-block', className)}>{children}</div>
}
