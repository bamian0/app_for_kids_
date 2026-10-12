// The intro's big pictures, one per page, built from the app's own pieces: avatars, check circles,
// the step ring, the review control, the score ring and the goals bars. Each plays once, the first
// time its page comes into view; with Reduce Motion it simply shows the finished state.
import { useEffect, useState } from 'react'
import type { CSSProperties, ReactNode } from 'react'
import { motion } from 'motion/react'
import { now } from '../../domain/clock.ts'
import { AVATAR_COLORS } from '../../domain/ids.ts'
import { formatMoney } from '../../domain/money.ts'
import type { Mark } from '../../domain/types.ts'
import { Avatar, CheckCircle, Icon, MarkPicker, Pill, ProgressBar, ScoreRing, Shimmer, springs, usePrefersReducedMotion } from '../../ui/index.ts'
import type { IconName } from '../../ui/index.ts'
import { AppIcon, StepRing, TaskBadge } from '../components/Bits.tsx'

export interface VisualProps {
  /** True from the first time the page is shown. */
  play: boolean
}

const noop = () => {}

/** Steps through a short sequence once `play` turns true: 0 before, then 1, 2… at each delay (ms).
 *  `delays` is a module constant, so a re-render never restarts the timers. */
function useSequence(play: boolean, delays: readonly number[]): number {
  const reduced = usePrefersReducedMotion()
  const [step, setStep] = useState(0)
  useEffect(() => {
    if (!play) return
    if (reduced) {
      setStep(delays.length)
      return
    }
    const timers = delays.map((ms, i) => window.setTimeout(() => setStep((s) => Math.max(s, i + 1)), ms))
    return () => timers.forEach((t) => window.clearTimeout(t))
  }, [play, reduced, delays])
  return step
}

/** Pops in with a soft spring, after `delay` seconds. */
function PopIn({ play, delay = 0, className, style, children }: { play: boolean; delay?: number; className?: string; style?: CSSProperties; children: ReactNode }) {
  return (
    <motion.div
      className={className}
      style={style}
      initial={{ opacity: 0, scale: 0.6 }}
      animate={play ? { opacity: 1, scale: 1 } : { opacity: 0, scale: 0.6 }}
      transition={{ ...springs.bouncy, delay, opacity: { duration: 0.25, delay } }}
    >
      {children}
    </motion.div>
  )
}

// ---------- 1. Welcome: you and your friends ----------

const FRIENDS: { name: string; color: string; x: number; y: number; badge?: IconName }[] = [
  { name: 'Lena', color: AVATAR_COLORS[5], x: -96, y: -70, badge: 'checkmark' },
  { name: 'Marco', color: AVATAR_COLORS[0], x: 100, y: -58 },
  { name: 'Ana', color: AVATAR_COLORS[1], x: 92, y: 84, badge: 'trophy' },
  { name: 'Sam', color: AVATAR_COLORS[6], x: -90, y: 80 },
]

export function WelcomeVisual({ play }: VisualProps) {
  return (
    <div className="intro-v">
      <svg className="intro-v__orbit" viewBox="0 0 320 300" aria-hidden>
        <motion.circle
          cx="160"
          cy="150"
          r="124"
          pathLength={1}
          initial={{ pathLength: 0, opacity: 0 }}
          animate={play ? { pathLength: 1, opacity: 1 } : undefined}
          transition={{ duration: 1.1, ease: [0.22, 1, 0.36, 1], delay: 0.15 }}
        />
        <circle cx="160" cy="150" r="84" className="intro-v__orbit-inner" />
      </svg>
      <PopIn play={play} className="intro-v__app">
        <AppIcon size={108} />
      </PopIn>
      {FRIENDS.map((f, i) => (
        <PopIn key={f.name} play={play} delay={0.3 + i * 0.09} className="intro-v__friend" style={{ left: 160 + f.x, top: 150 + f.y }}>
          <Avatar name={f.name} color={f.color} size={i % 2 ? 54 : 60} />
          {f.badge && (
            <span className="intro-v__badge">
              <Icon name={f.badge} size={13} weight={f.badge === 'checkmark' ? 3 : 2.2} />
            </span>
          )}
        </PopIn>
      ))}
    </div>
  )
}

// ---------- 2. Plan: this week's list ----------

const PLAN_STEPS = [400, 850, 1300, 1800] as const

