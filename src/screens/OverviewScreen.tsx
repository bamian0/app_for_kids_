// Overview: your week across every space, what your tasks earned, and where each month stands.
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useAuth, useCurrency, useEarnings, useMonth, useMySpaces } from '../data/api.ts'
import { earnedByWeek, earnedInMonth, formatMoney, pendingIn, topEarnings, totalEarned } from '../domain/money.ts'
import { computeMonth, computeWeek, joinedAfterLock } from '../domain/scoring.ts'
import { addWeeks, formatWeekRange, monthIdForWeek, weekBounds, weekIdFor } from '../domain/time.ts'
import type { CurrencyCode, Earning, Space, UID } from '../domain/types.ts'
import { EmptyState, Icon, Row, ScoreRing, Screen, Section, cx, useNav, useTabBar } from '../ui/index.ts'
import { Loading, MiniScore } from './components/Bits.tsx'
import { useNow } from './components/clock.ts'
import { formatScore, monthName, wholePercent } from './components/format.ts'
import { currentMonth } from './components/month.ts'
import { spaceStatus } from './components/status.ts'
import { deadlineDay } from './components/zone.ts'
import { EarningsChart } from './money/EarningsChart.tsx'
import { moneyWeekId, weekLabel } from './money/format.ts'
import { SpaceScreen } from './SpaceScreen.tsx'
import './money.css'

/** Your tasks in one space this week: how many, how many done, and the done share with steps as fractions. */
interface WeekTally {
  tasks: number
  done: number
  fraction: number
}

const CHART_WEEKS = 8
const TOP_EARNINGS = 3
/** From here a stat goes compact ('$123K', '֏5.3M'): three columns can't hold more digits on a phone. */
const COMPACT_FROM = 100_000

export function OverviewScreen() {
  const nav = useNav()
  const auth = useAuth()
  const uid = auth.uid ?? ''
  const spaces = useMySpaces()
  const nowMs = useNow()
  const [tallies, setTallies] = useState<Record<string, WeekTally>>({})
  const list = spaces.data

  // Each space counts its week in its own row (hooks can't run in a loop) and reports it here.
  const report = useCallback((spaceId: string, tally: WeekTally | null) => {
    setTallies((all) => {
      const old = all[spaceId]
      if (tally === null) {
        if (!old) return all
        const { [spaceId]: _gone, ...rest } = all
        return rest
      }
      return old && old.tasks === tally.tasks && old.done === tally.done && old.fraction === tally.fraction ? all : { ...all, [spaceId]: tally }
    })
  }, [])

  const open = (space: Space, month?: boolean) =>
    nav.push(<SpaceScreen spaceId={space.id} initialTab={month ? 'month' : undefined} />, { title: space.name })

  const names = useMemo(() => Object.fromEntries((list ?? []).map((s) => [s.id, s.name])), [list])

  return (
    <Screen title="Overview" subtitle={`Week of ${formatWeekRange(moneyWeekId(nowMs))}`}>
      {list === undefined ? (
        spaces.error ? (
          <EmptyState icon="info" title="Can’t load your spaces" message={spaces.error.message} />
        ) : (
          <Loading />
        )
      ) : list.length === 0 ? (
        <Section header="This Week" headerStyle="prominent">
          <div className="m-note">
            <span className="m-note__icon" aria-hidden>
              <Icon name="squareStack" size={26} weight={1.8} />
            </span>
            <span className="m-note__title">Your week shows up here</span>
            <span className="m-note__text">Start or join a space in Spaces, plan your tasks, and see how the week is going across all of them.</span>
          </div>
        </Section>
      ) : (
        <Section header="This Week" headerStyle="prominent">
          <WeekHero tallies={list.map((s) => tallies[s.id])} spaces={list.length} />
          {list.map((space) => (
            <SpaceWeekRow key={space.id} space={space} uid={uid} report={report} onOpen={() => open(space)} />
          ))}
        </Section>
      )}

      <MoneySection names={names} />

      {list && list.length > 0 && (
        <Section header="This Month" headerStyle="prominent" footer={`Scores for ${monthName(currentMonth(list[0], nowMs))} so far, from finished weeks minus missed reviews. The bar is 90%.`}>
          {list.map((space) => (
            <SpaceMonthRow key={space.id} space={space} uid={uid} onOpen={() => open(space, true)} />
          ))}
        </Section>
      )}
    </Screen>
  )
}

// ---------- This week ----------

