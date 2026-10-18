// The task sheet: a task's title, its steps, and whether it brings in money. Before the lock it edits
// your list (the list editor saves, so a pending autosave can't drop the change). After the lock it
// appends a final task, or shows a locked one where only the revenue (and, until reviews open, its cross-out)
// can still change. A monthly list's task (period kind 'month', SPEC §9.5) has no revenue; since batch 2.5 it can
// be appended after the lock too (SPEC §10.2). Crossing a locked task out, and undoing that, happen here only
// (SPEC §10.3, §10.5): a reason typed in place, a confirm that says how many undos are left, then a toast.
import { useRef, useState } from 'react'
import { flushSync } from 'react-dom'
import { AnimatePresence, motion } from 'motion/react'
import { addMonthlyTaskAfterLock, addTaskAfterLock, crossOutTask, setTaskRevenue, undoCrossOut, useAuth, useCurrency, useEarnings, useMonthly, useWeek } from '../../data/api.ts'
import type { Live } from '../../data/api.ts'
import { CANCEL_WHY_MAX, cancelOptions, cleanWhy, isCancelled, whyProblem, whyProblemText } from '../../domain/cancel.ts'
import { MAX_SUBTASKS, newTaskId } from '../../domain/ids.ts'
import { earningId } from '../../domain/money.ts'
import { boundsFor } from '../../domain/schedule.ts'
import { addedAfterLock, isTaskDone } from '../../domain/scoring.ts'
import { monthlyBounds } from '../../domain/time.ts'
import type { CurrencyCode, Earning, MonthId, Period, Space, Subtask, Task, Week, WeekId } from '../../domain/types.ts'
import { Button, EmptyState, GlassButton, Icon, Row, Screen, Section, TextFieldRow, cx, haptic, transitionFor, useAlert, useToast } from '../../ui/index.ts'
import { CheckDot, CrossedOutGlyph, ErrorText, TaskBadge } from './Bits.tsx'
import { crossOutConfirm, crossOutFooter, crossOutGate, crossedOutFooter, crossedOutLine, quoted, undoConfirm } from './cancel.ts'
import type { ListKind } from './cancel.ts'
import { useNow } from './clock.ts'
import { monthName } from './format.ts'
import { addedLabel, monthDayIn, weekdayIn } from './marks.ts'
import { MoneyField } from './MoneyField.tsx'
import { SwipeToDelete } from './SwipeToDelete.tsx'
import { TaskTitleInput } from './TaskTitleInput.tsx'
import { deadlineText } from './zone.ts'
import { monthlyAddFooter } from '../monthly/copy.ts'
import '../tasks.css'

export type TaskSheetMode =
  /** Before the lock: a new task for your list. */
  | { kind: 'new' }
  /** Before the lock: one of your tasks. */
  | { kind: 'edit'; task: Task }
  /** After the lock, until reviews open: a task appended to the week (or, since batch 2.5, the monthly list). Final. */
  | { kind: 'add' }
  /** After the lock: title and steps are fixed; the revenue can still change, and until reviews open the task can be
   *  crossed out or restored. */
  | { kind: 'locked'; task: Task }

export interface TaskSheetProps {
  space: Space
  /** The week the task belongs to (when `period` isn't given). */
  weekId?: WeekId
  /** The week or monthly list the task belongs to; wins over `weekId`. A month: no revenue. */
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
  const bounds = boundsFor(props.space, weekId, week.data?.week)
  return (
    <TaskSheetBody
      {...props}
      period={{ kind: 'week', id: weekId }}
      doc={week.data?.week ?? null}
      stored={week.data?.plans[uid ?? '']?.tasks}
      loaded={week.data !== undefined}
      done={week.data?.progress[uid ?? '']?.done ?? {}}
      bounds={bounds}
      money={{ weekId, earnings, currency }}
    />
  )
}

