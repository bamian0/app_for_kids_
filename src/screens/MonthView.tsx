// The month: your score against the bar, everyone's weeks and late points, and once the month is
// over, who owes whom (with an honor-system Settled switch for the people owed).
import { useEffect, useState } from 'react'
import { setSettled, useAuth, useMonth, useMonthStakes, useProfiles, useSettlements } from '../data/api.ts'
import { settlementDocId } from '../domain/ids.ts'
import { computeMonth } from '../domain/scoring.ts'
import type { MemberMonthResult } from '../domain/scoring.ts'
import { addMonths, formatMonth, formatWeekRange, weekBounds, weekIdFor, weekIdsInMonth } from '../domain/time.ts'
import type { MonthId, Settlement, Space, UID, WeekId } from '../domain/types.ts'
import { Avatar, EmptyState, Icon, Pill, Row, ScoreRing, Section, useEdgeGlow, useToast } from '../ui/index.ts'
import { Loading, MiniScore, formatScore } from './components/Bits.tsx'
import { useNow } from './components/clock.ts'
import { shortDate } from './components/format.ts'
import { canSettle, currentMonth, defaultMonth, firstMonth, hasDebt, settleHint, verdictText } from './components/month.ts'
import { firstName, nameOf, personOf } from './components/people.ts'
import type { Profiles } from './components/people.ts'
import { firstTime } from './components/storage.ts'
import { deadlineText } from './components/zone.ts'

export interface MonthViewProps {
  space: Space
  profiles: Profiles
  onOpenWeek: (weekId: WeekId) => void
  /** Open on this month (from the verdict notification) instead of the default. */
  initialMonth?: MonthId
}

export function MonthView({ space, profiles: spaceProfiles, onOpenWeek, initialMonth }: MonthViewProps) {
  const { uid } = useAuth()
  const me = uid ?? ''
  const nowMs = useNow()
  const current = currentMonth(space, nowMs)
  const first = firstMonth(space, nowMs)
  // For a week after a month ends, its verdict comes first.
  const [monthId, setMonthId] = useState(() =>
    initialMonth && initialMonth >= first && initialMonth <= current ? initialMonth : defaultMonth(space, me, nowMs),
  )
  const live = useMonth(space, monthId)
  const stakes = useMonthStakes(space, monthId).data ?? space
  const settlements = useSettlements(space.id)
  const playGlow = useEdgeGlow().play
  const toast = useToast()

  const results = live.data ? computeMonth(space, monthId, live.data, nowMs) : null
  // Everyone who played the month, including people who have left since.
  const extra = useProfiles(results ? Object.keys(results) : [])
  const profiles: Profiles = { ...extra, ...spaceProfiles }
  const mine = results?.[me]
  const iWon = !!mine && hasDebt(mine) && mine.passed === true

  // The month verdict: a one-time light moment, only for your own win.
  useEffect(() => {
    if (iWon && firstTime(`verdict.${space.id}.${monthId}.${me}`)) playGlow(2800)
  }, [iWon, space.id, monthId, me, playGlow])

  const settlementOf = (id: UID) => settlements.data?.find((s) => s.id === settlementDocId(monthId, id))
  const toggleSettled = (id: UID, value: boolean) => {
    setSettled(space.id, monthId, id, value).catch((e: unknown) =>
      toast({ title: 'Couldn’t update', message: e instanceof Error ? e.message : undefined, tone: 'error' }),
    )
  }

  const complete = mine?.complete ?? false
  // You first, then current members, then people who have left. In a finished month, only people who played it.
  const ordered = results
    ? [me, ...space.memberIds.filter((id) => id !== me), ...Object.keys(results).filter((id) => !space.memberIds.includes(id))].filter(
        (id) => results[id] && (id === me || !results[id].complete || results[id].weeks.length > 0),
      )
    : []

  return (
    <>
      <div className="s-month-switch">
        <button type="button" className="s-month-switch__arrow" aria-label="Previous month" disabled={monthId <= first} onClick={() => setMonthId(addMonths(monthId, -1))}>
          <Icon name="chevronLeft" size={20} weight={2.4} />
        </button>
        <div className="s-month-switch__title">
          <span>{formatMonth(monthId)}</span>
          <span className="s-month-switch__sub">{complete ? 'Final' : monthId === current ? 'In progress' : 'Not over yet'}</span>
        </div>
        <button type="button" className="s-month-switch__arrow" aria-label="Next month" disabled={monthId >= current} onClick={() => setMonthId(addMonths(monthId, 1))}>
          <Icon name="chevronRight" size={20} weight={2.4} />
        </button>
      </div>

      {!results ? (
        live.error ? (
          <EmptyState icon="info" title="Can’t load this month" message={live.error.message} />
        ) : (
          <Loading />
        )
      ) : (
        ordered.map((id) => (
          <MemberMonth
            key={id}
            space={space}
            stakes={stakes}
            result={results[id]}
            me={me}
            profiles={profiles}
            nowMs={nowMs}
            hero={id === me}
            settlement={settlementOf(id)}
            onSettled={(v) => toggleSettled(id, v)}
            onOpenWeek={onOpenWeek}
          />
        ))
      )}
    </>
  )
}

