// Goals: the money you have, what you're saving for (filled top first), and the money in and out.
// All of it is private: friends never see amounts, balances or goals.
import { useEffect, useMemo, useState } from 'react'
import { deleteMove, setBaseline, useCurrency, useEarnings, useGoals, useMoneyState, useMoves, useMySpaces } from '../data/api.ts'
import { balanceOf, earnedInMonth, formatMoney, fundGoals, moneyActivity, weeklyPace } from '../domain/money.ts'
import type { FundedGoal, MoneyActivity } from '../domain/money.ts'
import { monthIdForWeek } from '../domain/time.ts'
import type { CurrencyCode, Earning, Goal, MoneyMove, MoneyState } from '../domain/types.ts'
import { Button, EmptyState, GlassButton, Icon, ProgressBar, Row, Screen, Section, Shimmer, cx, useAlert, useSheet, useToast } from '../ui/index.ts'
import type { IconName } from '../ui/index.ts'
import { usePress } from '../ui/press.ts'
import { ErrorText, Loading } from './components/Bits.tsx'
import { useNow } from './components/clock.ts'
import { MoneyField } from './components/MoneyField.tsx'
import { firstTime } from './components/storage.ts'
import { SwipeToDelete } from './components/SwipeToDelete.tsx'
import { BalanceSheet } from './money/BalanceSheet.tsx'
import { CurrencySheet } from './money/CurrencySheet.tsx'
import { activityDate, moneyWeekId } from './money/format.ts'
import { HelpButton } from './help/HelpSheet.tsx'
import { GoalSheet } from './money/GoalSheet.tsx'
import { goalLine } from './money/goals.ts'
import { MoveSheet } from './money/MoveSheet.tsx'
import { errorText, quickWrite } from './money/write.ts'
import './money.css'

/** Activity rows shown before "Show All". */
const ACTIVITY_PAGE = 20

export function GoalsScreen() {
  const sheet = useSheet()
  const nowMs = useNow()
  const currency = useCurrency()
  const state = useMoneyState()
  const earnings = useEarnings()
  const moves = useMoves()
  const goals = useGoals()

  const error = state.error ?? earnings.error ?? moves.error ?? goals.error
  const loaded = state.data !== undefined && earnings.data !== undefined && moves.data !== undefined && goals.data !== undefined

  const newGoal = () => sheet.present((close) => <GoalSheet currency={currency} close={close} />)

  return (
    <Screen title="Goals" leading={<HelpButton />} trailing={<GlassButton icon="plus" aria-label="New goal" onClick={newGoal} />}>
      {!loaded ? (
        error ? (
          <EmptyState icon="info" title="Can’t load your money" message={error.message} />
        ) : (
          <Loading />
        )
      ) : (
        <GoalsContent
          currency={currency}
          nowMs={nowMs}
          state={state.data ?? null}
          earnings={earnings.data ?? []}
          moves={moves.data ?? []}
          goals={goals.data ?? []}
          onNewGoal={newGoal}
        />
      )}
    </Screen>
  )
}

interface ContentProps {
  currency: CurrencyCode
  nowMs: number
  state: MoneyState | null
  earnings: Earning[]
  moves: MoneyMove[]
  goals: Goal[]
  onNewGoal: () => void
}

