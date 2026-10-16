// One participant's week: who they are, their tasks (and steps) with check-offs, and once revealed,
// the marks each friend gave and the week score.
import type { ReactNode } from 'react'
import { addedAfterLock } from '../../domain/scoring.ts'
import type { MemberWeekResult, TaskResult } from '../../domain/scoring.ts'
import type { WeekPhase } from '../../domain/time.ts'
import type { CurrencyCode, Earning, UID } from '../../domain/types.ts'
import { Avatar, CheckCircle, Icon, Row, Section, Shimmer, cx } from '../../ui/index.ts'
import { AmountBadge, CheckDot, MarkGlyph, MiniScore, StepList, StepRing, TaskBadge } from './Bits.tsx'
import type { StepListProps } from './Bits.tsx'
import { addedLabel, stepCount, summarizeMarks } from './marks.ts'
import { firstName, listNames, nameOf, personOf, shortName } from './people.ts'
import type { Profiles } from './people.ts'
import '../tasks.css'

export interface MemberCardProps {
  member: MemberWeekResult
  me: UID
  profiles: Profiles
  revealed: boolean
  phase: WeekPhase
  threshold: number
  latePenalty: number
  /** The space's clock, for the day a task was added ("Added Wed"). */
  timezone: string
  /** The week's lock: tasks added at or after it carry their "Added" badge. */
  lockAt: number
  /** Self check-offs (current user only, until the deadline). `id` is a task id or a step id. */
  canCheck?: boolean
  onToggleDone?: (id: string, done: boolean) => void
  shimmer?: { id: string; stamp: number }
  /** Before the week starts check-offs mean nothing, so tasks are numbered instead. */
  numbered?: boolean
  /** No longer in the space (their week still counts). */
  former?: boolean
  /** Your revenue tasks of this week, by task id. Only ever passed for your own card. */
  earnings?: Record<string, Earning>
  currency?: CurrencyCode
  /** Your own card: a tap on a task opens its details. */
  onOpenTask?: (taskId: string) => void
  /** Your own card while tasks can still be added (after the lock, until reviews open). */
  onAddTask?: () => void
  footer?: ReactNode
  /** The week is paused (SPEC §9.3): the list is just for them, so no score ring, no review lines, no misses. */
  paused?: boolean
  /** Missed reviews cost nothing here (a monthly list whose month's last week is paused): no missed-review row. */
  penaltyFree?: boolean
}

