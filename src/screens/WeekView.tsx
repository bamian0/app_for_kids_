// One week of a space: your list (editable until the lock, then check-offs), everyone else's,
// the Friday review status, and after the reveal the marks and scores.
import { useEffect, useMemo, useState } from 'react'
import { setTaskDone, useAuth, useCurrency, useEarnings, useWeek } from '../data/api.ts'
import { computeWeek, isTaskDone, joinedAfterLock, membersAt } from '../domain/scoring.ts'
import type { WeekResult } from '../domain/scoring.ts'
import { formatWeekRange, weekBounds, weekIdFor } from '../domain/time.ts'
import type { Earning, Space, UID, WeekId } from '../domain/types.ts'
import { EmptyState, Icon, Pill, Row, Section, useEdgeGlow, useSheet, useToast } from '../ui/index.ts'
import { Loading } from './components/Bits.tsx'
import { useNow } from './components/clock.ts'
import { MemberCard } from './components/MemberCard.tsx'
import { PlanEditor } from './components/PlanEditor.tsx'
import { TaskSheet } from './components/TaskSheet.tsx'
import type { TaskSheetMode } from './components/TaskSheet.tsx'
import { firstName, listNames, nameOf } from './components/people.ts'
import type { Profiles } from './components/people.ts'
import { phaseCountdown, reviewTargetsOf, stillIn } from './components/status.ts'
import { firstTime } from './components/storage.ts'
import { cityOf, deadlineText, zoneNote } from './components/zone.ts'

const HOUR = 3_600_000
const DAY = 24 * HOUR

export interface WeekViewProps {
  space: Space
  weekId: WeekId
  profiles: Profiles
  /** Opens the review sheet; given only while your review (or confirm) is due. */
  onReview?: () => void
  /** Switches to next week, for someone sitting this one out. */
  onPlanNext?: () => void
}