interface MemberMonthProps {
  space: Space
  stakes: { reward: string; penalty: string }
  result: MemberMonthResult
  me: UID
  profiles: Profiles
  nowMs: number
  hero: boolean
  settlement: Settlement | undefined
  onSettled: (value: boolean) => void
  onOpenWeek: (weekId: WeekId) => void
}

function MemberMonth({ space, stakes, result, me, profiles, nowMs, hero, settlement, onSettled, onOpenWeek }: MemberMonthProps) {
  const person = personOf(profiles, result.uid)
  const isMe = result.uid === me
  const name = (id: UID) => firstName(nameOf(profiles, id))
  const verdict = verdictText(result, me, name, stakes)
  const scored = result.weeks.filter((w) => w.closed && w.score !== null).length
  const label = result.complete ? 'Final' : 'So far'
  const summary =
    result.finalScore === null
      ? 'No scored weeks yet'
      : `${scored} week${scored === 1 ? '' : 's'} scored${result.penaltyPoints ? ` · −${result.penaltyPoints} late` : ''}`
  const settled = settlement?.settled === true
  const hint = settleHint(result, me, name)

  const weekRows = weekIdsInMonth(result.monthId).map((weekId) => {
    const entry = result.weeks.find((w) => w.weekId === weekId)
    const bounds = weekBounds(weekId, space.timezone)
    const started = nowMs >= bounds.startAt
    let detail: string
    if (entry) detail = entry.score !== null ? `${formatScore(entry.score)}${entry.closed ? '' : ' so far'}` : started ? 'In progress' : 'Upcoming'
    else detail = !started ? 'Upcoming' : nowMs >= bounds.deadlineAt ? 'Sat out' : 'Not in'
    return (
      <Row
        key={weekId}
        title={formatWeekRange(weekId)}
        detail={detail}
        chevron={started}
        onPress={started ? () => onOpenWeek(weekId) : undefined}
      />
    )
  })

  return (
    <Section>
      {hero ? (
        <div className="s-month-hero">
          <ScoreRing key={result.finalScore == null ? 'empty' : 'score'} value={result.finalScore} threshold={space.threshold} size={176} stroke={17} aria-label={result.finalScore === null ? 'No score yet' : formatScore(result.finalScore)}>
            {result.finalScore === null ? (
              <span className="s-hero-score s-hero-score--empty">—</span>
            ) : (
              <span className="s-hero-score t-tabular">
                {formatScore(result.finalScore).replace('%', '')}
                <span className="s-hero-score__percent">%</span>
              </span>
            )}
          </ScoreRing>
          <div className="s-month-hero__caption">
            {label} · bar is {space.threshold}%
          </div>
          <div className="s-month-hero__summary">{summary}</div>
          {result.complete && result.passed !== null && (
            <Pill tone={result.passed ? 'iridescent' : 'gray'} icon={result.passed ? 'sparkles' : 'flame'}>
              {result.passed ? 'You cleared the bar' : 'You missed the bar'}
            </Pill>
          )}
        </div>
      ) : (
        <Row
          leading={<Avatar name={person.name} color={person.color} photo={person.photo} size={36} />}
          title={<span className="t-semibold">{person.name}</span>}
          subtitle={result.former ? `Left · ${summary}` : summary}
          accessory={<MiniScore value={result.finalScore} threshold={space.threshold} caption={label} />}
        />
      )}
      {verdict && (
        <Row
          leading={
            <span className={result.passed && result.others.length > 0 ? 's-status-icon s-status-icon--win' : 's-status-icon'} aria-hidden>
              <Icon name={result.others.length === 0 || result.passed === null ? 'info' : result.passed ? 'trophy' : 'flame'} size={19} weight={2} />
            </span>
          }
          title={<span className="t-semibold">{verdict}</span>}
        />
      )}
      {hasDebt(result) && (
        // Only the people owed get the switch; everyone else sees where it stands and who marked it.
        <Row
          title="Settled"
          subtitle={settled && settlement ? `Marked by ${settlement.settledBy === me ? 'you' : name(settlement.settledBy)} · ${shortDate(settlement.settledAt)}` : (hint ?? undefined)}
          {...(canSettle(result, me) ? { toggle: settled, onToggle: onSettled } : { detail: settled ? 'Yes' : 'Not yet' })}
        />
      )}
      {weekRows}
      {result.missedReviews > 0 && (
        <Row
          leading={
            <span className="s-penalty-icon" aria-hidden>
              <Icon name="clock" size={18} weight={2} />
            </span>
          }
          title={`${result.missedReviews} missed review${result.missedReviews === 1 ? '' : 's'}`}
          detail={`−${result.penaltyPoints}`}
        />
      )}
      {isMe && !result.complete && result.finalScore === null && (
        <Row
          title={
            <span className="c-secondary">
              Scores count once a week closes. This one closes {deadlineText(weekBounds(weekIdFor(nowMs, space.timezone), space.timezone).deadlineAt, space.timezone, nowMs)}.
            </span>
          }
        />
      )}
    </Section>
  )
}
