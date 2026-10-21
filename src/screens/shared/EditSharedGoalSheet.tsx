// Edit Goal (owner, SPEC §11.9.5): name, target and unit, end date. The target's footer says when the change flips
// whether the goal shows as reached; Keep Going opens it on the target, asking to raise it.
import { useState } from 'react'
import { editSharedGoal, useCurrency, useSharedGoal } from '../../data/api.ts'
import { amountProblem, amountProblemText, goalProblem, goalProblemText, parseGoalAmount, toHundredths } from '../../domain/shared.ts'
import type { SharedGoal, SharedGoalPatch } from '../../domain/types.ts'
import { ActivityIndicator, GlassButton, Screen } from '../../ui/index.ts'
import { useNow } from '../components/clock.ts'
import { editTargetFooter, KEEP_GOING_FOOTER, todayId } from './copy.ts'
import { GoalFields, editText, errorText } from './parts.tsx'
import type { GoalDraft, GoalErrors } from './parts.tsx'

interface Props {
  goal: SharedGoal
  close: () => void
  /** Keep Going: the target field first, with "Raise the target to keep going." */
  keepGoing?: boolean
}

export function EditSharedGoalSheet({ goal: initial, close, keepGoing }: Props) {
  const goal = useSharedGoal(initial.id).data ?? initial
  const currency = useCurrency()
  const nowMs = useNow()
  const today = todayId(nowMs)
  const [draft, setDraft] = useState<GoalDraft>(() => ({
    name: initial.name,
    target: editText(initial.target),
    unit: initial.unit,
    ends: initial.endsOn !== null,
    endsOn: initial.endsOn ?? '',
  }))
  const [errors, setErrors] = useState<GoalErrors>({})
  const [busy, setBusy] = useState(false)
  // A past last day stays choosable as it is; a new one starts today.
  const minDay = initial.endsOn !== null && initial.endsOn < today ? initial.endsOn : today

  const target = parseGoalAmount(draft.target)
  const ready = draft.name.trim() !== '' && draft.target.trim() !== '' && draft.unit.trim() !== ''
  const warning = editTargetFooter(goal, target)

  const save = async () => {
    if (!ready || busy) return
    const amount = amountProblem(draft.target)
    const problem = goalProblem({ name: draft.name, unit: draft.unit, target })
    const next: GoalErrors = {}
    if (problem === 'name' || problem === 'name-long') next.name = goalProblemText(problem)
    if (amount === 'format') next.target = amountProblemText(amount)
    else if (problem === 'target' || problem === 'target-big') next.target = goalProblemText(problem)
    if (problem === 'unit' || problem === 'unit-long') next.unit = goalProblemText(problem)
    setErrors(next)
    if (next.name || next.target || next.unit || target === null) return
    const patch: SharedGoalPatch = {}
    const name = draft.name.trim()
    const unit = draft.unit.trim()
    const endsOn = draft.ends ? draft.endsOn || today : null
    if (name !== goal.name) patch.name = name
    if (unit !== goal.unit) patch.unit = unit
    if (toHundredths(target) !== toHundredths(goal.target)) patch.target = target
    if (endsOn !== goal.endsOn) patch.endsOn = endsOn
    if (Object.keys(patch).length === 0) {
      close()
      return
    }
    setBusy(true)
    try {
      await editSharedGoal(goal.id, patch)
      close()
    } catch (e) {
      setErrors({ name: errorText(e) })
      setBusy(false)
    }
  }

  return (
    <Screen
      title="Edit Goal"
      titleDisplay="inline"
      leading={<GlassButton icon="xmark" aria-label="Cancel" onClick={close} />}
      trailing={
        busy ? (
          <span className="s-bar-spinner">
            <ActivityIndicator color="var(--secondary-label)" label="Saving" />
          </span>
        ) : (
          <GlassButton prominent icon="checkmark" aria-label="Save" onClick={() => void save()} disabled={!ready} />
        )
      }
    >
      <GoalFields
        draft={draft}
        onChange={(d) => {
          setDraft(d)
          if (errors.name || errors.target || errors.unit) setErrors({})
        }}
        currency={currency}
        errors={errors}
        targetFooter={warning ?? (keepGoing ? KEEP_GOING_FOOTER : undefined)}
        minDay={minDay}
        nowMs={nowMs}
        autoFocus={keepGoing ? 'target' : undefined}
      />
    </Screen>
  )
}
