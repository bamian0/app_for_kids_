// Your task list before it locks: edit titles in place, add with the trailing new row, swipe to delete.
// Edits autosave; the list on screen stays local while you type so the server echo never moves the cursor.
// Steps and revenue are edited in the task sheet, which hands the task back here: one writer.
import { useCallback, useEffect, useRef, useState } from 'react'
import { savePlan } from '../../data/api.ts'
import { newTaskId } from '../../domain/ids.ts'
import type { CurrencyCode, Earning, Space, Task, WeekId } from '../../domain/types.ts'
import { CheckCircle, Icon, Row, Shimmer, cx, useSheet, useToast } from '../../ui/index.ts'
import { AmountBadge, StepList, StepRing } from './Bits.tsx'
import { stepCount } from './marks.ts'
import { SwipeToDelete } from './SwipeToDelete.tsx'
import { TaskSheet } from './TaskSheet.tsx'
import { TaskTitleInput } from './TaskTitleInput.tsx'
import '../tasks.css'

export const MAX_TASKS = 25
const SAVE_DELAY = 700

function usePlanDraft(space: Space, weekId: WeekId, server: Task[]) {
  const toast = useToast()
  const [local, setLocal] = useState<Task[] | null>(null)
  const tasks = local ?? server
  const latest = useRef(tasks)
  latest.current = tasks
  const version = useRef(0)
  const timer = useRef<number | undefined>(undefined)
  const editing = useRef(false)
  const target = useRef({ space, weekId })
  target.current = { space, weekId }

  const save = useCallback(
    async (next: Task[], v: number) => {
      timer.current = undefined
      try {
        await savePlan(target.current.space, target.current.weekId, next)
      } catch (e) {
        if (v === version.current) setLocal(null)
        toast({ title: 'Couldn’t save your list', message: e instanceof Error ? e.message : undefined, tone: 'error' })
        return
      }
      // Hand the list back to the live data once nothing newer is pending and nobody is typing.
      if (v === version.current && !editing.current) setLocal(null)
    },
    [toast],
  )

  const edit = useCallback(
    (change: (tasks: Task[]) => Task[], delay = SAVE_DELAY) => {
      const next = change(latest.current)
      latest.current = next
      setLocal(next)
      const v = ++version.current
      window.clearTimeout(timer.current)
      timer.current = window.setTimeout(() => void save(next, v), delay)
    },
    [save],
  )

  // While a title has focus, saves keep the local list; the commit on blur hands it back.
  const setEditing = useCallback((on: boolean) => {
    editing.current = on
  }, [])

  // A new task typed but not committed yet (no Return, no blur).
  const pendingNew = useRef('')

  // Leaving the screen mid-debounce, or with a new task still in its field, still saves. WebKit
  // fires no blur when a focused field is removed, so this is the last chance.
  useEffect(
    () => () => {
      const title = pendingNew.current.trim()
      if (timer.current === undefined && !title) return
      window.clearTimeout(timer.current)
      const list = title && latest.current.length < MAX_TASKS ? [...latest.current, { id: newTaskId(), title }] : latest.current
      savePlan(target.current.space, target.current.weekId, list).catch(() => {})
    },
    [],
  )

  return { tasks, latest, edit, setEditing, pendingNew }
}

export interface PlanEditorProps {
  space: Space
  weekId: WeekId
  tasks: Task[]
  done: Record<string, boolean>
  /** Check-offs are possible once the week has started (Monday before the lock). */
  canCheck: boolean
  /** `id` is a task id or a step id. */
  onToggleDone: (id: string, done: boolean) => void
  shimmer?: { id: string; stamp: number }
  /** Your revenue tasks of this week, by task id. Amounts are only ever shown to you. */
  earnings?: Record<string, Earning>
  currency: CurrencyCode
}

