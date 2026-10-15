// The task sheet: a task's title, its steps, and whether it brings in money. Before the lock it edits
// your list (the list editor saves, so a pending autosave can't drop the change). After the lock it
// appends a final task, or shows a locked one where only the revenue can still change. A monthly list's
// task (period kind 'month', SPEC §9.5) has no revenue and is never appended after the lock.
import { useRef, useState } from 'react'
import { flushSync } from 'react-dom'
import { AnimatePresence, motion } from 'motion/react'
import { addTaskAfterLock, setTaskRevenue, useAuth, useCurrency, useEarnings, useMonthly, useWeek } from '../../data/api.ts'
import type { Live } from '../../data/api.ts'
import { MAX_SUBTASKS, newTaskId } from '../../domain/ids.ts'
import { earningId } from '../../domain/money.ts'
import { boundsFor } from '../../domain/schedule.ts'
import { addedAfterLock, isTaskDone } from '../../domain/scoring.ts'
import { monthlyBounds } from '../../domain/time.ts'
import type { CurrencyCode, Earning, MonthId, Period, Space, Subtask, Task, WeekId } from '../../domain/types.ts'
import { Button, EmptyState, GlassButton, Icon, Row, Screen, Section, haptic, transitionFor, useAlert, useToast } from '../../ui/index.ts'
import { CheckDot, ErrorText, TaskBadge } from './Bits.tsx'
import { useNow } from './clock.ts'
import { monthName } from './format.ts'
import { addedLabel, weekdayIn } from './marks.ts'
import { MoneyField } from './MoneyField.tsx'
import { SwipeToDelete } from './SwipeToDelete.tsx'
import { TaskTitleInput } from './TaskTitleInput.tsx'
import '../tasks.css'

export type TaskSheetMode =
  /** Before the lock: a new task for your list. */
  | { kind: 'new' }
  /** Before the lock: one of your tasks. */
  | { kind: 'edit'; task: Task }
  /** After the lock, until reviews open: a task appended to the week. Final. Never for a monthly list. */
  | { kind: 'add' }
  /** After the lock: title and steps are fixed; the revenue can still change. */
  | { kind: 'locked'; task: Task }

export interface TaskSheetProps {
  space: Space
  /** The week the task belongs to (when `period` isn't given). */
  weekId?: WeekId
  /** The week or monthly list the task belongs to; wins over `weekId`. A month: no revenue, never `add`. */
  period?: Period
  mode: TaskSheetMode
  close: () => void
  /** new and edit: hands the task back to the list editor, which saves it. */
  onSave?: (task: Task) => void
  /** edit: takes the task off the list. */
  onDelete?: (id: string) => void
}

interface Revenue {
  on: boolean
  /** null: no amount typed (saved as 0, "revenue, amount to come"). */
  amount: number | null
  /** The field holds text that isn't an amount: nothing is saved until it is fixed. */
  invalid?: boolean
}

const OFF: Revenue = { on: false, amount: null }

const TITLES = { new: 'New Task', edit: 'Edit Task', add: 'Add Task', locked: 'Details' } as const

/** The period a list editor or task sheet works on: `period`, else the week `weekId`. */
export function periodFrom(period: Period | undefined, weekId: WeekId | undefined): Period {
  if (period) return period
  if (weekId === undefined) throw new Error('A week or a period is needed.')
  return { kind: 'week', id: weekId }
}

export function TaskSheet(props: TaskSheetProps) {
  const period = periodFrom(props.period, props.weekId)
  return period.kind === 'month' ? <MonthlyTaskSheet {...props} monthId={period.id} /> : <WeeklyTaskSheet {...props} weekId={period.id} />
}

type InnerProps = Omit<TaskSheetProps, 'weekId' | 'period'>

function WeeklyTaskSheet({ weekId, ...props }: InnerProps & { weekId: WeekId }) {
  const { uid } = useAuth()
  const week = useWeek(props.space, weekId)
  const earnings = useEarnings()
  const currency = useCurrency()
  return (
    <TaskSheetBody
      {...props}
      loaded={week.data !== undefined}
      done={week.data?.progress[uid ?? '']?.done ?? {}}
      lockAt={boundsFor(props.space, weekId, week.data?.week).lockAt}
      money={{ weekId, earnings, currency }}
    />
  )
}

