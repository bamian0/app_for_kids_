// The team's bar (SPEC §11.9.5): one segment per contributor in their avatar color, largest first, former members
// gray, like the segments of iPhone Storage. Past the target it is full and carries the iridescent sheen; the
// reached moment sweeps it once (Shimmer, none with Reduce Motion).
import type { CSSProperties } from 'react'
import { goalProgress, goalShares, progressText } from '../../domain/shared.ts'
import type { SharedGoal, UID, UserProfile } from '../../domain/types.ts'
import { Shimmer, cx } from '../../ui/index.ts'
import { personOf } from '../components/people.ts'

export interface TeamBarProps {
  goal: SharedGoal
  profiles: Record<UID, UserProfile>
  /** 'hero': 12 px, the goal screen; 'row': 6 px, under a goal's name in a list. */
  size?: 'hero' | 'row'
  /** Sweeps once whenever this changes to a new truthy value (the reached moment). */
  sweep?: unknown
  className?: string
}

/** Gaps between segments, in px. */
const GAP = { hero: 2, row: 1.5 }

export function TeamBar({ goal, profiles, size = 'row', sweep, className }: TeamBarProps) {
  const shares = goalShares(goal)
  const progress = goalProgress(goal)
  const gaps = Math.max(0, shares.length - 1) * GAP[size]
  const bar = (
    <div
      className={cx('sg-bar', `sg-bar--${size}`, progress.reached && 'is-reached', className)}
      role="progressbar"
      aria-label={progressText(goal)}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.floor(progress.ratio * 100)}
    >
      {shares.map((s) => (
        <span
          key={s.uid}
          className={cx('sg-bar__seg', s.former && 'is-former')}
          style={{ '--sg-seg': s.former ? undefined : personOf(profiles, s.uid).color, width: `calc((100% - ${gaps}px) * ${s.ratio})` } as CSSProperties}
        />
      ))}
      {progress.reached && <span className="sg-bar__sheen" aria-hidden />}
    </div>
  )
  return size === 'hero' ? (
    <Shimmer trigger={sweep} radius={999} className="sg-bar-shimmer">
      {bar}
    </Shimmer>
  ) : (
    bar
  )
}