function WeekHero({ tallies, spaces }: { tallies: (WeekTally | undefined)[]; spaces: number }) {
  const loaded = tallies.every((t) => t !== undefined)
  const sum: WeekTally = { tasks: 0, done: 0, fraction: 0 }
  for (const t of tallies) {
    sum.tasks += t?.tasks ?? 0
    sum.done += t?.done ?? 0
    sum.fraction += t?.fraction ?? 0
  }
  const value = loaded && sum.tasks > 0 ? (100 * sum.fraction) / sum.tasks : null
  const caption = !loaded ? 'Loading…' : sum.tasks === 0 ? 'No tasks this week' : `${sum.done} of ${sum.tasks} ${sum.tasks === 1 ? 'task' : 'tasks'} done`
  const note = spaces === 1 ? 'Ticked steps count toward their task.' : `Across ${spaces} spaces. Ticked steps count toward their task.`
  return (
    <div className="m-week-hero">
      {/* Your own check-offs, so it stays graphite like any provisional score. */}
      <ScoreRing key={value == null ? 'empty' : 'value'} value={value} iridescent={false} size={168} stroke={16} aria-label={value == null ? caption : `${caption}, ${formatScore(value)}`}>
        {value == null ? (
          <span className="m-week-hero__value is-empty">—</span>
        ) : (
          <span className="m-week-hero__value t-tabular">
            {wholePercent(value)}
            <span className="m-week-hero__percent">%</span>
          </span>
        )}
      </ScoreRing>
      <div className="m-week-hero__caption t-tabular">{caption}</div>
      {loaded && sum.tasks > 0 && <div className="m-week-hero__note">{note}</div>}
    </div>
  )
}

function SpaceWeekRow({ space, uid, report, onOpen }: { space: Space; uid: UID; report: (id: string, tally: WeekTally | null) => void; onOpen: () => void }) {
  const nowMs = useNow()
  const weekId = weekIdFor(nowMs, space.timezone)
  const month = useMonth(space, monthIdForWeek(weekId))
  const data = month.data?.find((w) => w.weekId === weekId)
  const bounds = data?.week ?? weekBounds(weekId, space.timezone)
  const result = data ? computeWeek(data, space, nowMs) : null
  const me = result?.members[uid]

  const tasks = me?.participating ? me.tasks : []
  const done = tasks.filter((t) => t.selfDone).length
  const fraction = tasks.reduce((total, t) => total + t.selfFraction, 0)
  const ready = result !== null
  useEffect(() => {
    if (ready) report(space.id, { tasks: tasks.length, done, fraction })
  }, [ready, report, space.id, tasks.length, done, fraction])
  useEffect(() => () => report(space.id, null), [report, space.id])

  const status = result
    ? spaceStatus(result, bounds, uid, nowMs, {
        memberIds: space.memberIds,
        joinedLate: joinedAfterLock(space, uid, bounds.lockAt),
        nextWeekTasks: null,
        nextLock: deadlineDay(weekBounds(addWeeks(weekId, 1), space.timezone).lockAt, space.timezone),
      })
    : null
  // From Monday 00:00 ticks count, like the ring above; a list that's still empty has no score to show.
  const showsScore = !!me?.participating && (me.score != null || me.taskCount > 0)
  const score = showsScore ? (me.score ?? me.provisionalScore) : null
  const revealed = me?.score != null

  return (
    <Row
      title={<span className="t-semibold">{space.name}</span>}
      subtitle={
        status ? (
          <span className={cx('m-status', `s-tone-${status.tone}`)}>
            <Icon name={status.icon} size={14} weight={2.2} />
            <span>{status.text}</span>
          </span>
        ) : (
          'Loading…'
        )
      }
      accessory={<MiniScore value={score} threshold={space.threshold} caption={score == null ? undefined : revealed ? 'Score' : 'Provisional'} iridescent={revealed} />}
      chevron
      onPress={onOpen}
    />
  )
}

// ---------- This month ----------

function SpaceMonthRow({ space, uid, onOpen }: { space: Space; uid: UID; onOpen: () => void }) {
  const nowMs = useNow()
  const monthId = currentMonth(space, nowMs)
  const month = useMonth(space, monthId)
  const mine = month.data ? computeMonth(space, monthId, month.data, nowMs)[uid] : undefined

  let line = 'Loading…'
  let tone: 'default' | 'urgent' | 'done' = 'default'
  if (mine) {
    const score = mine.finalScore
    if (score === null) line = 'No finished weeks yet'
    else {
      const short = space.threshold - wholePercent(score)
      const points = `${short} ${short === 1 ? 'point' : 'points'}`
      if (mine.complete) line = short <= 0 ? 'Cleared the bar' : `Missed by ${points}`
      else line = short <= 0 ? 'On track' : `${points} short`
      // Short of the bar mid-month is a nudge; red is kept for a month that's over.
      tone = short <= 0 ? 'done' : mine.complete ? 'urgent' : 'default'
    }
  }

  return (
    <Row
      title={<span className="t-semibold">{space.name}</span>}
      subtitle={<span className={cx('m-status', `s-tone-${tone}`)}>{line}</span>}
      accessory={<MiniScore value={mine?.finalScore ?? null} threshold={space.threshold} caption={mine?.finalScore == null ? undefined : mine.complete ? 'Month' : 'So far'} />}
      chevron
      onPress={onOpen}
    />
  )
}

