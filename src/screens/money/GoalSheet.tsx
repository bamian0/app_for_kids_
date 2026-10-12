// A goal: its name and cost, and for one that exists, where it sits in the order, Delete, and once
// the money is there, Mark as Bought (spends its cost and removes it).
import { useRef, useState } from 'react'
import { deleteGoal, markGoalBought, reorderGoals, saveGoal, useEarnings, useGoals, useMoneyState, useMoves } from '../../data/api.ts'
import { balanceOf, formatMoney, fundGoals, weeklyPace } from '../../domain/money.ts'
import type { CurrencyCode, Goal } from '../../domain/types.ts'
import { GlassButton, ProgressBar, Row, Screen, Section, TextFieldRow, useAlert, useToast } from '../../ui/index.ts'
import { ErrorText } from '../components/Bits.tsx'
import { useNow } from '../components/clock.ts'
import { MoneyField } from '../components/MoneyField.tsx'
import { goalLine } from './goals.ts'
import { errorText, quickWrite } from './write.ts'

export interface GoalSheetProps {
  /** The goal to edit; omit for a new one. */
  goal?: Goal
  currency: CurrencyCode
  close: () => void
}

const MAX_NAME = 60

export function GoalSheet({ goal, currency, close }: GoalSheetProps) {
  const toast = useToast()
  const [name, setName] = useState(goal?.name ?? '')
  const [cost, setCost] = useState<number | null>(goal?.cost ?? null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const costRef = useRef<HTMLInputElement>(null)

  const clean = name.trim()
  const valid = clean.length > 0 && cost !== null && cost > 0
  const changed = !goal || clean !== goal.name || cost !== goal.cost

  const save = async () => {
    if (!valid || busy) return
    if (!changed) {
      close()
      return
    }
    setBusy(true)
    setError(null)
    try {
      await quickWrite(saveGoal({ id: goal?.id, name: clean, cost }), (e) => toast({ title: 'Couldn’t save the goal', message: errorText(e), tone: 'error' }))
      close()
    } catch (e) {
      setError(errorText(e))
      setBusy(false)
    }
  }

  return (
    <Screen
      title={goal ? 'Edit Goal' : 'New Goal'}
      titleDisplay="inline"
      leading={<GlassButton icon="xmark" aria-label="Cancel" onClick={close} />}
      trailing={<GlassButton prominent icon="checkmark" aria-label={goal ? 'Save' : 'Add'} disabled={!valid || busy} onClick={() => void save()} />}
    >
      <Section footer={error ? <ErrorText>{error}</ErrorText> : goal ? undefined : 'New goals go to the bottom. Your balance fills them from the top.'}>
        <TextFieldRow
          className="m-field-end"
          label="Name"
          labelWidth={72}
          value={name}
          onChange={setName}
          placeholder="Sony FX3"
          maxLength={MAX_NAME}
          autoCapitalize="sentences"
          autoFocus={!goal}
          enterKeyHint="next"
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.nativeEvent.isComposing) costRef.current?.focus()
          }}
        />
        <MoneyField label="Cost" value={cost} onChange={setCost} currency={currency} inputRef={costRef} />
      </Section>
      {goal && <GoalActions goal={goal} currency={currency} close={close} />}
    </Screen>
  )
}

function GoalActions({ goal, currency, close }: { goal: Goal; currency: CurrencyCode; close: () => void }) {
  const toast = useToast()
  const { confirm } = useAlert()
  const nowMs = useNow()
  const goals = useGoals().data ?? []
  const state = useMoneyState().data ?? null
  const earnings = useEarnings().data ?? []
  const moves = useMoves().data ?? []
  const funded = fundGoals(goals, balanceOf(state, earnings, moves), weeklyPace(earnings, moves, nowMs))
  const index = funded.findIndex((f) => f.goal.id === goal.id)
  const mine = funded[index]
  // Deleted or bought on another device: nothing left to act on.
  if (!mine) return null

  const move = (by: -1 | 1) => {
    const ids = funded.map((f) => f.goal.id)
    const to = index + by
    if (to < 0 || to >= ids.length) return
    ;[ids[index], ids[to]] = [ids[to], ids[index]]
    reorderGoals(ids).catch((e: unknown) => toast({ title: 'Couldn’t move the goal', message: errorText(e), tone: 'error' }))
  }

  const buy = async () => {
    const ok = await confirm({
      title: `Mark “${mine.goal.name}” as bought?`,
      message: `${formatMoney(mine.goal.cost, currency)} comes off your balance and the goal is removed.`,
      confirmLabel: 'Mark as Bought',
    })
    if (!ok) return
    close()
    markGoalBought(mine.goal).catch((e: unknown) => toast({ title: 'Couldn’t mark it as bought', message: errorText(e), tone: 'error' }))
  }

  const remove = async () => {
    const ok = await confirm({
      title: `Delete “${mine.goal.name}”?`,
      message: 'Your balance stays as it is.',
      confirmLabel: 'Delete',
      destructive: true,
    })
    if (!ok) return
    close()
    deleteGoal(goal.id).catch((e: unknown) => toast({ title: 'Couldn’t delete the goal', message: errorText(e), tone: 'error' }))
  }

  return (
    <>
      <Section header="Progress">
        <div className="m-goal-progress">
          <div className="m-goal-progress__numbers t-tabular">
            <span className="m-goal-progress__funded">{formatMoney(mine.funded, currency)}</span>
            <span className="m-goal-progress__of">of {formatMoney(mine.goal.cost, currency)}</span>
          </div>
          <ProgressBar value={mine.progress} tone={mine.complete ? 'iridescent' : 'label'} label={`${Math.floor(mine.progress * 100)} percent funded`} />
          <div className="m-goal-progress__line">{goalLine(mine, currency)}</div>
        </div>
      </Section>
      {funded.length > 1 && (
        <Section footer="Your balance fills goals from the top.">
          <Row icon="arrowUp" title="Move Up" disabled={index === 0} onPress={() => move(-1)} />
          <Row icon="arrowDown" title="Move Down" disabled={index === funded.length - 1} onPress={() => move(1)} />
        </Section>
      )}
      {mine.complete && (
        <Section footer={`Adds a ${formatMoney(mine.goal.cost, currency)} spend and removes the goal.`}>
          <Row icon="bag" title="Mark as Bought" action onPress={() => void buy()} />
        </Section>
      )}
      <Section>
        <Row title="Delete Goal" destructive onPress={() => void remove()} />
      </Section>
    </>
  )
}
