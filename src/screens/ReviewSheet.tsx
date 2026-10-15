// Review day: one page per friend, a mark for every task, then one final submit. In a month's last week
// the month's lists are reviewed in the same sheet, as a second section per friend and a second submit
// (SPEC §9.5). Drafts live on this device until you submit, so closing the sheet loses nothing.
import { useState } from 'react'
import type { ReactNode } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import { submitMonthlyReviews, submitReviews, useAuth, useMonthly, useProfiles, useWeek } from '../data/api.ts'
import { isWeekPaused } from '../domain/pause.ts'
import { boundsFor } from '../domain/schedule.ts'
import { addedAfterLock, isRevealed, isTaskDone, membersAt, reviewTargets } from '../domain/scoring.ts'
import { formatCountdown, isMonthlyReviewWeek, monthIdForWeek } from '../domain/time.ts'
import type { Mark, MonthlyData, Space, Task, UID, Week, WeekData, WeekId } from '../domain/types.ts'
import { Avatar, Button, EmptyState, GlassButton, Icon, MarkPicker, ProgressBar, Screen, Section, Shimmer, cx, haptic, useAlert } from '../ui/index.ts'
import { CheckDot, ErrorText, Loading, StepList, StepRing, TaskBadge } from './components/Bits.tsx'
import { useNow } from './components/clock.ts'
import { monthName } from './components/format.ts'
import { addedLabel, weekdayIn } from './components/marks.ts'
import { firstName, listNames, nameOf, personOf } from './components/people.ts'
import { readJSON, writeJSON } from './components/storage.ts'
import { deadlineText } from './components/zone.ts'
import { reviewParts } from './monthly/review.ts'

type Marks = Record<UID, Record<string, Mark>>

interface Props {
  space: Space
  weekId: WeekId
  close: () => void
}

/** One period's data as the sheet uses it: the week's, or the month's lists'. */
interface Part {
  kind: 'weekly' | 'monthly'
  period: Week
  plans: WeekData['plans']
  progress: WeekData['progress']
}

const fallbackError = (e: unknown) => (e instanceof Error ? e.message : 'Couldn’t submit. Try again.')

function tasksIn(part: Part | null, uid: UID): Task[] {
  return part?.plans[uid]?.tasks ?? []
}

/** "4 tasks this week · 3 on October’s list · 2 checked off" (each part only when it's reviewed). */
function metaLine(weekly: Task[] | null, monthly: Task[] | null, month: string, checked: number): string {
  const parts: string[] = []
  const tasks = (n: number) => `${n} task${n === 1 ? '' : 's'}`
  if (weekly) parts.push(monthly ? `${tasks(weekly.length)} this week` : tasks(weekly.length))
  if (monthly) parts.push(weekly ? `${monthly.length} on ${month}’s list` : `${tasks(monthly.length)} on ${month}’s list`)
  const total = (weekly?.length ?? 0) + (monthly?.length ?? 0)
  parts.push(`${checked === 0 ? 'none' : checked === total ? 'all' : checked} checked off`)
  return parts.join(' · ')
}