// ---------- Money ----------

function MoneySection({ names }: { names: Record<string, string> }) {
  const tabs = useTabBar()
  const nowMs = useNow()
  const currency = useCurrency()
  const earnings = useEarnings()
  const toGoals = () => tabs?.select('goals')
  const goalsRow = <Row icon="target" iconBackground="var(--system-gray)" title="Goals" chevron onPress={toGoals} />

  const all = earnings.data
  if (all === undefined) {
    return (
      <Section header="Money" headerStyle="prominent">
        {earnings.error ? <Row title="Can’t load your earnings" subtitle={earnings.error.message} /> : <Loading />}
      </Section>
    )
  }

  if (all.length === 0) {
    return (
      <Section header="Money" headerStyle="prominent" footer="Only you see your amounts and goals.">
        <div className="m-note">
          <span className="m-note__icon" aria-hidden>
            <Icon name="banknote" size={28} weight={1.7} />
          </span>
          <span className="m-note__title">See what your work earns</span>
          <span className="m-note__text">In Spaces, tap ⓘ next to one of your tasks, turn on Generates revenue and enter what it pays. When you tick it off, the money shows up here.</span>
        </div>
        {goalsRow}
      </Section>
    )
  }

  const thisWeek = moneyWeekId(nowMs)
  const monthId = monthIdForWeek(thisWeek)
  const weeks = Array.from({ length: CHART_WEEKS }, (_, i) => addWeeks(thisWeek, i - CHART_WEEKS + 1))
  const byWeek = earnedByWeek(all, weeks)
  const top = topEarnings(all, monthId, TOP_EARNINGS)

  return (
    <Section header="Money" headerStyle="prominent" footer="Only you see your amounts and goals.">
      <div className="m-earned">
        <div className="m-earned__label">Earned in {monthName(monthId)}</div>
        <div className="m-earned__value t-tabular">{formatMoney(earnedInMonth(all, monthId), currency)}</div>
        <div className="m-stats">
          <Stat label="This week" amount={byWeek[thisWeek] ?? 0} currency={currency} />
          <Stat label="Pending" amount={pendingIn(all, [thisWeek, addWeeks(thisWeek, 1)])} currency={currency} />
          <Stat label="All time" amount={totalEarned(all)} currency={currency} />
        </div>
      </div>
      <div className="m-chart-block">
        <div className="m-chart-block__title">Last {CHART_WEEKS} weeks</div>
        <EarningsChart weeks={weeks} values={weeks.map((w) => byWeek[w] ?? 0)} currency={currency} />
      </div>
      {top.length > 0 && <div className="m-subhead">Top this month</div>}
      {top.map((e) => (
        <Row key={e.id} title={e.title} subtitle={earningPlace(e, names)} detail={<span className="m-amount">{formatMoney(e.amount, currency)}</span>} />
      ))}
      {goalsRow}
    </Section>
  )
}

/** A big amount goes compact rather than being cut off; VoiceOver still reads it in full. */
function Stat({ label, amount, currency }: { label: string; amount: number; currency: CurrencyCode }) {
  const exact = formatMoney(amount, currency)
  const compact = Math.abs(amount) >= COMPACT_FROM
  return (
    <div className="m-stat">
      <span className="m-stat__label">{label}</span>
      <span className="m-stat__value t-tabular" title={compact ? exact : undefined} aria-hidden={compact || undefined}>
        {compact ? formatMoney(amount, currency, { compact: true }) : exact}
      </span>
      {compact && <span className="ui-visually-hidden">{exact}</span>}
    </div>
  )
}

/** "Film Crew · Week of Oct 5"; the week alone for a space you've left. */
function earningPlace(e: Earning, names: Record<string, string>): string {
  const week = `Week of ${weekLabel(e.weekId)}`
  return names[e.spaceId] ? `${names[e.spaceId]} · ${week}` : week
}
