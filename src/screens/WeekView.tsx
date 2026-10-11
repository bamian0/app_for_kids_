// One week of a space: your list (editable until the lock, then check-offs), everyone else's,
// the Friday review status, and after the reveal the marks and scores.
import { useEffect, useState } from 'react'
import { setTaskDone, useAuth, useWeek } from '../data/api.ts'
import { computeWeek } from '../domain/scoring.ts'
import type { WeekResult } from '../domain/scoring.ts'
import { formatWeekRange, weekBounds } from '../domain/time.ts'
import type { Space, UID, WeekId } from '../domain/types.ts'
import { EmptyState, Icon, Pill, Row, Section, useEdgeGlow, useToast } from '../ui/index.ts'
import { Loading } from './components/Bits.tsx'
import { useNow } from './components/clock.ts'
import { MemberCard } from './components/MemberCard.tsx'
import { PlanEditor } from './components/PlanEditor.tsx'
import { firstName, listNames, nameOf } from './components/people.ts'
import type { Profiles } from './components/people.ts'
import { phaseCountdown } from './components/status.ts'
import { firstTime } from './components/storage.ts'
import { zoneNote } from './components/zone.ts'

export interface WeekViewProps {
  space: Space
  weekId: WeekId
  profiles: Profiles
  /** Opens the review sheet; given only while your review is due. */
  onReview?: () => void
}

export function WeekView({ space, weekId, profiles, onReview }: WeekViewProps) {
  const { uid } = useAuth()
  const me = uid ?? ''
  const live = useWeek(space, weekId)
  const nowMs = useNow()
  const playGlow = useEdgeGlow().play
  const toast = useToast()
  const [shimmer, setShimmer] = useState<{ id: string; stamp: number } | undefined>()

  const data = live.data
  const result = data ? computeWeek(data, space, nowMs) : null
  const revealedForMe = !!result?.revealed && !!result.members[me]?.participating && (data?.week?.members.length ?? 0) > 1

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
  const countdown = phaseCountdown(phase, bounds, nowMs, result.revealed)
  const name = (id: UID) => firstName(nameOf(profiles, id))

  const toggleDone = (taskId: string, done: boolean) => {
    if (done) setShimmer({ id: taskId, stamp: Date.now() })
    setTaskDone(space, weekId, taskId, done).catch((e: unknown) =>
      toast({ title: 'Couldn’t update that task', message: e instanceof Error ? e.message : undefined, tone: 'error' }),
    )
  }

  const members = data.week?.members ?? []
  const others = members.filter((id) => id !== me && result.members[id])
  const notIn = space.memberIds.filter((id) => id !== me && !members.includes(id))
  const myTasks = data.plans[me]?.tasks ?? []
  const started = nowMs >= bounds.startAt
  const note = zoneNote(space.timezone)

  return (
    <>
      <div className="s-week-head">
        <div className="s-week-head__title">{formatWeekRange(weekId)}</div>
        <Pill icon={countdown.icon} tone={countdown.tone === 'urgent' ? 'filled' : 'gray'}>
          {countdown.text}
        </Pill>
      </div>

      <ReviewStatus result={result} me={me} name={name} onReview={onReview} />

      {phase === 'planning' && isMember ? (
        <Section
          header="Your list"
          headerAccessory={myTasks.length > 0 ? <span className="s-count t-tabular">{myTasks.length} / 25</span> : undefined}
          footer={
            myTasks.length === 0 ? (
              <span className="s-warn">Nothing planned = 0% this week. Add at least one task before the list locks.</span>
            ) : (
              `Saves as you type. Swipe left to delete. Locks ${started ? 'tonight' : 'Monday'} at midnight.`
            )
          }
        >
          <PlanEditor
            space={space}
            weekId={weekId}
            tasks={myTasks}
            done={data.progress[me]?.done ?? {}}
            canCheck={started}
            onToggleDone={toggleDone}
            shimmer={shimmer}
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
          canCheck={nowMs < bounds.deadlineAt}
          onToggleDone={toggleDone}
          shimmer={shimmer}
        />
      ) : isMember ? (
        <Section>
          <Row
            icon="calendar"
            title="You’re sitting this week out"
            subtitle={phase === 'closed' ? 'You didn’t take part in this week.' : 'You joined after the lists locked. You’re in from next week.'}
          />
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
          numbered={!started}
        />
      ))}

      {(notIn.length > 0 || note) && (
        <div className="s-footnote">
          {notIn.length > 0 && (
            <p>
              {phase === 'planning'
                ? `${listNames(notIn.map(name))} ${notIn.length === 1 ? 'hasn’t' : 'haven’t'} opened this week yet.`
                : `${listNames(notIn.map(name))} ${notIn.length === 1 ? 'is' : 'are'} sitting this week out.`}
            </p>
          )}
          {note && <p>{note}</p>}
        </div>
      )}
    </>
  )
}

/** The Friday line: what you owe, who you're waiting for, or that results are in. */
function ReviewStatus({ result, me, name, onReview }: { result: WeekResult; me: UID; name: (id: UID) => string; onReview?: () => void }) {
  const mine = result.members[me]
  if (!mine?.participating || (result.phase !== 'review' && !result.revealed)) return null
  if (result.revealed) return null
  if (!mine.hasSubmitted) {
    return (
      <Section footer="Blind until everyone’s in. Marks are final once you submit.">
        <Row
          leading={
            <span className="s-status-icon s-status-icon--urgent" aria-hidden>
              <Icon name="person2" size={20} weight={2} />
            </span>
          }
          title={<span className="t-semibold">Your review is due</span>}
          subtitle="Mark every friend’s tasks before midnight, or lose 5 points each."
          chevron={!!onReview}
          onPress={onReview}
        />
      </Section>
    )
  }
  const waiting = Object.values(result.members).filter((m) => m.participating && !m.hasSubmitted)
  return (
    <Section>
      <Row
        leading={
          <span className="s-status-icon" aria-hidden>
            <Icon name="clock" size={20} weight={2} />
          </span>
        }
        title={<span className="t-semibold">Submitted. Waiting for {waiting.length}</span>}
        subtitle={`${listNames(waiting.map((m) => name(m.uid)))} still reviewing. Results at midnight at the latest.`}
      />
    </Section>
  )
}