function MonthlyTaskSheet({ monthId, ...props }: InnerProps & { monthId: MonthId }) {
  const { uid } = useAuth()
  const live = useMonthly(props.space, monthId)
  const bounds = live.data?.monthly ?? monthlyBounds(monthId, (w) => boundsFor(props.space, w))
  const stored = live.data?.plans[uid ?? '']?.tasks
  // A list that had no tasks at its lock never grows (SPEC §10.2): nothing to add to.
  if (props.mode.kind === 'add' && live.data && (stored?.length ?? 0) === 0) {
    return (
      <Screen title="Add Task" titleDisplay="inline" leading={<GlassButton icon="xmark" aria-label="Close" onClick={props.close} />}>
        <EmptyState icon="lock" title={`Your ${monthName(monthId)} list is locked`} message="Nothing can be added to it now." />
      </Screen>
    )
  }
  return (
    <TaskSheetBody
      {...props}
      period={{ kind: 'month', id: monthId }}
      doc={live.data?.monthly ?? null}
      stored={stored}
      loaded={live.data !== undefined}
      done={live.data?.progress[uid ?? '']?.done ?? {}}
      bounds={bounds}
      money={null}
      lockedNote={`Your ${monthName(monthId)} list is locked.`}
    />
  )
}

interface BodyProps extends InnerProps {
  /** The task's own list: a week or a monthly list. */
  period: Period
  /** That list's doc once loaded (its members, judges and stored bounds decide the cross-out), else null. */
  doc: Week | null
  /** Your tasks on it as stored, so a locked task shows its current cross-out state. */
  stored: Task[] | undefined
  /** The period's data has loaded (check-offs known). */
  loaded: boolean
  /** Your check-offs in the period. */
  done: Record<string, boolean>
  /** The list's lock and when its reviews open (stored, else computed). */
  bounds: { lockAt: number; reviewOpenAt: number }
  /** A week's task can bring in money; a monthly list's can't (null). */
  money: { weekId: WeekId; earnings: Live<Earning[]>; currency: CurrencyCode } | null
  /** The locked sheet's footer when nothing else can change (a monthly list). */
  lockedNote?: string
}