export function ReviewSheet({ space, weekId, close }: Props) {
  const { uid } = useAuth()
  const me = uid ?? ''
  const monthId = isMonthlyReviewWeek(weekId) ? monthIdForWeek(weekId) : null
  const live = useWeek(space, weekId)
  const monthlyLive = useMonthly(space, monthId)
  const data = live.data
  // A list that failed to load (e.g. rules not published yet) mustn't hold up this week's reviews.
  const monthly: MonthlyData | undefined = monthlyLive.error ? undefined : monthlyLive.data
  const profiles = useProfiles([...space.memberIds, ...(data?.week?.members ?? []), ...(monthly?.monthly?.members ?? [])])
  const nowMs = useNow()
  const { confirm } = useAlert()
  const weeklyKey = `review.${space.id}.${weekId}.${me}`
  const monthlyKey = monthId ? `review.${space.id}.${monthId}.${me}` : null
  const [weeklyMarks, setWeeklyMarks] = useState<Marks>(() => readJSON<Marks>(weeklyKey) ?? {})
  const [monthlyMarks, setMonthlyMarks] = useState<Marks>(() => (monthlyKey ? (readJSON<Marks>(monthlyKey) ?? {}) : {}))
  const [page, setPage] = useState(0)
  const [direction, setDirection] = useState(1)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // Parts submitted from this sheet: their docs catch up a moment later.
  const [sent, setSent] = useState({ weekly: false, monthly: false })
  const [justSubmitted, setJustSubmitted] = useState(false)

  const month = monthId ? monthName(monthId) : ''
  const bounds = boundsFor(space, weekId, data?.week ?? monthly?.monthly ?? null)
  const reviewDay = weekdayIn(bounds.reviewOpenAt, space.timezone, true)
  const when = (ms: number) => deadlineText(ms, space.timezone, nowMs)
  const name = (id: UID) => firstName(nameOf(profiles, id))

  const closeButton = <GlassButton icon="xmark" aria-label="Close" onClick={close} />
  const shell = (children: ReactNode, toolbar?: ReactNode) => (
    <Screen title={`${reviewDay} Review`} titleDisplay="inline" leading={closeButton} toolbar={toolbar} toolbarFullWidth>
      {children}
    </Screen>
  )

  if (!data || (monthId && !monthly && !monthlyLive.error)) {
    return shell(live.error ? <EmptyState icon="info" title="Can’t load the review" message={live.error.message} /> : <Loading />)
  }

  const week = data.week
  const list = monthly?.monthly ?? null
  const paused = isWeekPaused(space, weekId)
  const parts = reviewParts(data, monthly, me, space, nowMs)
  const weeklyPending = parts.weekly.open && !sent.weekly
  const monthlyPending = parts.monthly.open && !sent.monthly
  const weeklyPart: Part | null = week ? { kind: 'weekly', period: week, plans: data.plans, progress: data.progress } : null
  const monthlyPart: Part | null = list && monthly ? { kind: 'monthly', period: list, plans: monthly.plans, progress: monthly.progress } : null

  if (!weeklyPending && !monthlyPending) {
    // What you've submitted for this review window: the week (unless paused) and the month's lists.
    const done = [
      weeklyPart && !paused && week?.members.includes(me) && (sent.weekly || week.submittedBy.includes(me)) ? weeklyPart : null,
      monthlyPart && list?.members.includes(me) && nowMs >= list.reviewOpenAt && (sent.monthly || list.submittedBy.includes(me)) ? monthlyPart : null,
    ].filter((p): p is Part => p !== null)
    if (done.length > 0) {
      const open = done.filter((p) => !isRevealed({ ...p.period, submittedBy: [...p.period.submittedBy, me] }, nowMs))
      // Only current members can still review; someone who left after the lock holds the results until the deadline.
      const waiting = [...new Set(open.flatMap((p) => p.period.members.filter((id) => id !== me && !p.period.submittedBy.includes(id) && space.memberIds.includes(id))))]
      const deadline = Math.max(...open.map((p) => p.period.deadlineAt), 0)
      let text = 'Everyone’s in. Results are live.'
      if (open.length > 0) {
        text =
          waiting.length > 0
            ? `Waiting for ${listNames(waiting.map(name))}. Results unlock when everyone’s in, or ${when(deadline)}.`
            : `Results come in at the deadline, ${when(deadline)}. A friend who left can’t review anymore.`
      }
      return shell(
        <div className="s-success">
          <Shimmer trigger={justSubmitted ? 'done' : undefined} radius="50%" inline>
            <span className="s-success__badge" aria-hidden>
              <Icon name="checkmark" size={46} weight={3} />
            </span>
          </Shimmer>
          <div className="s-success__title">Reviews in.</div>
          <div className="s-success__text">{text}</div>
        </div>,
        <Button size="large" fullWidth onClick={close}>
          Done
        </Button>,
      )
    }
    if (paused) return shell(<EmptyState icon="calendar" title="This week is paused" message="There’s nothing to review." />)
    if (nowMs < bounds.reviewOpenAt) {
      return shell(<EmptyState icon="calendar" title="Not yet" message={`Reviews open ${when(bounds.reviewOpenAt)}. That’s in ${formatCountdown(bounds.reviewOpenAt - nowMs)}.`} />)
    }
    if (nowMs >= bounds.deadlineAt) {
      const judging = week?.judges?.includes(me) ?? false
      return shell(<EmptyState icon="lock" title="Too late" message={judging ? 'Reviews are closed.' : `Reviews are closed. Each missed review costs ${space.latePenalty} points.`} />)
    }
    return shell(<EmptyState icon="calendar" title="Nothing for you this week" message="You’re not taking part this week, so there’s no one to review." />)
  }

  const weeklyTargets = weeklyPending ? parts.weekly.targets : []
  const monthlyTargets = monthlyPending ? parts.monthly.targets : []
  const people = parts.people.filter((id) => weeklyTargets.includes(id) || monthlyTargets.includes(id))
  const twoParts = monthlyPending
  const missingIn = (targets: UID[], part: Part | null, marks: Marks, id: UID) =>
    targets.includes(id) ? tasksIn(part, id).filter((t) => marks[id]?.[t.id] === undefined).length : 0
  const missingFor = (id: UID) => missingIn(weeklyTargets, weeklyPart, weeklyMarks, id) + missingIn(monthlyTargets, monthlyPart, monthlyMarks, id)
  const tasksFor = (id: UID) => (weeklyTargets.includes(id) ? tasksIn(weeklyPart, id).length : 0) + (monthlyTargets.includes(id) ? tasksIn(monthlyPart, id).length : 0)
  const totalMissing = people.reduce((n, id) => n + missingFor(id), 0)
  const totalTasks = people.reduce((n, id) => n + tasksFor(id), 0)
  const deadline = Math.min(...[weeklyPending ? (week?.deadlineAt ?? Infinity) : Infinity, monthlyPending ? (list?.deadlineAt ?? Infinity) : Infinity])
  // Retrying only the monthly part after the weekly one went through.
  const monthlyRetry = sent.weekly && monthlyPending

  const setMark = (kind: Part['kind'], reviewee: UID, taskId: string, mark: Mark) => {
    const [set, key] = kind === 'weekly' ? [setWeeklyMarks, weeklyKey] : [setMonthlyMarks, monthlyKey]
    set((cur) => {
      const next = { ...cur, [reviewee]: { ...cur[reviewee], [taskId]: mark } }
      if (key) writeJSON(key, next)
      return next
    })
  }

  const payload = (targets: UID[], part: Part | null, marks: Marks) =>
    targets.map((id) => ({
      revieweeId: id,
      marks: Object.fromEntries(tasksIn(part, id).map((t) => [t.id, marks[id][t.id]])) as Record<string, Mark>,
    }))

  const submit = async () => {
    if (busy || totalMissing > 0) return
    if (people.length > 0 && !monthlyRetry) {
      const ok = await confirm({ title: 'Reviews are final. Submit?', message: 'Nobody sees your marks until everyone’s in. You can’t change them after this.', confirmLabel: 'Submit' })
      if (!ok) return
    }
    setBusy(true)
    setError(null)
    let weeklyIn = sent.weekly
    try {
      // A part with nobody to review is still confirmed, so its results aren't held up by you.
      if (weeklyPending) {
        await submitReviews(space, weekId, payload(weeklyTargets, weeklyPart, weeklyMarks))
        writeJSON(weeklyKey, null)
        weeklyIn = true
        setSent((s) => ({ ...s, weekly: true }))
      }
      if (monthlyPending && monthId) {
        try {
          await submitMonthlyReviews(space, monthId, payload(monthlyTargets, monthlyPart, monthlyMarks))
        } catch (e) {
          setError(weeklyIn ? `Your weekly reviews are in. The monthly ones didn’t go through: ${fallbackError(e)}` : fallbackError(e))
          return
        }
        if (monthlyKey) writeJSON(monthlyKey, null)
        setSent((s) => ({ ...s, monthly: true }))
      }
      haptic()
      setJustSubmitted(true)
    } catch (e) {
      setError(fallbackError(e))
    } finally {
      setBusy(false)
    }
  }

  const submitLabel = monthlyRetry ? 'Submit Monthly Reviews' : 'Submit Reviews'

  if (people.length === 0) {
    let message = 'None of your friends planned anything this week. Confirm so results can unlock.'
    if (twoParts) {
      message = weeklyPending
        ? `None of your friends planned anything this week, and nobody has a list for ${month}. Confirm so results can unlock.`
        : `None of your friends has a list for ${month}. Confirm so results can unlock.`
    }
    return shell(
      <EmptyState icon="person2" title="Nobody to review" message={error ? <ErrorText>{error}</ErrorText> : message} />,
      <Button size="large" fullWidth loading={busy} onClick={submit}>
        {monthlyRetry ? submitLabel : 'Confirm'}
      </Button>,
    )
  }

  const index = Math.min(page, people.length - 1)
  const reviewee = people[index]
  const person = personOf(profiles, reviewee)
  const weeklyTasks = weeklyTargets.includes(reviewee) ? tasksIn(weeklyPart, reviewee) : null
  const monthlyTasks = monthlyTargets.includes(reviewee) ? tasksIn(monthlyPart, reviewee) : null
  const checkedIn = (part: Part | null, tasks: Task[] | null) => (tasks ?? []).filter((t) => isTaskDone(t, part?.progress[reviewee]?.done ?? {})).length
  const checked = checkedIn(weeklyPart, weeklyTasks) + checkedIn(monthlyPart, monthlyTasks)
  // Whether this friend reviews you in this window (judges and friends you have no list for don't).
  const reviewsMe = [weeklyPart && !paused ? { part: weeklyPart, data: data as WeekData | MonthlyData } : null, monthlyPart && monthly ? { part: monthlyPart, data: monthly } : null].some(
    (p) => p !== null && reviewTargets(p.data, reviewee, membersAt(space, p.part.period.lockAt)).includes(me),
  )
  const last = index === people.length - 1
  const go = (to: number) => {
    setDirection(to > index ? 1 : -1)
    setPage(to)
  }

  const toolbar = (
    <>
      {index > 0 && <Button variant="gray" size="large" icon="chevronLeft" aria-label={`Back to ${name(people[index - 1])}`} onClick={() => go(index - 1)} />}
      {last ? (
        <Button size="large" fullWidth loading={busy} disabled={totalMissing > 0} onClick={submit}>
          {totalMissing > 0 ? `${totalMissing} to mark` : submitLabel}
        </Button>
      ) : (
        <Button size="large" fullWidth onClick={() => go(index + 1)}>
          Next: {name(people[index + 1])}
        </Button>
      )}
    </>
  )

  const sections: { part: Part; tasks: Task[]; marks: Marks; header?: string }[] = []
  if (weeklyTasks && weeklyPart) sections.push({ part: weeklyPart, tasks: weeklyTasks, marks: weeklyMarks, header: twoParts ? 'This week' : undefined })
  if (monthlyTasks && monthlyPart) sections.push({ part: monthlyPart, tasks: monthlyTasks, marks: monthlyMarks, header: `${month} list` })
  const footer = error ? <ErrorText>{error}</ErrorText> : reviewsMe ? `Be fair, be honest. ${name(reviewee)} reviews you too.` : 'Be fair, be honest.'

  return shell(
    <>
      <div className="s-review-progress">
        {people.length > 1 && (
          <div className="s-review-progress__people" role="tablist" aria-label="Friends to review">
            {people.map((id, i) => {
              const left = missingFor(id)
              return (
                <button
                  key={id}
                  type="button"
                  role="tab"
                  aria-selected={i === index}
                  aria-label={`${nameOf(profiles, id)}${left === 0 ? ', done' : `, ${left} left`}`}
                  className={cx('s-review-chip', i === index && 'is-current', left === 0 && 'is-done')}
                  onClick={() => go(i)}
                >
                  <Avatar name={nameOf(profiles, id)} color={personOf(profiles, id).color} photo={personOf(profiles, id).photo} size={30} />
                  {left === 0 && (
                    <span className="s-review-chip__done" aria-hidden>
                      <Icon name="checkmark" size={10} weight={3.4} />
                    </span>
                  )}
                </button>
              )
            })}
          </div>
        )}
        <ProgressBar value={totalTasks ? (totalTasks - totalMissing) / totalTasks : 1} label="Review progress" />
        <div className="s-review-progress__text t-tabular">
          {totalTasks - totalMissing} of {totalTasks} marked · due in {formatCountdown(deadline - nowMs)}
        </div>
      </div>

      <AnimatePresence mode="popLayout" initial={false} custom={direction}>
        <motion.div
          key={reviewee}
          custom={direction}
          variants={{
            enter: (d: number) => ({ x: d * 48, opacity: 0 }),
            center: { x: 0, opacity: 1 },
            exit: (d: number) => ({ x: d * -48, opacity: 0 }),
          }}
          initial="enter"
          animate="center"
          exit="exit"
          transition={{ type: 'spring', stiffness: 420, damping: 38 }}
        >
          <div className="s-review-person">
            <Avatar name={person.name} color={person.color} photo={person.photo} size={64} />
            <div className="s-review-person__name">{person.name}</div>
            <div className="s-review-person__meta">{metaLine(weeklyTasks, monthlyTasks, month, checked)}</div>
          </div>
          {sections.map((section, i) => {
            const ticks = section.part.progress[reviewee]?.done ?? {}
            return (
              <Section key={section.part.kind} header={section.header} footer={i === sections.length - 1 ? footer : undefined}>
                {section.tasks.map((task) => {
                  const selfDone = isTaskDone(task, ticks)
                  // Steps are evidence: the mark is still for the whole task.
                  const steps = (task.subtasks ?? []).map((step) => ({ id: step.id, title: step.title, done: ticks[step.id] === true }))
                  const ticked = steps.filter((step) => step.done).length
                  const added = section.part.kind === 'weekly' && task.addedAt !== undefined && addedAfterLock(task, section.part.period.lockAt)
                  let hint = selfDone ? `Marked done by ${name(reviewee)}` : `Not checked off by ${name(reviewee)}`
                  if (steps.length > 0 && !selfDone) hint = `${ticked} of ${steps.length} steps ticked by ${name(reviewee)}`
                  return (
                    <div key={task.id} className="s-review-task">
                      <div className="s-review-task__title">{task.title}</div>
                      <div className="s-review-task__hint">
                        {steps.length > 0 ? <StepRing done={ticked} total={steps.length} size={16} muted /> : <CheckDot done={selfDone} />}
                        <span className="tk-hint-text">{hint}</span>
                        {added && <TaskBadge>{addedLabel(task.addedAt as number, space.timezone)}</TaskBadge>}
                      </div>
                      {steps.length > 0 && <StepList steps={steps} mode="dots" owner={name(reviewee)} />}
                      <MarkPicker
                        value={section.marks[reviewee]?.[task.id] ?? null}
                        onChange={(m) => setMark(section.part.kind, reviewee, task.id, m)}
                        aria-label={`Mark for ${task.title}`}
                      />
                    </div>
                  )
                })}
              </Section>
            )
          })}
        </motion.div>
      </AnimatePresence>
    </>,
    toolbar,
  )
}
