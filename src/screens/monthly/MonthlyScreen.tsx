// One month's lists (SPEC §9.5): yours to plan until it locks with the month's second week, then to tick off
// until it's reviewed in the month's last week; friends' lists beside it, and who judges them. Batch 2.5 (SPEC
// §10.2): a list that had tasks at its lock can still be added to until its reviews open.
import { useState } from 'react'
import { setMonthlyTaskDone, useAuth, useMonthly, useProfiles, useSpace } from '../../data/api.ts'
import { isWeekPaused } from '../../domain/pause.ts'
import { computeMonthly, isTaskDone, judgesOf, spaceJudges } from '../../domain/scoring.ts'
import type { WeekResult } from '../../domain/scoring.ts'
import { formatMonth, monthlyWeeks } from '../../domain/time.ts'
import type { MonthId, MonthlyData, Space, UID } from '../../domain/types.ts'
import { Avatar, Button, EmptyState, Icon, Pill, Row, Screen, Section, cx, useNav, useSheet, useToast } from '../../ui/index.ts'
import { Loading } from '../components/Bits.tsx'
import { useNow } from '../components/clock.ts'
import { monthName } from '../components/format.ts'
import { MemberCard } from '../components/MemberCard.tsx'
import { MAX_TASKS, PlanEditor } from '../components/PlanEditor.tsx'
import { firstName, nameOf, personOf } from '../components/people.ts'
import type { Profiles } from '../components/people.ts'
import { TaskSheet } from '../components/TaskSheet.tsx'
import { cityOf, deadlineText, zoneNote } from '../components/zone.ts'
import { ReviewSheet } from '../ReviewSheet.tsx'
import {
  MONTHLY_LEAD_MS,
  addWindowFooter,
  canAddToList,
  judgeDetail,
  listHolders,
  listWhen,
  monthlyBoundsOf,
  monthlyPill,
  monthlyReviewStatus,
  noListNote,
  planningFooter,
} from './copy.ts'
import { reviewParts } from './review.ts'
import './monthly.css'

export interface MonthlyScreenProps {
  spaceId: string
  monthId: MonthId
}

/** Pushed from the monthly card or the month view: "October List". */
export function MonthlyScreen({ spaceId, monthId }: MonthlyScreenProps) {
  const nav = useNav()
  const live = useSpace(spaceId)
  const title = `${monthName(monthId)} List`
  if (live.data === undefined) {
    return (
      <Screen title={title} titleDisplay="inline">
        {live.error ? <EmptyState icon="info" title="Can’t load this space" message={live.error.message} /> : <Loading />}
      </Screen>
    )
  }
  if (live.data === null) {
    return (
      <Screen title={title} titleDisplay="inline">
        <EmptyState
          icon="person2"
          title="You’re not in this space"
          message="You left it, or it no longer exists."
          action={<Button onClick={nav.popToRoot}>Back to Spaces</Button>}
        />
      </Screen>
    )
  }
  return (
    <Screen title={title} titleDisplay="inline">
      <MonthlyContent space={live.data} monthId={monthId} />
    </Screen>
  )
}

function MonthlyContent({ space, monthId }: { space: Space; monthId: MonthId }) {
  const live = useMonthly(space, monthId)
  const profiles = useProfiles([...space.memberIds, ...(live.data?.monthly?.members ?? [])])
  if (!live.data) {
    return live.error ? <EmptyState icon="info" title="Can’t load this month’s lists" message={live.error.message} /> : <Loading />
  }
  return <MonthlyLists space={space} data={live.data} profiles={profiles} />
}

