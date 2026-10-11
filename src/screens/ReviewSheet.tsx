// The Friday review: one page per friend, a mark for every task, then one final submit.
// Drafts live on this device until you submit, so closing the sheet loses nothing.
import { useState } from 'react'
import type { ReactNode } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import { submitReviews, useAuth, useProfiles, useWeek } from '../data/api.ts'
import { isRevealed, membersAt, reviewTargets } from '../domain/scoring.ts'
import { formatCountdown, weekBounds } from '../domain/time.ts'
import type { Mark, Space, UID, WeekId } from '../domain/types.ts'
import { Avatar, Button, EmptyState, GlassButton, Icon, MarkPicker, ProgressBar, Screen, Section, Shimmer, cx, haptic, useAlert } from '../ui/index.ts'
import { CheckDot, ErrorText, Loading } from './components/Bits.tsx'
import { useNow } from './components/clock.ts'
import { firstName, listNames, nameOf, personOf } from './components/people.ts'
import { readJSON, writeJSON } from './components/storage.ts'
import { deadlineText } from './components/zone.ts'

type Marks = Record<UID, Record<string, Mark>>

interface Props {
  space: Space
  weekId: WeekId
  close: () => void
}

export function ReviewSheet({ space, weekId, close }: Props) {
  const { uid } = useAuth()
  const me = uid ?? ''
  const live = useWeek(space, weekId)
  const data = live.data
  const profiles = useProfiles([...space.memberIds, ...(data?.week?.members ?? [])])
  const nowMs = useNow()
  const { confirm } = useAlert()
  const draftKey = `review.${space.id}.${weekId}.${me}`
  const [marks, setMarks] = useState<Marks>(() => readJSON<Marks>(draftKey) ?? {})
  const [page, setPage] = useState(0)
  const [direction, setDirection] = useState(1)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [justSubmitted, setJustSubmitted] = useState(false)

  const closeButton = <GlassButton icon="xmark" aria-label="Close" onClick={close} />
  const shell = (children: ReactNode, toolbar?: ReactNode) => (
    <Screen title="Friday Review" titleDisplay="inline" leading={closeButton} toolbar={toolbar} toolbarFullWidth>
      {children}
    </Screen>
  )

  if (!data) return shell(live.error ? <EmptyState icon="info" title="Can’t load the review" message={live.error.message} /> : <Loading />)

  const week = data.week
  const bounds = week ?? weekBounds(weekId, space.timezone)
  const submitted = justSubmitted || (week?.submittedBy.includes(me) ?? false)
  const name = (id: UID) => firstName(nameOf(profiles, id))
  // Someone who left the space isn't reviewed and doesn't hold back the results.
  const counted = membersAt(space, bounds.deadlineAt)

  if (submitted) {
    const waiting = week ? week.members.filter((id) => !week.submittedBy.includes(id) && id !== me && counted.includes(id)) : []
    const revealed = week ? isRevealed({ ...week, submittedBy: [...week.submittedBy, me] }, nowMs, counted) : false
    return shell(
      <div className="s-success">
        <Shimmer trigger={justSubmitted ? 'done' : undefined} radius="50%" inline>
          <span className="s-success__badge" aria-hidden>
            <Icon name="checkmark" size={46} weight={3} />
          </span>
        </Shimmer>
        <div className="s-success__title">Reviews in.</div>
        <div className="s-success__text">
          {revealed || waiting.length === 0
            ? 'Everyone’s in. Results are live.'
            : `Waiting for ${listNames(waiting.map(name))}. Results unlock when everyone’s in, or ${deadlineText(bounds.deadlineAt, space.timezone, nowMs)}.`}
        </div>
      </div>,
      <Button size="large" fullWidth onClick={close}>
        Done
      </Button>,
    )
  }

  if (nowMs < bounds.reviewOpenAt) {
    return shell(<EmptyState icon="calendar" title="Not yet" message={`Reviews open Friday. That’s in ${formatCountdown(bounds.reviewOpenAt - nowMs)}.`} />)
  }
  if (nowMs >= bounds.deadlineAt) {
    return shell(<EmptyState icon="lock" title="Too late" message={`Reviews are closed. Each missed review costs ${space.latePenalty} points.`} />)
  }
  if (!week?.members.includes(me)) {
    return shell(<EmptyState icon="calendar" title="Nothing for you this week" message="You’re not taking part this week, so there’s no one to review." />)
  }

  const targets = reviewTargets(data, me, counted)
  const tasksOf = (id: UID) => data.plans[id]?.tasks ?? []
  const missingFor = (id: UID) => tasksOf(id).filter((t) => marks[id]?.[t.id] === undefined).length
  const totalMissing = targets.reduce((n, id) => n + missingFor(id), 0)
  const totalTasks = targets.reduce((n, id) => n + tasksOf(id).length, 0)

  const setMark = (reviewee: UID, taskId: string, mark: Mark) => {
    setMarks((cur) => {
      const next = { ...cur, [reviewee]: { ...cur[reviewee], [taskId]: mark } }
      writeJSON(draftKey, next)
      return next
    })
  }

  const submit = async () => {
    if (busy || totalMissing > 0) return
    if (targets.length > 0) {
      const ok = await confirm({ title: 'Reviews are final. Submit?', message: 'Nobody sees your marks until everyone’s in. You can’t change them after this.', confirmLabel: 'Submit' })
      if (!ok) return
    }
    setBusy(true)
    setError(null)
    try {
      const payload = targets.map((id) => ({
        revieweeId: id,
        marks: Object.fromEntries(tasksOf(id).map((t) => [t.id, marks[id][t.id]])) as Record<string, Mark>,
      }))
      await submitReviews(space, weekId, payload)
      writeJSON(draftKey, null)
      haptic()
      setJustSubmitted(true)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Couldn’t submit. Try again.')
    } finally {
      setBusy(false)
    }
  }

  if (targets.length === 0) {
    return shell(
      <EmptyState
        icon="person2"
        title="Nobody to review"
        message={error ? <ErrorText>{error}</ErrorText> : 'None of your friends planned anything this week. Confirm so results can unlock.'}
      />,
      <Button size="large" fullWidth loading={busy} onClick={submit}>
        Confirm
      </Button>,
    )
  }

  const index = Math.min(page, targets.length - 1)
  const reviewee = targets[index]
  const person = personOf(profiles, reviewee)
  const tasks = tasksOf(reviewee)
  const checked = tasks.filter((t) => data.progress[reviewee]?.done[t.id] === true).length
  const last = index === targets.length - 1
  const go = (to: number) => {
    setDirection(to > index ? 1 : -1)
    setPage(to)
  }

  const toolbar = (
    <>
      {index > 0 && <Button variant="gray" size="large" icon="chevronLeft" aria-label={`Back to ${name(targets[index - 1])}`} onClick={() => go(index - 1)} />}
      {last ? (
        <Button size="large" fullWidth loading={busy} disabled={totalMissing > 0} onClick={submit}>
          {totalMissing > 0 ? `${totalMissing} to mark` : 'Submit Reviews'}
        </Button>
      ) : (
        <Button size="large" fullWidth onClick={() => go(index + 1)}>
          Next: {name(targets[index + 1])}
        </Button>
      )}
    </>
  )

  return shell(
    <>
      <div className="s-review-progress">
        {targets.length > 1 && (
          <div className="s-review-progress__people" role="tablist" aria-label="Friends to review">
            {targets.map((id, i) => {
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
                  <Avatar name={nameOf(profiles, id)} color={personOf(profiles, id).color} size={30} />
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
          {totalTasks - totalMissing} of {totalTasks} marked · due in {formatCountdown(bounds.deadlineAt - nowMs)}
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
            <Avatar name={person.name} color={person.color} size={64} />
            <div className="s-review-person__name">{person.name}</div>
            <div className="s-review-person__meta">
              {tasks.length} task{tasks.length === 1 ? '' : 's'} · {checked === 0 ? 'none' : checked === tasks.length ? 'all' : checked} checked off
            </div>
          </div>
          <Section footer={error ? <ErrorText>{error}</ErrorText> : `Be fair, be honest. ${name(reviewee)} reviews you too.`}>
            {tasks.map((task) => {
              const selfDone = data.progress[reviewee]?.done[task.id] === true
              return (
                <div key={task.id} className="s-review-task">
                  <div className="s-review-task__title">{task.title}</div>
                  <div className="s-review-task__hint">
                    <CheckDot done={selfDone} />
                    {selfDone ? `Marked done by ${name(reviewee)}` : `Not checked off by ${name(reviewee)}`}
                  </div>
                  <MarkPicker value={marks[reviewee]?.[task.id] ?? null} onChange={(m) => setMark(reviewee, task.id, m)} aria-label={`Mark for ${task.title}`} />
                </div>
              )
            })}
          </Section>
        </motion.div>
      </AnimatePresence>
    </>,
    toolbar,
  )
}