function MonthlyTaskSheet({ monthId, ...props }: InnerProps & { monthId: MonthId }) {
  const { uid } = useAuth()
  const live = useMonthly(props.space, monthId)
  const lockAt = (live.data?.monthly ?? monthlyBounds(monthId, (w) => boundsFor(props.space, w))).lockAt
  // Nothing is appended to a monthly list after its lock.
  if (props.mode.kind === 'add') {
    return (
      <Screen title="Add Task" titleDisplay="inline" leading={<GlassButton icon="xmark" aria-label="Close" onClick={props.close} />}>
        <EmptyState icon="lock" title={`Your ${monthName(monthId)} list is locked`} message="Nothing can be added to it now." />
      </Screen>
    )
  }
  return <TaskSheetBody {...props} loaded={live.data !== undefined} done={live.data?.progress[uid ?? '']?.done ?? {}} lockAt={lockAt} money={null} lockedNote={`Your ${monthName(monthId)} list is locked.`} />
}

interface BodyProps extends InnerProps {
  /** The period's data has loaded (check-offs known). */
  loaded: boolean
  /** Your check-offs in the period. */
  done: Record<string, boolean>
  lockAt: number
  /** A week's task can bring in money; a monthly list's can't (null). */
  money: { weekId: WeekId; earnings: Live<Earning[]>; currency: CurrencyCode } | null
  /** The locked sheet's footer when nothing can change (a monthly list). */
  lockedNote?: string
}

