// The team's bar (SPEC §11.9.5): one segment per contributor in their avatar color, largest first, former members
// gray, like the segments of iPhone Storage. Past the target it is full and turns into the app's prism (as a funded
// goal's bar does), the members' parts still marked by the gaps between them; the reached moment sweeps it once
// (Shimmer, none with Reduce Motion).
import type { CSSProperties } from 'react'
import { goalProgress, goalShares } from '../../domain/shared.ts'
import type { SharedGoal, UID, UserProfile } from '../../domain/types.ts'
import { Shimmer, cx } from '../../ui/index.ts'
import { personOf } from '../components/people.ts'
import { progressLine } from './copy.ts'

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
  const gap = GAP[size]
  const gaps = Math.max(0, shares.length - 1) * gap
  const width = (ratio: number) => `calc((100% - ${gaps}px) * ${ratio})`
  // Past the target: the prism, with a gap where each part ends.
  const cuts: string[] = []
  if (progress.reached) {
    let sum = 0
    shares.slice(0, -1).forEach((s, i) => {
      sum += s.ratio
      cuts.push(`calc(${width(sum)} + ${i * gap}px)`)
    })
  }
  const bar = (
    <div
      className={cx('sg-bar', `sg-bar--${size}`, progress.reached && 'is-reached', className)}
      role="progressbar"
      aria-label={progressLine(goal)}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.floor(progress.ratio * 100)}
    >
      {shares.map((s) => (
        <span
          key={s.uid}
          className={cx('sg-bar__seg', s.former && 'is-former')}
          style={
            {
              '--sg-seg': s.former ? undefined : personOf(profiles, s.uid).color,
              width: width(s.ratio),
            } as CSSProperties
          }
        />
      ))}
      {progress.reached && <span className="sg-bar__sheen" aria-hidden />}
      {cuts.map((left, i) => (
        <span key={i} className="sg-bar__cut" style={{ left, width: gap }} aria-hidden />
      ))}
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