function MonthlyLists({ space, data, profiles }: { space: Space; data: MonthlyData; profiles: Profiles }) {
  const { uid } = useAuth()
  const me = uid ?? ''
  const nowMs = useNow()
  const sheet = useSheet()
  const toast = useToast()
  const [shimmer, setShimmer] = useState<{ id: string; stamp: number } | undefined>()

  const monthId = data.monthId
  const month = monthName(monthId)
  const list = data.monthly
  const result = computeMonthly(data, space, nowMs)
  const bounds = monthlyBoundsOf(space, data)
  const phase = result.phase
  const name = (id: UID) => firstName(nameOf(profiles, id))
  const near = (ms: number) => deadlineText(ms, space.timezone, nowMs)
  const when = (ms: number) => listWhen(ms, space.timezone, nowMs, near)
  const lastWeek = monthlyWeeks(monthId).last
  // In a paused last week the lists are still reviewed, but a missed review costs nothing (§9.3).
  const penaltyFree = isWeekPaused(space, lastWeek)
  const isMember = space.memberIds.includes(me)
  const inList = !!list?.members.includes(me)
  // The list's snapshot decides once you're in it; before that, your choice in the space.
  const judging = list && inList ? judgesOf(list).includes(me) : spaceJudges(space).includes(me)
  const part = reviewParts(undefined, data, me, space, nowMs).monthly
  const pill = monthlyPill(phase, bounds, nowMs, result.revealed, part.open && part.targets.length > 0)
  const status = monthlyReviewStatus({ result, me, memberIds: space.memberIds, part, month, due: near(bounds.deadlineAt), latePenalty: space.latePenalty, penaltyFree, name })

  const myTasks = data.plans[me]?.tasks ?? []
  const myDone = data.progress[me]?.done ?? {}
  const mine = result.members[me]

  const openReview = () =>
    sheet.present((close) => <ReviewSheet space={space} weekId={lastWeek} close={close} />, { 'aria-label': `${month} lists review` })

  // `id` is a task or one of its steps. The shimmer plays when the task itself becomes done.
  const toggleDone = (id: string, done: boolean) => {
    const task = myTasks.find((t) => t.id === id || t.subtasks?.some((step) => step.id === id))
    if (done && task && isTaskDone(task, { ...myDone, [id]: true })) setShimmer({ id: task.id, stamp: Date.now() })
    setMonthlyTaskDone(space, monthId, id, done).catch((e: unknown) =>
      toast({ title: 'Couldn’t update that task', message: e instanceof Error ? e.message : undefined, tone: 'error' }),
    )
  }
  const openTask = (taskId: string) => {
    const task = myTasks.find((t) => t.id === taskId)
    if (!task) return
    sheet.present((close) => <TaskSheet space={space} period={{ kind: 'month', id: monthId }} mode={{ kind: 'locked', task }} close={close} />, {
      'aria-label': 'Task details',
    })
  }
  // After the lock and until reviews open, a list that had tasks at its lock grows by one task at a time (final).
  const canAdd = canAddToList(data, me, space.memberIds, nowMs)
  const openAdd = () =>
    sheet.present((close) => <TaskSheet space={space} period={{ kind: 'month', id: monthId }} mode={{ kind: 'add' }} close={close} />, {
      'aria-label': `Add a task to your ${month} list`,
    })

  // Before a list exists it can only be planned from 8 days before the month's first week.
  if (!list && (phase !== 'planning' || nowMs < bounds.startAt - MONTHLY_LEAD_MS || space.utcOffsetMin === undefined)) {
    return phase === 'planning' && space.utcOffsetMin !== undefined ? (
      <EmptyState icon="calendar" title={`Your ${month} list`} message={`You can plan it from ${when(bounds.startAt - MONTHLY_LEAD_MS)}.`} />
    ) : (
      <EmptyState icon="calendar" title={`No ${month} lists`} message={`This month, scores are just the weeks.`} />
    )
  }

  const players = list ? list.members.filter((id) => !judgesOf(list).includes(id)) : []
  const holders = listHolders(result)
  const others = holders.filter((id) => id !== me)
  // During planning friends' lists show as they take shape; after the lock, only those who have one.
  const judges = list ? judgesOf(list).filter((id) => id !== me) : []
  const friendIds = phase === 'planning' ? players.filter((id) => id !== me && (data.plans[id]?.tasks.length ?? 0) > 0 && result.members[id]) : others
  const withoutList = phase === 'planning' ? [] : players.filter((id) => id !== me && !holders.includes(id))
  const started = nowMs >= bounds.startAt
  const note = zoneNote(space.timezone)
  const missing = noListNote(month, withoutList.map(name))

  return (
    <>
      <div className="s-week-head mo-head">
        <div className="s-week-head__title">{formatMonth(monthId)}</div>
        <Pill icon={pill.icon} tone={pill.urgent ? 'filled' : 'gray'}>
          {pill.text}
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
            title={<span className="t-semibold">This month’s times are off</span>}
            subtitle={`They don’t match ${cityOf(space.timezone)} time. The times shown here are the ones that count.`}
          />
        </Section>
      )}

      {status && (
        <Section footer={status.opens && status.urgent ? 'Blind until everyone’s in. Marks are final once you submit.' : undefined}>
          <Row
            leading={
              <span className={cx('s-status-icon', status.urgent && 's-status-icon--urgent')} aria-hidden>
                <Icon name={status.icon} size={20} weight={2} />
              </span>
            }
            title={<span className="t-semibold">{status.title}</span>}
            subtitle={status.subtitle}
            chevron={status.opens}
            onPress={status.opens ? openReview : undefined}
          />
        </Section>
      )}

      {judging && isMember ? (
        <Section>
          <Row
            leading={
              <span className="s-status-icon" aria-hidden>
                <Icon name="person2" size={20} weight={2} />
              </span>
            }
            title={<span className="t-semibold">You’re judging the {month} lists</span>}
            subtitle={`You rate them in ${month}’s last week. No list, no score.`}
          />
        </Section>
      ) : phase === 'planning' && isMember ? (
        <Section
          header={`Your ${month} list`}
          headerAccessory={myTasks.length > 0 ? <span className="s-count t-tabular">{`${myTasks.length} / ${MAX_TASKS}`}</span> : undefined}
          footer={planningFooter(myTasks.length, when(bounds.lockAt))}
        >
          <PlanEditor
            space={space}
            period={{ kind: 'month', id: monthId }}
            tasks={myTasks}
            done={myDone}
            canCheck={started}
            onToggleDone={toggleDone}
            shimmer={shimmer}
          />
        </Section>
      ) : mine?.participating && mine.taskCount > 0 ? (
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
          canCheck={isMember && nowMs < bounds.deadlineAt}
          onToggleDone={toggleDone}
          shimmer={shimmer}
          onOpenTask={openTask}
          onAddTask={canAdd ? openAdd : undefined}
          penaltyFree={penaltyFree}
          kind="month"
          footer={
            canAdd
              ? addWindowFooter(when(bounds.reviewOpenAt))
              : phase === 'active'
                ? `Counts as one extra week in your ${month} score. Friends review it in ${month}’s last week.`
                : `Counts as one extra week in your ${month} score.`
          }
        />
      ) : isMember ? (
        <Section>
          <Row
            leading={
              <span className="s-status-icon" aria-hidden>
                <Icon name="calendar" size={20} weight={2} />
              </span>
            }
            title={<span className="t-semibold">No {month} list</span>}
            subtitle={inList ? 'This month, your score is your weeks.' : 'This month’s list started without you. You’re in from next month.'}
          />
        </Section>
      ) : null}

      {friendIds.map((id) => (
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
          penaltyFree={penaltyFree}
          kind="month"
        />
      ))}

      {judges.length > 0 && <JudgesSection judges={judges} result={result} profiles={profiles} memberIds={space.memberIds} />}

      {(missing || note) && (
        <div className="s-footnote">
          {missing && <p>{missing}</p>}
          {note && <p>{note}</p>}
        </div>
      )}
    </>
  )
}

/** Who rates the lists without one of their own, and how they're doing (SPEC §9.4). */
function JudgesSection({ judges, result, profiles, memberIds }: { judges: UID[]; result: WeekResult; profiles: Profiles; memberIds: UID[] }) {
  return (
    <Section header="Judges">
      {judges.map((id) => {
        const person = personOf(profiles, id)
        const member = result.members[id]
        const detail = member ? judgeDetail(member, result.phase, !memberIds.includes(id)) : 'Judge'
        return (
          <Row
            key={id}
            leading={<Avatar name={person.name} color={person.color} photo={person.photo} size={32} />}
            title={person.name}
            detail={<span className={cx(detail.endsWith('Didn’t review') && 'mo-judge--missed')}>{detail}</span>}
          />
        )
      })}
    </Section>
  )
}