function TaskSheetBody({ space, period, doc, stored: storedTasks, mode, close, onSave, onDelete, loaded, done, bounds, money, lockedNote }: BodyProps) {
  const toast = useToast()
  const { actionSheet, confirm } = useAlert()
  const { uid } = useAuth()
  const me = uid ?? ''
  const nowMs = useNow()
  const earnings = money?.earnings
  const currency = money?.currency ?? 'USD'
  const weekId = money?.weekId ?? ''
  const lockAt = bounds.lockAt
  const kind: ListKind = period.kind
  const month = period.kind === 'month' ? monthName(period.id) : ''
  // A locked task as it is stored now (crossed out or restored since the sheet opened).
  const task = mode.kind === 'locked' ? (storedTasks?.find((t) => t.id === mode.task.id) ?? mode.task) : mode.kind === 'edit' ? mode.task : null
  const editable = mode.kind !== 'locked'

  const [title, setTitle] = useState(task?.title ?? '')
  const [steps, setSteps] = useState<Subtask[]>(task?.subtasks ?? [])
  const [focused, setFocused] = useState<string | null>(null)
  const [revenueDraft, setRevenueDraft] = useState<Revenue | null>(null)
  const [focusAmount, setFocusAmount] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // The cross-out's reason, typed in place of the Cross Out Task row.
  const [reasonOpen, setReasonOpen] = useState(false)
  const [why, setWhy] = useState('')
  const [whyError, setWhyError] = useState<string | null>(null)
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
  const dirty = revenueChanged || (reasonOpen && why.trim() !== '') || (editable && (title.trim() !== (task?.title.trim() ?? '') || stepsChanged))

  // Crossing out (SPEC §10.3, §10.5): the task's own list decides who and when; cancelOptions the action and undos.
  const crossed = !!task && isCancelled(task)
  const gate = crossOutGate(doc, kind, space, me)
  const options = mode.kind === 'locked' && task ? cancelOptions(task, bounds, nowMs) : null
  const offerCrossOut = !!options && !crossed && options.action === 'cross-out' && gate.crossOut
  const offerUndo = !!options && crossed && options.action === 'undo' && gate.undo
  const reasonReady = cleanWhy(why) !== ''
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
      setBusy(true)
      setError(null)
      try {
        const input = { id: addId, title, subtasks: steps.map((s) => s.title) }
        if (money) {
          const added = await addTaskAfterLock(space, money.weekId, input)
          if (revenue.on) saveRevenue(added, false)
        } else if (period.kind === 'month') {
          await addMonthlyTaskAfterLock(space, period.id, input)
        }
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

  const crossOut = async () => {
    if (!task || !options || busy) return
    const problem = whyProblem(why)
    if (problem) {
      setWhyError(whyProblemText(problem))
      return
    }
    const ask = crossOutConfirm(task.title, options.undosLeft)
    if (!(await confirm({ title: ask.title, message: ask.message, confirmLabel: 'Cross Out', destructive: true }))) return
    setBusy(true)
    setWhyError(null)
    try {
      await crossOutTask(space, period, task.id, why)
      haptic()
      close()
      toast({ title: 'Crossed out', message: 'Friends decide on review day.', icon: 'xmark' })
    } catch (e) {
      // The reason stays, so trying again is one tap.
      setWhyError(e instanceof Error ? e.message : 'Couldn’t cross it out. Try again.')
      setBusy(false)
    }
  }

  const undo = async () => {
    if (!task || !options || busy) return
    const ask = undoConfirm(task.title, options.undosLeft - 1)
    if (!(await confirm({ title: ask.title, message: ask.message, confirmLabel: 'Undo' }))) return
    setBusy(true)
    try {
      await undoCrossOut(space, period, task.id)
      haptic()
      toast({ title: 'Back on your list', message: 'It counts again.', icon: 'undo' })
    } catch (e) {
      toast({ title: 'Couldn’t undo it', message: e instanceof Error ? e.message : undefined, tone: 'error' })
    } finally {
      setBusy(false)
    }
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

  // The cross-out section shows while it can act, and on a crossed-out task always (its state, and why it's final).
  const crossSection = offerCrossOut || crossed
  let titleFooter = error ? <ErrorText>{error}</ErrorText> : undefined
  if (!error && mode.kind === 'add') {
    titleFooter = money ? (
      <>The task joins this week’s list and gets reviewed when reviews open. Friends see it was added on {weekdayIn(nowMs, space.timezone, true)}. Once added, it can’t be edited or removed.</>
    ) : (
      <>{monthlyAddFooter(month, monthDayIn(nowMs, space.timezone, true))}</>
    )
  } else if (!error && mode.kind === 'locked') {
    // With a cross-out section below, more than the revenue can change.
    titleFooter = <>{money && !crossSection ? 'Your list is locked, so only the revenue can change.' : money ? 'Your list is locked.' : (lockedNote ?? 'Your list is locked.')}</>
  }

  const ticked = task?.subtasks?.filter((s) => done[s.id] === true).length ?? 0
  const addLabel = money ? 'Add to This Week' : `Add to ${month} List`
  const earned = !!task && !!earnings?.data?.find((e) => e.id === earningId(space.id, weekId, task.id) && e.earnedAt !== null)
  const reasonsFor = (when: number) => deadlineText(when, space.timezone, nowMs)

  let toolbar = undefined
  // Adding is final, so it gets a full, labelled button that floats above the keyboard; so does a cross-out.
  if (mode.kind === 'add') {
    toolbar = (
      <Button size="large" fullWidth loading={busy} disabled={!valid} onClick={() => void submit()}>
        {addLabel}
      </Button>
    )
  } else if (reasonOpen && offerCrossOut) {
    toolbar = (
      <Button size="large" variant="destructive" fullWidth loading={busy} disabled={!reasonReady} onClick={() => void crossOut()}>
        Cross Out Task
      </Button>
    )
  }

  return (
    <Screen
      title={TITLES[mode.kind]}
      titleDisplay="inline"
      // A locked monthly task has little left to change: just Done, like a read-only sheet (Cancel while a reason is typed).
      leading={mode.kind === 'locked' && !money && !reasonOpen ? undefined : <GlassButton icon="xmark" aria-label="Cancel" onClick={() => void cancel()} />}
      trailing={
        mode.kind === 'add' || reasonOpen ? undefined : (
          <GlassButton prominent icon="checkmark" aria-label="Done" onClick={() => void submit()} disabled={!valid} />
        )
      }
      toolbar={toolbar}
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
              <span className={cx('tk-sheet-title__text', crossed && 'tk-struck')}>{task?.title}</span>
              {task && addedAfterLock(task, lockAt) && task.addedAt !== undefined && (
                <span className="tk-meta">
                  <TaskBadge>{addedLabel(task.addedAt, space.timezone, kind)}</TaskBadge>
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
        <Section
          footer={
            // A crossed-out task can't be ticked, so its money can't come in until it's restored (SPEC §10.5).
            crossed && revenue.on && !earned
              ? 'Only you see amounts. It isn’t earned while it’s crossed out. Turn off Generates revenue if it won’t happen.'
              : 'Only you see amounts.'
          }
        >
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

      {crossSection && task && options && (
        <CrossOutSection
          task={task}
          crossed={crossed}
          kind={kind}
          timezone={space.timezone}
          spaceName={space.name}
          undosLeft={options.undosLeft}
          offerCrossOut={offerCrossOut}
          offerUndo={offerUndo}
          reviewsOpened={nowMs >= bounds.reviewOpenAt}
          reviewsOpenText={reasonsFor(bounds.reviewOpenAt)}
          reasonOpen={reasonOpen}
          why={why}
          whyError={whyError}
          busy={busy}
          onStart={() => setReasonOpen(true)}
          onWhy={(v) => {
            setWhy(v)
            setWhyError(null)
          }}
          onSubmitWhy={() => void crossOut()}
          onUndo={() => void undo()}
        />
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

interface CrossOutSectionProps {
  task: Task
  crossed: boolean
  kind: ListKind
  timezone: string
  spaceName: string
  /** cancelOptions' undosLeft: after crossing it out now (not crossed out), or still left (crossed out). */
  undosLeft: number
  offerCrossOut: boolean
  offerUndo: boolean
  reviewsOpened: boolean
  /** When reviews open, in words ("Friday at midnight"). */
  reviewsOpenText: string
  reasonOpen: boolean
  why: string
  whyError: string | null
  busy: boolean
  onStart: () => void
  onWhy: (value: string) => void
  onSubmitWhy: () => void
  onUndo: () => void
}

/** The sheet's last section (SPEC §10.5): Cross Out Task and its reason, or the crossed-out state with Undo. */
function CrossOutSection(props: CrossOutSectionProps) {
  const { task, crossed, kind, timezone, undosLeft, offerCrossOut, offerUndo, reasonOpen, why, whyError } = props
  if (crossed && task.cancel) {
    return (
      <Section footer={props.reviewsOpened ? crossedOutFooter(undosLeft, true, props.reviewsOpenText) : crossedOutFooter(offerUndo ? undosLeft : 0, false, props.reviewsOpenText)}>
        <Row leading={<CrossedOutGlyph />} title={crossedOutLine(task.cancel.at, timezone, kind)} subtitle={<span className="tk-why">{quoted(task.cancel.why)}</span>} />
        {offerUndo && (
          <Row
            leading={
              <span className="tk-action-icon" aria-hidden>
                <Icon name="undo" size={20} weight={2.1} />
              </span>
            }
            title="Undo Cross Out"
            action
            disabled={props.busy}
            onPress={props.onUndo}
          />
        )}
      </Section>
    )
  }
  if (!offerCrossOut) return null
  if (!reasonOpen) {
    return (
      <Section footer={crossOutFooter(undosLeft)}>
        <Row
          leading={
            <span className="tk-action-icon" aria-hidden>
              <Icon name="xmark" size={18} weight={2.4} />
            </span>
          }
          title="Cross Out Task"
          action
          onPress={props.onStart}
        />
      </Section>
    )
  }
  const length = why.length
  const problem = why.length > 0 ? whyProblem(why) : null
  const footer = whyError ? <ErrorText>{whyError}</ErrorText> : problem ? <ErrorText>{whyProblemText(problem)}</ErrorText> : `Everyone in ${props.spaceName} sees this.`
  return (
    <Section
      header="Why can’t you do it?"
      headerAccessory={
        length >= 100 ? <span className={cx('s-count t-tabular tk-why-count', length >= CANCEL_WHY_MAX && 'is-full')}>{`${length}/${CANCEL_WHY_MAX}`}</span> : undefined
      }
      footer={footer}
    >
      <TextFieldRow
        value={why}
        onChange={props.onWhy}
        placeholder="The pool is closed all week"
        aria-label="Why can’t you do it?"
        maxLength={CANCEL_WHY_MAX}
        autoFocus
        autoCapitalize="sentences"
        enterKeyHint="done"
        disabled={props.busy}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.nativeEvent.isComposing) props.onSubmitWhy()
        }}
      />
    </Section>
  )
}