export function PlanEditor({ space, weekId, tasks: server, done, canCheck, onToggleDone, shimmer, earnings = {}, currency }: PlanEditorProps) {
  const { tasks, latest, edit, setEditing, pendingNew } = usePlanDraft(space, weekId, server)
  const sheet = useSheet()
  const [adding, setAdding] = useState('')
  pendingNew.current = adding
  const [focused, setFocused] = useState<string | null>(null)
  const newRef = useRef<HTMLTextAreaElement>(null)
  const full = tasks.length >= MAX_TASKS

  const remove = (id: string) => {
    if (focused === id) {
      setFocused(null)
      setEditing(false)
    }
    edit((list) => list.filter((t) => t.id !== id), 0)
  }

  const commitNew = (keepFocus: boolean) => {
    const title = adding.trim()
    if (!title) return
    // Cleared before the re-render, so an unmount right after this can't add the task twice.
    pendingNew.current = ''
    edit((list) => (list.length >= MAX_TASKS ? list : [...list, { id: newTaskId(), title }]), 0)
    setAdding('')
    if (keepFocus) newRef.current?.focus()
  }

  // The sheet's task goes through the same edit path as typing, so a pending autosave can't drop it.
  const saveFromSheet = (task: Task) =>
    edit((list) => {
      if (list.some((t) => t.id === task.id)) return list.map((t) => (t.id === task.id ? task : t))
      return list.length >= MAX_TASKS ? list : [...list, task]
    }, 0)

  const openSheet = (id: string | null) => {
    // Commit the title being typed first (its blur saves it), so the sheet starts from what's on screen.
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur()
    const task = id === null ? undefined : latest.current.find((t) => t.id === id)
    if (id !== null && !task) return
    sheet.present(
      (close) => (
        <TaskSheet
          space={space}
          weekId={weekId}
          mode={task ? { kind: 'edit', task } : { kind: 'new' }}
          close={close}
          onSave={saveFromSheet}
          onDelete={(taskId) => edit((list) => list.filter((t) => t.id !== taskId), 0)}
        />
      ),
      { 'aria-label': task ? 'Task details' : 'Plan a task with steps' },
    )
  }

  return (
    <>
      {tasks.map((task, i) => {
        const steps = (task.subtasks ?? []).map((step) => ({ id: step.id, title: step.title, done: done[step.id] === true }))
        const ticked = steps.filter((step) => step.done).length
        const earning = earnings[task.id]
        return (
          <SwipeToDelete key={task.id} onDelete={() => remove(task.id)}>
            <Shimmer trigger={shimmer?.id === task.id ? shimmer.stamp : undefined}>
              <div className={cx('tk-block', steps.length > 0 && 'tk-block--steps')}>
                <div className="s-task">
                  <span className="s-task__lead">
                    {canCheck && steps.length > 0 ? (
                      <StepRing done={ticked} total={steps.length} />
                    ) : canCheck ? (
                      <CheckCircle checked={!!done[task.id]} onChange={(v) => onToggleDone(task.id, v)} aria-label={task.title} />
                    ) : (
                      <span className="s-task__index t-tabular" aria-hidden>
                        {i + 1}
                      </span>
                    )}
                  </span>
                  <span className="s-task__main">
                    <span className="tk-task-body">
                      <TaskTitleInput
                        value={task.title}
                        aria-label={`Task ${i + 1}`}
                        onChange={(title) => edit((list) => list.map((t) => (t.id === task.id ? { ...t, title } : t)))}
                        onFocus={() => {
                          setFocused(task.id)
                          setEditing(true)
                        }}
                        onBlur={() => {
                          setFocused((f) => (f === task.id ? null : f))
                          setEditing(false)
                          // Commit: trimmed, and an emptied title removes the task (like Reminders).
                          edit((list) => list.flatMap((t) => (t.id !== task.id ? [t] : t.title.trim() ? [{ ...t, title: t.title.trim() }] : [])), 0)
                        }}
                        onEnter={() => newRef.current?.focus()}
                        enterKeyHint="next"
                      />
                      {earning && (
                        <span className="tk-meta">
                          <AmountBadge amount={earning.amount} currency={currency} earned={earning.earnedAt !== null} />
                        </span>
                      )}
                    </span>
                    {focused === task.id ? (
                      <button
                        type="button"
                        className="s-task__delete"
                        aria-label={`Delete ${task.title || 'task'}`}
                        // Keep the field focused until the click lands, so the row doesn't jump first.
                        onPointerDown={(e) => e.preventDefault()}
                        onMouseDown={(e) => e.preventDefault()}
                        onClick={() => remove(task.id)}
                      >
                        <Icon name="xmarkCircleFill" size={20} />
                      </button>
                    ) : (
                      canCheck &&
                      steps.length > 0 && (
                        <span className="tk-task-count" aria-hidden>
                          {stepCount(steps)}
                        </span>
                      )
                    )}
                    <button type="button" className="tk-info" aria-label={`Details for ${task.title || 'task'}`} onClick={() => openSheet(task.id)}>
                      <Icon name="info" size={22} />
                    </button>
                  </span>
                </div>
                {steps.length > 0 && <StepList steps={steps} mode={canCheck ? 'check' : 'bullet'} onToggle={onToggleDone} onOpen={() => openSheet(task.id)} />}
              </div>
            </Shimmer>
          </SwipeToDelete>
        )
      })}
      {!full && (
        <>
          <div className="s-task s-task--new">
            <span className="s-task__lead s-task__plus" aria-hidden>
              <Icon name="plus" size={20} weight={2.2} />
            </span>
            <span className="s-task__main">
              <TaskTitleInput
                inputRef={newRef}
                value={adding}
                onChange={setAdding}
                placeholder={tasks.length === 0 ? 'Add your first task' : 'Add a task'}
                aria-label="New task"
                enterKeyHint="done"
                onEnter={() => commitNew(true)}
                onBlur={() => commitNew(false)}
              />
            </span>
          </div>
          <Row
            leading={
              <span className="tk-action-icon" aria-hidden>
                <Icon name="listIndent" size={22} />
              </span>
            }
            title="Add Task with Steps"
            action
            onPress={() => openSheet(null)}
          />
        </>
      )}
    </>
  )
}