export function PlanVisual({ play }: VisualProps) {
  const step = useSequence(play, PLAN_STEPS)
  const stepsDone = step >= 3 ? 3 : step >= 2 ? 2 : 1
  return (
    <div className="intro-v">
      <Pill icon="lock" className="intro-v__pill">
        Locks Monday at midnight
      </Pill>
      <div className="intro-card">
        <div className="intro-card__header">This Week</div>
        <TaskLine lead={<CheckCircle checked={step >= 1} onChange={noop} />} title="Morning run" />
        <TaskLine lead={<StepRing done={stepsDone} total={3} />} title="Edit the short film" sub={`${stepsDone} of 3 steps`} />
        <motion.div
          initial={{ opacity: 0, y: 10 }}
          animate={step >= 4 ? { opacity: 1, y: 0 } : { opacity: 0, y: 10 }}
          transition={springs.snappy}
        >
          <TaskLine lead={<CheckCircle checked={false} onChange={noop} />} title="Call the bank" badge={<TaskBadge icon="plusCircle">Added Wed</TaskBadge>} />
        </motion.div>
      </div>
    </div>
  )
}

function TaskLine({ lead, title, sub, badge }: { lead: ReactNode; title: string; sub?: string; badge?: ReactNode }) {
  return (
    <div className="intro-task">
      <span className="intro-task__lead">{lead}</span>
      <span className="intro-task__text">
        <span className="intro-task__title">{title}</span>
        {sub && <span className="intro-task__sub t-tabular">{sub}</span>}
      </span>
      {badge}
    </div>
  )
}

// ---------- 3. Review: Friday, blind ----------

const REVIEW_STEPS = [600, 1100, 1600] as const
const REVIEWED: { title: string; mark: Mark }[] = [
  { title: 'Morning run', mark: 1 },
  { title: 'Finish the edit', mark: 0.5 },
  { title: 'Call the bank', mark: 0 },
]

export function ReviewVisual({ play }: VisualProps) {
  const step = useSequence(play, REVIEW_STEPS)
  return (
    <div className="intro-v intro-v--review">
      {/* Someone else's review behind it: there, but hidden until everyone is in. */}
      <div className="intro-card intro-card--behind">
        <span className="intro-card__veil">
          <Icon name="lock" size={14} weight={2.1} />
          Hidden until everyone submits
        </span>
      </div>
      <div className="intro-card">
        <div className="intro-person">
          <Avatar name="Lena" color={AVATAR_COLORS[5]} size={40} />
          <span className="intro-person__text">
            <span className="intro-person__name">Lena</span>
            <span className="intro-person__sub">3 tasks</span>
          </span>
          <span className="intro-person__day">Friday</span>
        </div>
        {REVIEWED.map((task, i) => (
          <div key={task.title} className="intro-mark">
            <span className="intro-mark__title">{task.title}</span>
            <MarkPicker size="compact" value={step > i ? task.mark : null} onChange={noop} />
          </div>
        ))}
      </div>
    </div>
  )
}

// ---------- 4. Month: the bar, and the prism ----------

/** The sweep lands after ~1.4s; the prism then passes over what they owe you. */
const SHINE_AT = [1500] as const

export function MonthVisual({ play }: VisualProps) {
  const reduced = usePrefersReducedMotion()
  const month = new Intl.DateTimeFormat('en-US', { month: 'long' }).format(now())
  const shine = useSequence(play, SHINE_AT)
  return (
    <div className="intro-v">
      <div className="intro-ring">
        <ScoreRing value={play ? 94 : null} threshold={90} size={188} stroke={19} delay={0.15} showValue animate={!reduced} />
        <span className="intro-ring__caption">{month}</span>
      </div>
      <motion.div
        className="intro-owe-wrap"
        initial={{ opacity: 0, y: 8 }}
        animate={play ? { opacity: 1, y: 0 } : undefined}
        transition={{ ...springs.banner, delay: 0.9 }}
      >
        <Shimmer trigger={shine > 0 ? 'shine' : undefined} radius={999} inline>
          <span className="intro-owe">
            <Icon name="trophy" size={16} weight={2} />
            They owe you dinner
          </span>
        </Shimmer>
      </motion.div>
    </div>
  )
}

// ---------- 5. Money: private balance and goals ----------

const FILL_AT = [350] as const

const GOALS = [
  { name: 'New lens', cost: 1560, funded: 1250 },
  { name: 'Weekend in Lisbon', cost: 900, funded: 0 },
]

export function MoneyVisual({ play }: VisualProps) {
  const step = useSequence(play, FILL_AT)
  return (
    <div className="intro-v">
      <div className="intro-card">
        <div className="intro-balance">
          <span className="intro-balance__label">Balance</span>
          <span className="intro-balance__value t-tabular">{formatMoney(1250, 'USD')}</span>
        </div>
        {GOALS.map((g) => (
          <div key={g.name} className="intro-goal">
            <span className="intro-goal__row">
              <span className="intro-goal__name">{g.name}</span>
              <span className="intro-goal__left t-tabular">{formatMoney(g.cost - g.funded, 'USD')} to go</span>
            </span>
            <ProgressBar value={step >= 1 ? g.funded / g.cost : 0} />
          </div>
        ))}
      </div>
      <Pill icon="lock" className="intro-v__pill intro-v__pill--below">
        Only you can see this
      </Pill>
    </div>
  )
}
