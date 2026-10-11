// The month: your score against the bar, everyone's weeks and late points, and once the month is
// over, who owes whom (with an honor-system Settled switch).
import { useEffect, useState } from 'react'
import { setSettled, useAuth, useMonth, useSettlements } from '../data/api.ts'
import { settlementDocId } from '../domain/ids.ts'
import { computeMonth } from '../domain/scoring.ts'
import type { MemberMonthResult } from '../domain/scoring.ts'
import { addMonths, formatMonth, formatWeekRange, monthIdForWeek, weekBounds, weekIdFor, weekIdsInMonth } from '../domain/time.ts'
import type { MonthId, Space, UID, WeekId } from '../domain/types.ts'
import { Avatar, EmptyState, Icon, Pill, Row, ScoreRing, Section, useEdgeGlow, useToast } from '../ui/index.ts'
import { Loading, MiniScore, formatScore } from './components/Bits.tsx'
import { useNow } from './components/clock.ts'
import { firstName, listNames, nameOf, personOf } from './components/people.ts'
import type { Profiles } from './components/people.ts'
import { firstTime } from './components/storage.ts'

export interface MonthViewProps {
  space: Space
  profiles: Profiles
  onOpenWeek: (weekId: WeekId) => void
}

function monthOf(ms: number, space: Space): MonthId {
  return monthIdForWeek(weekIdFor(ms, space.timezone))
}

export function MonthView({ space, profiles, onOpenWeek }: MonthViewProps) {
  const { uid } = useAuth()
  const me = uid ?? ''
  const nowMs = useNow()
  const current = monthOf(nowMs, space)
  const first = Number.isFinite(space.createdAt) && space.createdAt > 0 ? monthOf(space.createdAt, space) : current
  const [monthId, setMonthId] = useState(current)
  const live = useMonth(space, monthId)
  const settlements = useSettlements(space.id)
  const playGlow = useEdgeGlow().play
  const toast = useToast()

  const results = live.data ? computeMonth(space, monthId, live.data, nowMs) : null
  const anyPassed = !!results && Object.values(results).some((r) => r.passed === true)

  // The month verdict: a one-time light moment when someone cleared the bar.
  useEffect(() => {
    if (anyPassed && firstTime(`verdict.${space.id}.${monthId}.${me}`)) playGlow(2800)
  }, [anyPassed, space.id, monthId, me, playGlow])

  const settled = (uid: UID) => settlements.data?.find((s) => s.id === settlementDocId(monthId, uid))?.settled === true
  const toggleSettled = (uid: UID, value: boolean) => {
    setSettled(space.id, monthId, uid, value).catch((e: unknown) =>
      toast({ title: 'Couldn’t update', message: e instanceof Error ? e.message : undefined, tone: 'error' }),
    )
  }

  const ordered = [me, ...space.memberIds.filter((id) => id !== me)].filter((id) => results?.[id])
  const complete = results?.[me]?.complete ?? false

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
            result={results[id]}
            me={me}
            profiles={profiles}
            nowMs={nowMs}
            hero={id === me}
            settled={settled(id)}
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
  result: MemberMonthResult
  me: UID
  profiles: Profiles
  nowMs: number
  hero: boolean
  settled: boolean
  onSettled: (value: boolean) => void
  onOpenWeek: (weekId: WeekId) => void
}

function verdictText(space: Space, result: MemberMonthResult, me: UID, profiles: Profiles): string | null {
  if (!result.complete) return null
  if (result.passed === null) return 'No scored weeks, so nothing’s owed.'
  const isMe = result.uid === me
  const who = isMe ? 'you' : firstName(nameOf(profiles, result.uid))
  const others = space.memberIds.filter((id) => id !== result.uid).map((id) => (id === me ? 'you' : firstName(nameOf(profiles, id))))
  // "you" leads a list ("you and Sam"), and is capitalised at the start of a sentence.
  others.sort((a, b) => (a === 'you' ? -1 : b === 'you' ? 1 : 0))
  const othersText = others.length ? listNames(others) : 'nobody'
  const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)
  if (result.passed) return `${cap(othersText)} ${others.length === 1 && others[0] !== 'you' ? 'owes' : 'owe'} ${who}: ${space.reward}`
  return `${cap(who)} ${isMe ? 'owe' : 'owes'} ${othersText}: ${space.penalty}`
}

function MemberMonth({ space, result, me, profiles, nowMs, hero, settled, onSettled, onOpenWeek }: MemberMonthProps) {
  const person = personOf(profiles, result.uid)
  const isMe = result.uid === me
  const verdict = verdictText(space, result, me, profiles)
  const scored = result.weeks.filter((w) => w.closed && w.score !== null).length
  const label = result.complete ? 'Final' : 'So far'
  const summary =
    result.finalScore === null
      ? 'No scored weeks yet'
      : `${scored} week${scored === 1 ? '' : 's'} scored${result.penaltyPoints ? ` · −${result.penaltyPoints} late` : ''}`

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
          <ScoreRing value={result.finalScore} threshold={space.threshold} size={176} stroke={17} aria-label={result.finalScore === null ? 'No score yet' : formatScore(result.finalScore)}>
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
          leading={<Avatar name={person.name} color={person.color} size={36} />}
          title={<span className="t-semibold">{person.name}</span>}
          subtitle={summary}
          accessory={<MiniScore value={result.finalScore} threshold={space.threshold} caption={label} />}
        />
      )}
      {verdict && (
        <Row
          leading={
            <span className={result.passed ? 's-status-icon s-status-icon--win' : 's-status-icon'} aria-hidden>
              <Icon name={result.passed ? 'trophy' : result.passed === false ? 'flame' : 'info'} size={19} weight={2} />
            </span>
          }
          title={<span className="t-semibold">{verdict}</span>}
        />
      )}
      {verdict && result.passed !== null && <Row title="Settled" toggle={settled} onToggle={onSettled} />}
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
        <Row title={<span className="c-secondary">Scores count once a week closes, Saturday 00:00.</span>} />
      )}
    </Section>
  )
}
