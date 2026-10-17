// Small presentational pieces shared by several screens.
import { useId } from 'react'
import type { CSSProperties, ReactNode } from 'react'
import { formatMoney } from '../../domain/money.ts'
import type { CurrencyCode } from '../../domain/types.ts'
import { ActivityIndicator, CheckCircle, Icon, ScoreRing, cx } from '../../ui/index.ts'
import { formatScore } from './format.ts'
import '../tasks.css'

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

/** A crossed-out task's lead (SPEC §10.5): a gray ✕ in a circle where its check circle was. Not a control. */
export function CrossedOutGlyph({ small }: { small?: boolean }) {
  return (
    <span className={cx('s-crossed', small && 's-crossed--small')} role="img" aria-label="Crossed out">
      <Icon name="xmark" size={small ? 9 : 11} weight={2.8} />
    </span>
  )
}

/** A crossed-out task friends excused ("Skipped"): a gray minus in a circle, where the mark glyph goes. */
export function SkippedGlyph() {
  return (
    <span className="s-mark s-mark--skipped" role="img" aria-label="Skipped">
      <Icon name="minusCircle" size={24} weight={1.7} />
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

/** Where a plain task has its check circle, a task with steps has this: a ring that fills step by
 *  step and turns solid with a tick once every step is done. `muted`: someone else's, gray like CheckDot.
 *  `onPress`: your own, where people tap to tick; it opens the task (its steps are ticked below it). */
export function StepRing({ done, total, size = 24, muted, onPress }: { done: number; total: number; size?: number; muted?: boolean; onPress?: () => void }) {
  const fraction = total > 0 ? done / total : 0
  const label = `${done} of ${total} steps done`
  const ring = (
    <span
      className={cx('tk-ring', muted && 'tk-ring--muted', fraction === 1 && 'is-complete', fraction === 0 && 'is-empty')}
      role={onPress ? undefined : 'img'}
      aria-label={onPress ? undefined : label}
      aria-hidden={onPress ? true : undefined}
      style={{ '--ring-size': `${size}px` } as CSSProperties}
    >
      <svg viewBox="0 0 24 24" className="tk-ring__svg" aria-hidden>
        <circle className="tk-ring__track" cx="12" cy="12" r="10.75" />
        <circle className="tk-ring__arc" cx="12" cy="12" r="10.75" pathLength={1} style={{ strokeDashoffset: 1 - fraction }} />
        <circle className="tk-ring__fill" cx="12" cy="12" r="11.5" />
        <path className="tk-ring__tick" d="M7.4 12.3l3.15 3.15 6.05-6.7" pathLength={1} />
      </svg>
    </span>
  )
  if (!onPress) return ring
  return (
    <button type="button" className="tk-ring-press" aria-label={`${label}. Details`} onClick={onPress}>
      {ring}
    </button>
  )
}

/** Small label beside a task: "Added Wed", or the amount a revenue task brings in. */
export function TaskBadge({ icon, strong, children }: { icon?: 'banknote' | 'plusCircle'; strong?: boolean; children: ReactNode }) {
  return (
    <span className={cx('tk-badge', strong && 'tk-badge--strong')}>
      {icon && <Icon name={icon} size={14} weight={1.8} />}
      <span className="t-tabular">{children}</span>
    </span>
  )
}

/** Your revenue task's amount (only you see it); stronger once the task is done and the money earned. */
export function AmountBadge({ amount, currency, earned }: { amount: number; currency: CurrencyCode; earned: boolean }) {
  return (
    <TaskBadge icon="banknote" strong={earned}>
      {amount > 0 ? formatMoney(amount, currency) : 'Revenue'}
    </TaskBadge>
  )
}

export interface StepItem {
  id: string
  title: string
  done: boolean
}

export interface StepListProps {
  steps: StepItem[]
  /** check: your own steps, ticked one by one. bullet: before the week starts. dots: progress, read only. */
  mode: 'check' | 'bullet' | 'dots'
  onToggle?: (id: string, done: boolean) => void
  /** A tap on a step opens its task. */
  onOpen?: () => void
  /** Whose check-offs the dots show, for VoiceOver ("Checked off by Lena"). */
  owner?: string
}

/** A task's steps, indented under its title like subtasks in Reminders. */
export function StepList({ steps, mode, onToggle, onOpen, owner }: StepListProps) {
  return (
    <div className={cx('tk-steps', `tk-steps--${mode}`)} role="list">
      {steps.map((step) => {
        let lead: ReactNode
        if (mode === 'check') lead = <CheckCircle size={20} checked={step.done} onChange={(v) => onToggle?.(step.id, v)} aria-label={step.title} />
        else if (mode === 'dots') lead = <CheckDot done={step.done} label={owner ? `${step.done ? 'Checked off' : 'Not checked off'} by ${owner}` : undefined} />
        else lead = <span className="tk-step__bullet" aria-hidden />
        return (
          <div key={step.id} className={cx('tk-step', step.done && mode !== 'bullet' && 'is-done')} role="listitem">
            <span className="tk-step__lead">{lead}</span>
            {onOpen ? (
              <button type="button" className="tk-step__main" onClick={onOpen}>
                <span className="tk-step__title">{step.title}</span>
              </button>
            ) : (
              <span className="tk-step__main">
                <span className="tk-step__title">{step.title}</span>
              </span>
            )}
          </div>
        )
      })}
    </div>
  )
}