function TaskSheetBody({ space, mode, close, onSave, onDelete, loaded, done, lockAt, money, lockedNote }: BodyProps) {
  const toast = useToast()
  const { actionSheet } = useAlert()
  const nowMs = useNow()
  const earnings = money?.earnings
  const currency = money?.currency ?? 'USD'
  const weekId = money?.weekId ?? ''
  const task = mode.kind === 'edit' || mode.kind === 'locked' ? mode.task : null
  const editable = mode.kind !== 'locked'

  const [title, setTitle] = useState(task?.title ?? '')
  const [steps, setSteps] = useState<Subtask[]>(task?.subtasks ?? [])
  const [focused, setFocused] = useState<string | null>(null)
  const [revenueDraft, setRevenueDraft] = useState<Revenue | null>(null)
  const [focusAmount, setFocusAmount] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // Made once, so trying again after an error can't add the task twice.
  const [addId] = useState(newTaskId)
  const stepRefs = useRef(new Map<string, HTMLTextAreaElement>())
  const titleRef = useRef<HTMLTextAreaElement>(null)

  // An existing task's revenue is known once the earnings have loaded (or failed to: then it starts off).
  // A monthly task has none.
  const stored = task && earnings ? earnings.data?.find((e) => e.id === earningId(space.id, weekId, task.id)) : undefined
  const storedRevenue: Revenue | null =
    !task || !earnings ? OFF : earnings.data ? (stored ? { on: true, amount: stored.amount > 0 ? stored.amount : null } : OFF) : earnings.error ? OFF : null
  const revenue = revenueDraft ?? storedRevenue ?? OFF
  const revenueChanged =
    revenueDraft !== null && storedRevenue !== null && (revenueDraft.on !== storedRevenue.on || (revenueDraft.on && revenueDraft.amount !== storedRevenue.amount))

  const cleanSteps = () => steps.map((s) => ({ id: s.id, title: s.title.trim() })).filter((s) => s.title !== '')
  const stepsChanged = JSON.stringify(cleanSteps()) !== JSON.stringify(task?.subtasks ?? [])
  const dirty = revenueChanged || (editable && (title.trim() !== (task?.title.trim() ?? '') || stepsChanged))
  const valid = (!editable || title.trim() !== '') && !(revenue.on && revenue.invalid)

  const saveRevenue = (target: Pick<Task, 'id' | 'title'>, isDone: boolean) => {
    if (!money) return
    setTaskRevenue(space, money.weekId, target, revenue.on ? (revenue.amount ?? 0) : null, isDone).catch((e: unknown) =>
      toast({ title: 'Couldn’t save the amount', message: e instanceof Error ? e.message : undefined, tone: 'error' }),
    )
  }

  const submit = async () => {
    if (!valid || busy) return
    if (mode.kind === 'locked') {
      if (revenueChanged) saveRevenue(mode.task, isTaskDone(mode.task, done))
      close()
      return
    }
    if (mode.kind === 'add') {
      if (!money) return
      setBusy(true)
      setError(null)
      try {
        const added = await addTaskAfterLock(space, money.weekId, { id: addId, title, subtasks: steps.map((s) => s.title) })
        if (revenue.on) saveRevenue(added, false)
        haptic()
        close()
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Couldn’t add the task.')
        setBusy(false)
      }
      return
    }
    const next: Task = { id: task?.id ?? newTaskId(), title: title.trim() }
    const clean = cleanSteps()
    if (clean.length > 0) next.subtasks = clean
    onSave?.(next)
    // Steps added or deleted after check-offs (Monday) can make the task done or not: its earning follows.
    const nowDone = isTaskDone(next, done)
    if (revenueChanged || (loaded && stored && (stored.earnedAt !== null) !== nowDone)) saveRevenue(next, nowDone)
    close()
  }

  const cancel = async () => {
    if (busy) return
    if (dirty) {
      const choice = await actionSheet({ actions: [{ label: 'Discard Changes', style: 'destructive' }], cancelLabel: 'Keep Editing' })
      if (choice !== 'Discard Changes') return
    }
    close()
  }

  // Rendered at once, so the new field can take focus inside the tap and iOS raises the keyboard.
  const addStep = (after?: string) => {
    if (steps.length >= MAX_SUBTASKS) return
    const step = { id: newTaskId(), title: '' }
    flushSync(() =>
      setSteps((list) => {
        const at = after ? list.findIndex((s) => s.id === after) + 1 : list.length
        return [...list.slice(0, at), step, ...list.slice(at)]
      }),
    )
    stepRefs.current.get(step.id)?.focus()
  }
  const removeStep = (id: string) => setSteps((list) => list.filter((s) => s.id !== id))

  let titleFooter = error ? <ErrorText>{error}</ErrorText> : undefined
  if (!error && mode.kind === 'add') {
    titleFooter = <>The task joins this week’s list and gets reviewed when reviews open. Friends see it was added on {weekdayIn(nowMs, space.timezone, true)}. Once added, it can’t be edited or removed.</>
  } else if (!error && mode.kind === 'locked') {
    titleFooter = <>{money ? 'Your list is locked, so only the revenue can change.' : (lockedNote ?? 'Your list is locked.')}</>
  }

  const ticked = task?.subtasks?.filter((s) => done[s.id] === true).length ?? 0

  return (
    <Screen
      title={TITLES[mode.kind]}
      titleDisplay="inline"
      leading={<GlassButton icon="xmark" aria-label="Cancel" onClick={() => void cancel()} />}
      trailing={
        mode.kind === 'add' ? undefined : (
          <GlassButton prominent icon="checkmark" aria-label="Done" onClick={() => void submit()} disabled={!valid} />
        )
      }
      // Adding is final, so it gets a full, labelled button that floats above the keyboard.
      toolbar={
        mode.kind === 'add' ? (
          <Button size="large" fullWidth loading={busy} disabled={!valid} onClick={() => void submit()}>
            Add to This Week
          </Button>
        ) : undefined
      }
      toolbarFullWidth
    >
      <Section footer={titleFooter}>
        {editable ? (
          <div className="tk-sheet-title">
            <TaskTitleInput
              inputRef={titleRef}
              value={title}
              onChange={(v) => {
                setTitle(v)
                setError(null)
              }}
              placeholder="Title"
              aria-label="Title"
              autoFocus={mode.kind !== 'edit'}
              enterKeyHint={steps.length > 0 || mode.kind === 'new' ? 'next' : 'done'}
              onEnter={() => {
                const first = steps[0]
                if (first) stepRefs.current.get(first.id)?.focus()
                // Opened from Add Task with Steps: Return starts the first step, like Reminders.
                else if (mode.kind === 'new' && title.trim()) addStep()
                else titleRef.current?.blur()
              }}
            />
          </div>
        ) : (
          <div className="tk-sheet-title">
            <span className="tk-sheet-title__meta">
              <span className="tk-sheet-title__text">{task?.title}</span>
              {task && addedAfterLock(task, lockAt) && task.addedAt !== undefined && (
                <span className="tk-meta">
                  <TaskBadge>{addedLabel(task.addedAt, space.timezone)}</TaskBadge>
                </span>
              )}
            </span>
          </div>
        )}
      </Section>

      {editable ? (
        <Section
          header="Steps"
          headerAccessory={steps.length > 0 ? <span className="s-count t-tabular">{`${steps.length} of ${MAX_SUBTASKS}`}</span> : undefined}
          footer="Friends review the task as a whole. It’s done once every step is ticked."
        >
          {steps.map((step, i) => (
            <SwipeToDelete key={step.id} onDelete={() => removeStep(step.id)}>
              <div className="tk-edit-step">
                <span className="tk-edit-step__lead" aria-hidden>
                  <span className="tk-step__bullet" />
                </span>
                <span className="s-task__main">
                  <TaskTitleInput
                    inputRef={(el) => {
                      if (el) stepRefs.current.set(step.id, el)
                      else stepRefs.current.delete(step.id)
                    }}
                    value={step.title}
                    placeholder="Step"
                    aria-label={`Step ${i + 1}`}
                    enterKeyHint={steps.length < MAX_SUBTASKS ? 'next' : 'done'}
                    onChange={(v) => setSteps((list) => list.map((s) => (s.id === step.id ? { ...s, title: v } : s)))}
                    onFocus={() => setFocused(step.id)}
                    onBlur={() => {
                      setFocused((f) => (f === step.id ? null : f))
                      // An emptied step goes, like an emptied task in the list.
                      setSteps((list) => list.filter((s) => s.id !== step.id || s.title.trim() !== ''))
                    }}
                    onEnter={() => {
                      // Return adds the next step, like Reminders; on an empty or the last possible step it just closes the keyboard.
                      if (step.title.trim() && steps.length < MAX_SUBTASKS) addStep(step.id)
                      else stepRefs.current.get(step.id)?.blur()
                    }}
                  />
                  {focused === step.id && (
                    <button
                      type="button"
                      className="s-task__delete"
                      aria-label={`Delete ${step.title || 'step'}`}
                      onPointerDown={(e) => e.preventDefault()}
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => removeStep(step.id)}
                    >
                      <Icon name="xmarkCircleFill" size={20} />
                    </button>
                  )}
                </span>
              </div>
            </SwipeToDelete>
          ))}
          {steps.length < MAX_SUBTASKS && (
            <Row
              leading={
                <span className="tk-action-icon" aria-hidden>
                  <Icon name="plus" size={20} weight={2.2} />
                </span>
              }
              title="Add Step"
              action
              onPress={() => addStep()}
            />
          )}
        </Section>
      ) : (
        task?.subtasks &&
        task.subtasks.length > 0 && (
          <Section header="Steps" headerAccessory={<span className="s-count t-tabular">{`${ticked} of ${task.subtasks.length} done`}</span>}>
            {task.subtasks.map((step) => (
              <Row key={step.id} leading={<CheckDot done={done[step.id] === true} />} title={step.title} />
            ))}
          </Section>
        )
      )}

      {money && (
        <Section footer="Only you see amounts.">
          <Row
            icon="banknote"
            title="Generates revenue"
            toggle={revenue.on}
            disabled={storedRevenue === null}
            onToggle={(on) => {
              // A typo in a field that goes away doesn't hold up Done; switching back on starts the field afresh.
              setRevenueDraft({ ...revenue, on, invalid: false })
              setFocusAmount(on)
            }}
          />
          <AnimatePresence initial={false}>
            {revenue.on && (
              <motion.div
                key="amount"
                className="tk-amount-row"
                initial={{ height: 0, opacity: 0 }}
                animate={{ height: 'auto', opacity: 1 }}
                exit={{ height: 0, opacity: 0 }}
                transition={transitionFor('snappy')}
              >
                <MoneyField
                  label="Amount"
                  value={revenue.amount}
                  onChange={(amount, invalid) => setRevenueDraft({ on: true, amount, invalid })}
                  currency={currency}
                  autoFocus={focusAmount}
                />
              </motion.div>
            )}
          </AnimatePresence>
        </Section>
      )}

      {mode.kind === 'edit' && onDelete && (
        <Section>
          <Row
            title="Delete Task"
            destructive
            onPress={() => {
              onDelete(mode.task.id)
              close()
            }}
          />
        </Section>
      )}

    </Screen>
  )
}