export function WeekView({ space, weekId, profiles, onReview, onPlanNext }: WeekViewProps) {
  const { uid } = useAuth()
  const me = uid ?? ''
  const live = useWeek(space, weekId)
  const nowMs = useNow()
  const playGlow = useEdgeGlow().play
  const toast = useToast()
  const sheet = useSheet()
  const [shimmer, setShimmer] = useState<{ id: string; stamp: number } | undefined>()
  const allEarnings = useEarnings().data
  const currency = useCurrency()
  // Your revenue tasks of this week, by task id: amounts only ever show on your own list.
  const earnings = useMemo(() => {
    const mine: Record<string, Earning> = {}
    for (const e of allEarnings ?? []) if (e.spaceId === space.id && e.weekId === weekId) mine[e.taskId] = e
    return mine
  }, [allEarnings, space.id, weekId])

  const data = live.data
  const result = data ? computeWeek(data, space, nowMs) : null
  // Only a fresh reveal: opening a week from weeks ago from the month view is no moment.
  const freshReveal = !!data?.week && nowMs < data.week.deadlineAt + 2 * DAY
  const revealedForMe = freshReveal && !!result?.revealed && !!result.members[me]?.participating && (data?.week?.members.length ?? 0) > 1

  // The Friday reveal: a one-time light moment per week on this device.
  useEffect(() => {
    if (revealedForMe && firstTime(`reveal.${space.id}.${weekId}.${me}`)) playGlow(2600)
  }, [revealedForMe, space.id, weekId, me, playGlow])

  if (!data || !result) {
    return live.error ? <EmptyState icon="info" title="Can’t load this week" message={live.error.message} /> : <Loading />
  }

  const bounds = data.week ?? weekBounds(weekId, space.timezone)
  const phase = result.phase
  const mine = result.members[me]
  const inWeek = mine?.participating === true
  const isMember = space.memberIds.includes(me)
  const name = (id: UID) => firstName(nameOf(profiles, id))
  const when = (ms: number) => deadlineText(ms, space.timezone, nowMs)
  const counted = membersAt(space, bounds.deadlineAt)
  const countdown = phaseCountdown(phase, bounds, nowMs, result.revealed, {
    due: inWeek && !mine.hasSubmitted && reviewTargetsOf(result, me, counted).length > 0,
    alone: inWeek && stillIn(result, me, counted).length === 0,
  })

  const myTasks = data.plans[me]?.tasks ?? []
  const myDone = data.progress[me]?.done ?? {}

  // `id` is a task or one of its steps. The shimmer plays when the task itself becomes done.
  const toggleDone = (id: string, done: boolean) => {
    const task = myTasks.find((t) => t.id === id || t.subtasks?.some((step) => step.id === id))
    if (done && task && isTaskDone(task, { ...myDone, [id]: true })) setShimmer({ id: task.id, stamp: Date.now() })
    setTaskDone(space, weekId, id, done).catch((e: unknown) =>
      toast({ title: 'Couldn’t update that task', message: e instanceof Error ? e.message : undefined, tone: 'error' }),
    )
  }

  const openSheet = (mode: TaskSheetMode) =>
    sheet.present((close) => <TaskSheet space={space} weekId={weekId} mode={mode} close={close} />, {
      'aria-label': mode.kind === 'add' ? 'Add a task to this week' : 'Task details',
    })
  const openTask = (taskId: string) => {
    const task = myTasks.find((t) => t.id === taskId)
    if (task) openSheet({ kind: 'locked', task })
  }

  const members = data.week?.members ?? []
  const others = members.filter((id) => id !== me && result.members[id])
  // Before the lock everyone is added as soon as anyone opens the app, so only a locked week has people outside it.
  const notIn = phase === 'planning' ? [] : space.memberIds.filter((id) => id !== me && !members.includes(id))
  const lateJoiners = notIn.filter((id) => joinedAfterLock(space, id, bounds.lockAt))
  const satOut = notIn.filter((id) => !lateJoiners.includes(id))
  const started = nowMs >= bounds.startAt
  const note = zoneNote(space.timezone)
  const which = weekId === weekIdFor(nowMs, space.timezone) ? 'this week' : 'next week'
  const joinedLate = joinedAfterLock(space, me, bounds.lockAt)
  // After the lock and until Friday, tasks can still be added (one at a time, final).
  const canAdd = inWeek && isMember && nowMs >= bounds.lockAt && nowMs < bounds.reviewOpenAt

  return (
    <>
      <div className="s-week-head">
        <div className="s-week-head__title">{formatWeekRange(weekId)}</div>
        <Pill icon={countdown.icon} tone={countdown.tone === 'urgent' ? 'filled' : 'gray'}>
          {countdown.text}
        </Pill>
      </div>

      {data.boundsMismatch && (
        <Section>
          <Row
            leading={
              <span className="s-penalty-icon" aria-hidden>
                <Icon name="clock" size={18} weight={2} />
              </span>
            }
            title={<span className="t-semibold">This week’s times are off</span>}
            subtitle={`They don’t match ${cityOf(space.timezone)} time. The times shown here are the ones that count.`}
          />
        </Section>
      )}

      <ReviewStatus result={result} me={me} counted={counted} name={name} due={when(bounds.deadlineAt)} latePenalty={space.latePenalty} onReview={onReview} />

      {phase === 'planning' && isMember ? (
        <Section
          header="Your list"
          headerAccessory={myTasks.length > 0 ? <span className="s-count t-tabular">{myTasks.length} / 25</span> : undefined}
          footer={
            myTasks.length === 0 ? (
              // Red only once the lock is close: a fresh space shouldn't open on an error.
              <span className={bounds.lockAt - nowMs < 12 * HOUR ? 's-warn' : undefined}>
                Empty list = 0% {which}. Add a task before it locks {when(bounds.lockAt)}.
              </span>
            ) : (
              `Saves as you type. Swipe left to delete. Locks ${when(bounds.lockAt)}, then you can only add to it.`
            )
          }
        >
          <PlanEditor
            space={space}
            weekId={weekId}
            tasks={myTasks}
            done={myDone}
            canCheck={started}
            onToggleDone={toggleDone}
            shimmer={shimmer}
            earnings={earnings}
            currency={currency}
          />
        </Section>
      ) : inWeek ? (
        <MemberCard
          member={mine}
          me={me}
          profiles={profiles}
          revealed={result.revealed}
          phase={phase}
          threshold={space.threshold}
          latePenalty={space.latePenalty}
          timezone={space.timezone}
          lockAt={bounds.lockAt}
          canCheck={nowMs < bounds.deadlineAt}
          onToggleDone={toggleDone}
          shimmer={shimmer}
          earnings={earnings}
          currency={currency}
          onOpenTask={openTask}
          onAddTask={canAdd ? () => openSheet({ kind: 'add' }) : undefined}
          footer={canAdd ? `Locked. You can still add tasks until ${when(bounds.reviewOpenAt)}. Friends see the day you added them.` : undefined}
        />
      ) : isMember ? (
        <Section>
          <Row
            icon="calendar"
            title="You’re sitting this week out"
            subtitle={
              joinedLate
                ? 'You joined after the lists locked. You’re in from next week.'
                : phase === 'closed'
                  ? 'You didn’t take part in this week.'
                  : 'This week started without you.'
            }
          />
          {onPlanNext && <Row icon="listBullet" title="Plan Next Week" action chevron onPress={onPlanNext} />}
        </Section>
      ) : null}

      {others.map((id) => (
        <MemberCard
          key={id}
          member={result.members[id]}
          me={me}
          profiles={profiles}
          revealed={result.revealed}
          phase={phase}
          threshold={space.threshold}
          latePenalty={space.latePenalty}
          timezone={space.timezone}
          lockAt={bounds.lockAt}
          numbered={!started}
          former={!space.memberIds.includes(id)}
        />
      ))}

      {(notIn.length > 0 || note) && (
        <div className="s-footnote">
          {lateJoiners.length > 0 && (
            <p>
              {listNames(lateJoiners.map(name))} joined after the lists locked: in from next week.
            </p>
          )}
          {satOut.length > 0 && (
            <p>
              {listNames(satOut.map(name))} {satOut.length === 1 ? 'isn’t' : 'aren’t'} in this week.
            </p>
          )}
          {note && <p>{note}</p>}
        </div>
      )}
    </>
  )
}