function GoalsContent({ currency, nowMs, state, earnings, moves, goals, onNewGoal }: ContentProps) {
  const sheet = useSheet()
  const { actionSheet } = useAlert()
  const balance = balanceOf(state, earnings, moves)
  const funded = fundGoals(goals, balance, weeklyPace(earnings, moves, nowMs))
  const activity = moneyActivity(state, earnings, moves)
  // Nothing to count from yet: the card asks what you have instead.
  const firstRun = state?.baseline == null && activity.length === 0
  const earnedThisMonth = earnedInMonth(earnings, monthIdForWeek(moneyWeekId(nowMs)))

  const openMove = (kind: 'add' | 'spend') => sheet.present((close) => <MoveSheet kind={kind} currency={currency} balance={balance} close={close} />)
  const openBalance = () => sheet.present((close) => <BalanceSheet currency={currency} balance={balance} close={close} />)
  const openCurrency = () => sheet.present((close) => <CurrencySheet currency={currency} close={close} />)
  const openGoal = (goal: Goal) => sheet.present((close) => <GoalSheet goal={goal} currency={currency} close={close} />)

  const menu = async () => {
    const choice = await actionSheet({ actions: [{ label: 'Set Balance' }, { label: 'Currency' }] })
    if (choice === 'Set Balance') openBalance()
    if (choice === 'Currency') openCurrency()
  }

  return (
    <>
      {firstRun ? (
        <FirstRun currency={currency} onCurrency={openCurrency} />
      ) : (
        <div className="m-balance">
          <div className="m-balance__head">
            <span className="m-balance__label">Balance</span>
            <button type="button" className="m-balance__menu" aria-label="Balance options" onClick={() => void menu()}>
              <Icon name="ellipsis" size={19} weight={2} />
            </button>
          </div>
          <div className={cx('m-balance__value t-tabular', balance < 0 && 'is-negative')}>{formatMoney(balance, currency)}</div>
          {earnedThisMonth > 0 && (
            <div className="m-balance__earned t-tabular">{`${formatMoney(earnedThisMonth, currency, { signed: true })} earned from tasks this month`}</div>
          )}
          <div className="m-balance__actions">
            <Button variant="gray" fullWidth onClick={() => openMove('add')}>
              Add Money
            </Button>
            <Button variant="gray" fullWidth onClick={() => openMove('spend')}>
              Remove Money
            </Button>
          </div>
        </div>
      )}

      <Section
        header="Saving For"
        headerStyle="prominent"
        footer={funded.length > 1 ? 'Your balance fills goals from the top. Tap one to change its place.' : undefined}
      >
        {funded.length === 0 ? (
          <>
            <div className="m-note">
              <span className="m-note__icon" aria-hidden>
                <Icon name="target" size={28} weight={1.7} />
              </span>
              <span className="m-note__title">What are you saving for?</span>
              <span className="m-note__text">Add a goal with what it costs, and see how close your money gets you.</span>
            </div>
            <Row title="Add Goal" action leading={<Icon name="plus" size={20} weight={2.2} />} onPress={onNewGoal} />
          </>
        ) : (
          funded.map((f) => <GoalRow key={f.goal.id} funded={f} currency={currency} onOpen={() => openGoal(f.goal)} />)
        )}
      </Section>

      {activity.length > 0 && <ActivitySection activity={activity} currency={currency} nowMs={nowMs} />}
    </>
  )
}

// ---------- First run ----------

