// Small presentational pieces shared by several screens.
import type { ReactNode } from 'react'
import type { Mark } from '../../domain/types.ts'
import { ActivityIndicator, Icon, ScoreRing, cx } from '../../ui/index.ts'

/** "92%", "87.5%". Floors to one decimal so a score shown as 90% never fails the 90% bar. */
export function formatScore(score: number): string {
  const tenths = Math.floor(score * 10 + 1e-6) / 10
  return `${Number.isInteger(tenths) ? tenths.toFixed(0) : tenths.toFixed(1)}%`
}

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

const MARK_LABEL: Record<string, string> = { '1': 'Done', '0.5': 'Half', '0': 'Not done' }

export function markLabel(mark: Mark): string {
  return MARK_LABEL[String(mark)]
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

/** Small score ring with the number beside it, for list rows. */
export function MiniScore({ value, threshold = 90, caption }: { value: number | null; threshold?: number; caption?: string }) {
  return (
    <span className="s-mini-score">
      <span className="s-mini-score__text">
        <span className="s-mini-score__value t-tabular">{value == null ? '—' : formatScore(value)}</span>
        {caption && <span className="s-mini-score__caption">{caption}</span>}
      </span>
      <ScoreRing value={value} threshold={threshold} size={40} stroke={5} aria-label={value == null ? 'No score' : formatScore(value)} />
    </span>
  )
}

/** Free-form block inside a Section group, with the row hairline below it. */
export function Block({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cx('s-block', className)}>{children}</div>
}
