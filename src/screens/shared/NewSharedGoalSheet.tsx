// New Shared Goal (SPEC §11.9.5): a name, a target with its unit, an optional last day, and friends to invite.
// Create checks the goal (goalProblem) and shows what's wrong inline; on success the caller pushes the new goal.
import { useCallback, useState } from 'react'
import { createSharedGoal, useCurrency } from '../../data/api.ts'
import { amountProblem, amountProblemText, goalProblem, goalProblemText, parseGoalAmount } from '../../domain/shared.ts'
import type { UID } from '../../domain/types.ts'
import { ActivityIndicator, GlassButton, Screen, useNav, useSheet, useToast } from '../../ui/index.ts'
import { useNow } from '../components/clock.ts'
import { MAX_INVITES, newInviteFooter, NO_FRIENDS, TARGET_FOOTER, todayId } from './copy.ts'
import { FriendPicker, GoalFields, errorText, useFriendsList } from './parts.tsx'
import type { GoalDraft, GoalErrors } from './parts.tsx'
import { SharedGoalScreen } from './SharedGoalScreen.tsx'

/**
 * Presents New Shared Goal from the caller's sheet context; once created, the goal is pushed on the caller's
 * navigation stack with the toast "Goal created" (· "Invites sent").
 */
export function useNewSharedGoal(): () => void {
  const { present } = useSheet()
  const { push } = useNav()
  const toast = useToast()
  return useCallback(() => {
    present((close) => (
      <NewSharedGoalSheet
        close={close}
        onCreated={(goalId, name, invited) => {
          push(<SharedGoalScreen goalId={goalId} />, { title: name })
          toast({
            title: 'Goal created',
            message: invited > 0 ? 'Invites sent' : undefined,
            icon: 'checkmark',
            tone: 'success',
          })
        }}
      />
    ))
  }, [present, push, toast])
}

interface Props {
  close: () => void
  /** After the goal is created (the sheet has closed). */
  onCreated: (goalId: string, name: string, invited: number) => void
}

export function NewSharedGoalSheet({ close, onCreated }: Props) {
  const currency = useCurrency()
  const nowMs = useNow()
  const minDay = todayId(nowMs)
  const { friends, loaded } = useFriendsList()
  const [draft, setDraft] = useState<GoalDraft>({
    name: '',
    target: '',
    unit: '',
    ends: false,
    endsOn: '',
  })
  const [invite, setInvite] = useState<UID[]>([])
  const [errors, setErrors] = useState<GoalErrors>({})
  const [busy, setBusy] = useState(false)
  const ready = draft.name.trim() !== '' && draft.target.trim() !== '' && draft.unit.trim() !== ''

  const toggle = (uid: UID) => setInvite((list) => (list.includes(uid) ? list.filter((u) => u !== uid) : list.length >= MAX_INVITES ? list : [...list, uid]))

  const create = async () => {
    if (!ready || busy) return
    const amount = amountProblem(draft.target)
    const target = parseGoalAmount(draft.target)
    const problem = goalProblem({ name: draft.name, unit: draft.unit, target })
    const next: GoalErrors = {}
    if (problem === 'name' || problem === 'name-long') next.name = goalProblemText(problem)
    if (amount === 'format') next.target = amountProblemText(amount)
    else if (problem === 'target' || problem === 'target-big') next.target = goalProblemText(problem)
    if (problem === 'unit' || problem === 'unit-long') next.unit = goalProblemText(problem)
    setErrors(next)
    if (next.name || next.target || next.unit || target === null) return
    setBusy(true)
    try {
      const name = draft.name.trim()
      const id = await createSharedGoal({
        name,
        unit: draft.unit.trim(),
        target,
        endsOn: draft.ends ? draft.endsOn || minDay : null,
        invite,
      })
      close()
      onCreated(id, name, invite.length)
    } catch (e) {
      setErrors({ name: errorText(e) })
      setBusy(false)
    }
  }

  return (
    <Screen
      title="New Shared Goal"
      titleDisplay="inline"
      leading={<GlassButton icon="xmark" aria-label="Cancel" onClick={close} />}
      trailing={
        busy ? (
          <span className="s-bar-spinner">
            <ActivityIndicator color="var(--secondary-label)" label="Creating" />
          </span>
        ) : (
          <GlassButton prominent icon="checkmark" aria-label="Create" onClick={() => void create()} disabled={!ready} />
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
        targetFooter={TARGET_FOOTER}
        minDay={minDay}
        nowMs={nowMs}
        autoFocus="name"
      />
      {loaded && (
        <FriendPicker
          header="Invite Friends"
          friends={friends}
          selected={invite}
          onToggle={toggle}
          max={MAX_INVITES}
          footer={newInviteFooter(invite.length)}
          empty={NO_FRIENDS}
        />
      )}
    </Screen>
  )
}