export function MemberCard({
  member,
  me,
  profiles,
  revealed,
  phase,
  threshold,
  latePenalty,
  timezone,
  lockAt,
  canCheck,
  onToggleDone,
  shimmer,
  numbered,
  former,
  earnings,
  currency,
  onOpenTask,
  onAddTask,
  footer,
  paused = false,
  penaltyFree = false,
}: MemberCardProps) {
  const isMe = member.uid === me
  const person = personOf(profiles, member.uid)
  const n = member.taskCount
  const done = member.tasks.filter((t) => t.selfDone).length
  const scored = revealed && member.score !== null && !paused
  const reviewed = member.reviewedBy.length > 0
  // After friends' marks are in, your own check-offs no longer change anything.
  const checkable = isMe && !!canCheck && !(scored && reviewed)
  const who = (uid: UID) => shortName(profiles, uid, me)
  const by = (ticked: boolean) => `${ticked ? 'Checked off' : 'Not checked off'} by ${person.name}`

  let subtitle: string
  let score = null
  if (scored) {
    subtitle = n === 0 ? 'Nothing planned' : reviewed ? `Reviewed by ${listNames(member.reviewedBy.map((uid) => (uid === me ? 'you' : who(uid))))}` : 'Nobody reviewed, check-offs count'
    score = <MiniScore value={member.score} threshold={threshold} caption={phase === 'closed' || reviewed ? 'Final' : 'So far'} />
  } else if (phase === 'planning') {
    subtitle = n === 0 ? 'No tasks yet' : `${n} task${n === 1 ? '' : 's'} planned`
  } else if (paused) {
    // Nothing counts: what's done, without scores or review lines.
    subtitle = n === 0 ? 'No tasks' : `${done} of ${n} done`
  } else {
    subtitle = n === 0 ? 'Nothing planned' : `${done} of ${n} done`
    // Someone who left can't review anymore: no "still reviewing" for them.
    if (phase === 'review' && !isMe && (member.hasSubmitted || !former)) subtitle += member.hasSubmitted ? ' · reviews in' : ' · still reviewing'
    if (n > 0) score = <MiniScore value={member.provisionalScore} threshold={threshold} caption="Provisional" iridescent={false} />
  }
  if (former) subtitle = `Left · ${subtitle}`

  const taskRow = (task: TaskResult, i: number) => {
    const steps = task.subtasks
    const ticked = steps.filter((step) => step.done).length
    const marks = Object.entries(task.reviewerMarks)
    let lead: ReactNode
    if (checkable && steps.length > 0) {
      lead = <StepRing done={ticked} total={steps.length} onPress={onOpenTask ? () => onOpenTask(task.taskId) : undefined} />
    } else if (checkable) {
      lead = <CheckCircle checked={task.selfDone} onChange={(v) => onToggleDone?.(task.taskId, v)} aria-label={task.title} />
    } else if (scored) {
      lead = <MarkGlyph mark={task.mark} />
    } else if (numbered) {
      lead = (
        <span className="s-task__index t-tabular" aria-hidden>
          {i + 1}
        </span>
      )
    } else if (steps.length > 0) {
      lead = <StepRing done={ticked} total={steps.length} size={22} muted />
    } else {
      lead = <CheckDot done={task.selfDone} label={by(task.selfDone)} />
    }

    let subtitleText: string | undefined
    if (scored && task.source === 'self') {
      subtitleText = steps.length > 0 ? `${ticked} of ${steps.length} steps ticked` : task.selfDone ? 'Checked off' : 'Not checked off'
    } else {
      subtitleText = summarizeMarks(marks, me, who) || undefined
    }

    const earning = isMe ? earnings?.[task.taskId] : undefined
    const added = task.addedAt !== undefined && addedAfterLock(task, lockAt)
    const badges =
      added || earning ? (
        <>
          {added && <TaskBadge>{addedLabel(task.addedAt as number, timezone)}</TaskBadge>}
          {earning && currency && <AmountBadge amount={earning.amount} currency={currency} earned={earning.earnedAt !== null} />}
        </>
      ) : undefined

    let stepMode: StepListProps['mode'] = 'dots'
    if (checkable) stepMode = 'check'
    else if (numbered) stepMode = 'bullet'

    const row = (
      <TaskRow
        key={task.taskId}
        lead={lead}
        title={task.title}
        subtitle={subtitleText}
        badges={badges}
        showCount={steps.length > 0 && !scored && !numbered}
        detail={scored && marks.length > 1 ? `${Math.round(task.mark * 100)}%` : undefined}
        steps={steps}
        stepMode={stepMode}
        onToggleStep={onToggleDone}
        onOpen={isMe && onOpenTask ? () => onOpenTask(task.taskId) : undefined}
        owner={isMe ? undefined : person.name}
      />
    )
    return checkable ? (
      <Shimmer key={task.taskId} trigger={shimmer?.id === task.taskId ? shimmer.stamp : undefined}>
        {row}
      </Shimmer>
    ) : (
      row
    )
  }

  const missed = paused || penaltyFree ? [] : member.missedReviewsOf
  return (
    <Section footer={footer}>
      <Row
        leading={<Avatar name={person.name} color={person.color} photo={person.photo} size={36} />}
        title={<span className="t-semibold">{isMe ? `${person.name} (You)` : person.name}</span>}
        subtitle={subtitle}
        accessory={score}
      />
      {/* An empty list after the lock is said once, in the subtitle ("Nothing planned", "No tasks"). */}
      {n === 0
        ? phase === 'planning' && <Row title={<span className="c-secondary">Still planning</span>} leading={<span className="s-row-spacer" />} />
        : member.tasks.map(taskRow)}
      {onAddTask && (
        <Row
          leading={
            <span className="tk-action-icon" aria-hidden>
              <Icon name="plus" size={20} weight={2.2} />
            </span>
          }
          title="Add Task"
          action
          onPress={onAddTask}
        />
      )}
      {missed.length > 0 && (
        <Row
          leading={
            <span className="s-penalty-icon">
              <Icon name="clock" size={18} weight={2} />
            </span>
          }
          title={`${isMe ? 'You didn’t' : `${firstName(person.name)} didn’t`} review ${listNames(missed.map((uid) => (uid === me ? 'you' : firstName(nameOf(profiles, uid)))))}`}
          subtitle={`−${latePenalty * missed.length} points this month`}
        />
      )}
    </Section>
  )
}

interface TaskRowProps {
  lead: ReactNode
  title: string
  subtitle?: string
  /** "Added Wed", your amount. */
  badges?: ReactNode
  /** Steps ticked beside the title, "2/4". */
  showCount?: boolean
  detail?: string
  steps: StepListProps['steps']
  stepMode: StepListProps['mode']
  onToggleStep?: (id: string, done: boolean) => void
  onOpen?: () => void
  owner?: string
}

/** A task as a list row with its steps under it. The lead stays its own control; the rest opens the task. */
function TaskRow({ lead, title, subtitle, badges, showCount, detail, steps, stepMode, onToggleStep, onOpen, owner }: TaskRowProps) {
  const body = (
    <>
      <span className="ui-row__text">
        <span className="ui-row__title">{title}</span>
        {subtitle && <span className="ui-row__subtitle">{subtitle}</span>}
        {badges && <span className="tk-meta">{badges}</span>}
      </span>
      {showCount && (
        // The ring beside the task already says it to VoiceOver.
        <span className="tk-row__count" aria-hidden>
          {stepCount(steps)}
        </span>
      )}
      {detail && <span className="ui-row__detail">{detail}</span>}
      {onOpen && (
        <span className="tk-row__info" aria-hidden>
          <Icon name="info" size={22} />
        </span>
      )}
    </>
  )
  return (
    <div className={cx('tk-block', steps.length > 0 && 'tk-block--steps')}>
      <div className={cx('ui-row tk-row', subtitle && 'ui-row--subtitle')}>
        <span className="ui-row__leading">{lead}</span>
        {onOpen ? (
          <button type="button" className="ui-row__main tk-row__press" onClick={onOpen}>
            {body}
          </button>
        ) : (
          <span className="ui-row__main">{body}</span>
        )}
      </div>
      {steps.length > 0 && <StepList steps={steps} mode={stepMode} onToggle={onToggleStep} onOpen={onOpen} owner={owner} />}
    </div>
  )
}