function FirstRun({ currency, onCurrency }: { currency: CurrencyCode; onCurrency: () => void }) {
  const toast = useToast()
  const [amount, setAmount] = useState<number | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const save = async (value: number) => {
    setBusy(true)
    setError(null)
    try {
      await quickWrite(setBaseline(value), (e) => toast({ title: 'Couldn’t set your balance', message: errorText(e), tone: 'error' }))
    } catch (e) {
      setError(errorText(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <Section footer={error ? <ErrorText>{error}</ErrorText> : 'Count your accounts and cash. From then on, what you add, spend and earn from tasks keeps it up to date. Only you see it.'}>
        <div className="m-ask">
          <span className="m-note__icon" aria-hidden>
            <Icon name="banknote" size={28} weight={1.7} />
          </span>
          <span className="m-ask__title">How much do you have right now?</span>
        </div>
        <MoneyField label="Balance" value={amount} onChange={setAmount} currency={currency} />
        <Row title="Currency" detail={currency} chevron onPress={onCurrency} />
      </Section>
      <div className="m-form-actions">
        <Button size="large" fullWidth disabled={amount === null} loading={busy} onClick={() => amount !== null && void save(amount)}>
          Set Balance
        </Button>
      </div>
    </>
  )
}

// ---------- Goals ----------

function GoalRow({ funded, currency, onOpen }: { funded: FundedGoal; currency: CurrencyCode; onOpen: () => void }) {
  const { pressed, handlers } = usePress(true)
  const { goal, complete } = funded
  // The moment a goal is funded, once per goal on this device: a single prism sweep.
  const [moment, setMoment] = useState<string | undefined>()
  useEffect(() => {
    if (complete && firstTime(`goalFunded.${goal.id}`)) setMoment(goal.id)
  }, [complete, goal.id])

  return (
    <Shimmer trigger={moment}>
      <button type="button" className="m-goal" data-pressed={pressed || undefined} onClick={onOpen} {...handlers}>
        <span className="m-goal__main">
          <span className="m-goal__top">
            <span className="m-goal__name">{goal.name}</span>
            <span className="m-goal__cost t-tabular">{formatMoney(goal.cost, currency)}</span>
          </span>
          <ProgressBar
            className="m-goal__bar"
            value={funded.progress}
            tone={complete ? 'iridescent' : 'label'}
            label={`${goal.name}: ${Math.floor(funded.progress * 100)} percent funded`}
          />
          <span className={cx('m-goal__line t-tabular', complete && 'is-funded')}>
            {complete && <Icon name="checkmarkCircleFill" size={15} weight={2} />}
            {goalLine(funded, currency)}
          </span>
        </span>
        <Icon name="chevronRight" size={20} weight={2.6} className="m-goal__chevron" />
      </button>
    </Shimmer>
  )
}

// ---------- Activity ----------

function ActivitySection({ activity, currency, nowMs }: { activity: MoneyActivity[]; currency: CurrencyCode; nowMs: number }) {
  const toast = useToast()
  const spaces = useMySpaces()
  const [all, setAll] = useState(false)
  const names = useMemo(() => new Map((spaces.data ?? []).map((s) => [s.id, s.name])), [spaces.data])
  const shown = all ? activity : activity.slice(0, ACTIVITY_PAGE)

  const remove = (id: string) =>
    deleteMove(id).catch((e: unknown) => toast({ title: 'Couldn’t delete it', message: errorText(e), tone: 'error' }))

  return (
    <Section className="m-activity" header="Activity" headerStyle="prominent" footer="Swipe left on money you added or removed to undo it.">
      {shown.map((item) => {
        const row = <ActivityRow item={item} currency={currency} nowMs={nowMs} names={names} />
        // Only money moved by hand can be undone; earnings follow their task.
        return item.kind === 'add' || item.kind === 'spend' ? (
          <SwipeToDelete key={item.id} onDelete={() => void remove(item.id)}>
            {row}
          </SwipeToDelete>
        ) : (
          <div key={item.id}>{row}</div>
        )
      })}
      {activity.length > shown.length && <Row title="Show All" action onPress={() => setAll(true)} />}
    </Section>
  )
}

function ActivityRow({ item, currency, nowMs, names }: { item: MoneyActivity; currency: CurrencyCode; nowMs: number; names: Map<string, string> }) {
  const when = activityDate(item.at, nowMs)
  let icon: IconName
  let title: string
  let subtitle: string
  let amount: string
  switch (item.kind) {
    case 'earning': {
      const space = names.get(item.earning.spaceId)
      icon = 'banknote'
      title = item.earning.title
      subtitle = space ? `${space} · ${when}` : when
      amount = formatMoney(item.amount, currency, { signed: true })
      break
    }
    case 'add':
    case 'spend': {
      const added = item.kind === 'add'
      const note = item.move.note.trim()
      icon = added ? 'plus' : 'minus'
      title = note || (added ? 'Added' : 'Removed')
      subtitle = note ? `${added ? 'Added' : 'Removed'} · ${when}` : when
      amount = formatMoney(added ? item.amount : -item.amount, currency, { signed: true })
      break
    }
    case 'baseline':
      icon = 'pencil'
      title = 'Balance set'
      subtitle = when
      amount = formatMoney(item.amount, currency)
      break
  }
  return (
    <Row
      leading={
        <span className="m-activity-icon" aria-hidden>
          <Icon name={icon} size={item.kind === 'earning' ? 19 : 16} weight={item.kind === 'earning' ? 1.8 : 2.2} />
        </span>
      }
      title={title}
      titleLines={2}
      subtitle={subtitle}
      detail={<span className={cx('m-amount', item.kind === 'baseline' && 'is-muted')}>{amount}</span>}
    />
  )
}