interface ReviewStatusProps {
  result: WeekResult
  me: UID
  /** Participants who still count: someone who left isn't reviewed or waited for. */
  counted: UID[]
  name: (id: UID) => string
  /** The deadline in words: "tonight at midnight", or "Fri 3:00 PM" on another clock. */
  due: string
  latePenalty: number
  onReview?: () => void
}

/** The Friday line: what you owe, who you're waiting for, or that results are in. */
function ReviewStatus({ result, me, counted, name, due, latePenalty, onReview }: ReviewStatusProps) {
  const mine = result.members[me]
  if (!mine?.participating || result.phase !== 'review' || result.revealed) return null
  const friends = stillIn(result, me, counted)
  if (!mine.hasSubmitted) {
    if (reviewTargetsOf(result, me, counted).length > 0) {
      return (
        <Section footer="Blind until everyone’s in. Marks are final once you submit.">
          <Row
            leading={
              <span className="s-status-icon s-status-icon--urgent" aria-hidden>
                <Icon name="person2" size={20} weight={2} />
              </span>
            }
            title={<span className="t-semibold">Your review is due</span>}
            subtitle={`Due ${due}. Each friend you skip costs you ${latePenalty} points.`}
            chevron={!!onReview}
            onPress={onReview}
          />
        </Section>
      )
    }
    // Nobody planned anything: no points at stake. Alone, there's nothing to do but wait.
    if (friends.length === 0) return null
    return (
      <Section>
        <Row
          leading={
            <span className="s-status-icon" aria-hidden>
              <Icon name="checkmark" size={20} weight={2} />
            </span>
          }
          title={<span className="t-semibold">Nothing to review</span>}
          subtitle="None of your friends planned anything. Confirm so results can unlock."
          chevron={!!onReview}
          onPress={onReview}
        />
      </Section>
    )
  }
  const waiting = friends.filter((id) => !result.members[id].hasSubmitted)
  return (
    <Section>
      <Row
        leading={
          <span className="s-status-icon" aria-hidden>
            <Icon name="clock" size={20} weight={2} />
          </span>
        }
        title={<span className="t-semibold">Submitted. Waiting for {waiting.length}</span>}
        subtitle={`${listNames(waiting.map(name))} still reviewing. Results ${due} at the latest.`}
      />
    </Section>
  )
}
