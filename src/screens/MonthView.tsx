// The month: your score against the bar, everyone's weeks (paused and judged ones too), the month's list and
// late points, and who owes whom, per pair and per line (SPEC §9.7): by the score so far while the month runs,
// and once it is complete by the terms that counted then, with a check for whoever was owed. Streaks from the
// month's results (§9.8).
import { useEffect, useState } from 'react'
import {
  settlePairs,
  useAuth,
  useMonthData,
  useMonthly,
  useMonthStakes,
  useProfiles,
  useResults,
  useSettlements,
  useStakes,
} from '../data/api.ts'
import { boundsFor } from '../domain/schedule.ts'
import { computeMonth, monthEndsAt } from '../domain/scoring.ts'
import type { MemberMonthResult } from '../domain/scoring.ts'
import { FIRST_RESULTS_MONTH, lineSettlement, monthHouse } from '../domain/stakes.ts'
import type { DebtLine } from '../domain/stakes.ts'
import { addMonths, formatMonth, formatWeekRange, weekIdFor, weekIdsInMonth } from '../domain/time.ts'
import type { MonthId, Settlement, Space, UID, WeekData, WeekId } from '../domain/types.ts'
import { Avatar, CheckCircle, EmptyState, Icon, Pill, Row, ScoreRing, Section, useEdgeGlow, useToast } from '../ui/index.ts'
import { Loading, MiniScore, formatScore } from './components/Bits.tsx'
import { useNow } from './components/clock.ts'
import { monthName } from './components/format.ts'
import {
  canSettleLine,
  currentMonth,
  debtLineSubtitle,
  debtLineText,
  defaultMonth,
  firstMonth,
  judgedFootnote,
  judgeOnly,
  monthDebtView,
  monthlyDetail,
  monthSummary,
  streakPill,
  verdictText,
  weekDetail,
} from './components/month.ts'
import { firstName, nameOf, personOf } from './components/people.ts'
import type { Profiles } from './components/people.ts'
import { firstTime } from './components/storage.ts'
import { deadlineText } from './components/zone.ts'
import { streakNote } from './stakes/stakes.ts'
import './stakes/stakes.css'

export interface MonthViewProps {
  space: Space
  profiles: Profiles
  onOpenWeek: (weekId: WeekId) => void
  /** Opens a month's list (the "October list" row). Without it the row only shows the score. */
  onOpenMonthly?: (monthId: MonthId) => void
  /** Open on this month (from the verdict notification) instead of the default. */
  initialMonth?: MonthId
}

export function MonthView({ space, profiles: spaceProfiles, onOpenWeek, onOpenMonthly, initialMonth }: MonthViewProps) {
  const { uid } = useAuth()
  const me = uid ?? ''
  const nowMs = useNow()
  const current = currentMonth(space, nowMs)
  const first = firstMonth(space, nowMs)
  // For a week after a month ends, its verdict comes first.
  const [monthId, setMonthId] = useState(() =>
    initialMonth && initialMonth >= first && initialMonth <= current ? initialMonth : defaultMonth(space, me, nowMs),
  )
  const data = useMonthData(space, monthId)
  // The month's list all month (not only from its last week), so its row shows while it runs.
  const monthlyLive = useMonthly(space, monthId)
  const stakesLive = useStakes(space)
  const frozen = useMonthStakes(space, monthId)
  const ownResults = useResults(space, monthId)
  const prevResults = useResults(space, addMonths(monthId, -1))
  const settlements = useSettlements(space.id, monthId)
  const playGlow = useEdgeGlow().play
  const toast = useToast()

  const weeks = data.data?.weeks
  const monthly = monthlyLive.data
  const monthlyReady = monthly !== undefined || !!monthlyLive.error
  const results = weeks && monthlyReady ? computeMonth(space, monthId, weeks, nowMs, monthly) : null
  // Everyone who played the month, including people who have left since.
  const extra = useProfiles(results ? Object.keys(results) : [])
  const profiles: Profiles = { ...extra, ...spaceProfiles }
  const name = (id: UID) => firstName(nameOf(profiles, id))

  // The month's terms: its stored results, else the agreements before it was complete (with its house
  // stakes) or, while it runs, what counts now. Rules published late (a listener error): the house stakes.
  const ready =
    !!results &&
    (stakesLive.data !== undefined || !!stakesLive.error) &&
    (ownResults.data !== undefined || !!ownResults.error) &&
    (prevResults.data !== undefined || !!prevResults.error) &&
    (settlements.data !== undefined || !!settlements.error) &&
    frozen.data !== undefined
  const weekIds = weekIdsInMonth(monthId)
  const docOf = (weekId: WeekId) => weeks?.find((w) => w.weekId === weekId)?.week ?? null
  const completeAt = weeks ? monthEndsAt(space, monthId, weeks, monthly) : Infinity
  const view =
    ready && results
      ? monthDebtView({
          space,
          monthId,
          results,
          stakes: stakesLive.error ? undefined : stakesLive.data,
          house: monthHouse(space, monthId, frozen.data, completeAt),
          completeAt,
          firstLockAt: boundsFor(space, weekIds[0], docOf(weekIds[0])).lockAt,
          stored: ownResults.data ?? null,
          prev: prevResults.data ?? null,
        })
      : null

  const mine = results?.[me]
  const complete = mine?.complete ?? false
  const iWon = !!mine && complete && mine.passed === true && mine.others.length > 0
  // The month verdict: a one-time light moment, only for your own win (a streak reward reached comes with it).
  const shown = !!view
  useEffect(() => {
    if (iWon && shown && firstTime(`verdict.${space.id}.${monthId}.${me}`)) playGlow(2800)
  }, [iWon, shown, space.id, monthId, me, playGlow])

  const settle = (line: DebtLine, value: boolean) => {
    settlePairs(space.id, monthId, line.keys, value).catch((e: unknown) =>
      toast({ title: 'Couldn’t update', message: e instanceof Error ? e.message : undefined, tone: 'error' }),
    )
  }

  // You first, then current members, then people who have left. In a finished month, only people who played it;
  // those who only judged it get a footnote.
  const ordered = results
    ? [me, ...space.memberIds.filter((id) => id !== me), ...Object.keys(results).filter((id) => !space.memberIds.includes(id))].filter(
        (id) => results[id] && (id === me || !results[id].complete || (!judgeOnly(results[id]) && (results[id].weeks.length > 0 || !!results[id].monthly))),
      )
    : []
  const judgedOnly = results && complete ? Object.values(results).filter((r) => r.uid !== me && judgeOnly(r)) : []
  const footnote = judgedFootnote(
    judgedOnly.map((r) => name(r.uid)),
    monthId,
  )
  const streakKnown = !!view?.streaks
  const note = view ? streakNote(streakKnown, complete, monthId, FIRST_RESULTS_MONTH, completeAt, nowMs) : null
  const myTier = !!view?.lines.some((l) => l.subject === me && l.kind === 'tier')

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

      {!results || !view || !weeks ? (
        data.error ? (
          <EmptyState icon="info" title="Can’t load this month" message={data.error.message} />
        ) : (
          <Loading />
        )
      ) : (
        <>
          {ordered.map((id) => (
            <MemberMonth
              key={id}
              space={space}
              result={results[id]}
              me={me}
              profiles={profiles}
              nowMs={nowMs}
              hero={id === me}
              weeks={weeks}
              lines={view.lines.filter((l) => l.subject === id)}
              settlements={settlements.data ?? []}
              streak={view.streaks?.streaks[id] ?? null}
              tierReached={id === me && myTier}
              streakNote={id === me ? note : null}
              hasList={!!monthly?.monthly}
              onSettle={settle}
              onOpenWeek={onOpenWeek}
              onOpenMonthly={onOpenMonthly}
            />
          ))}
          {footnote && <p className="sk-month-footnote">{footnote}</p>}
        </>
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
  weeks: WeekData[]
  /** The month's debt lines whose subject is this member. */
  lines: DebtLine[]
  settlements: Settlement[]
  /** Months in a row after this month, once known (complete months). */
  streak: number | null
  /** Your streak reward came due this month. */
  tierReached: boolean
  streakNote: string | null
  /** The month has a list (its row shows after the weeks). */
  hasList: boolean
  onSettle: (line: DebtLine, value: boolean) => void
  onOpenWeek: (weekId: WeekId) => void
  onOpenMonthly?: (monthId: MonthId) => void
}

/** monthSummary's judge line split in two, so the count never lands alone on a second line: the bold caption
 *  "Judge · no score this month", then (if any) "Didn’t review 2" in gray like other months' summary. */
function JudgeCaption({ summary }: { summary: string }) {
  const at = summary.indexOf(' · didn’t review ')
  if (at < 0) return <div className="s-month-hero__caption">{summary}</div>
  const missed = summary.slice(at + ' · '.length)
  return (
    <>
      <div className="s-month-hero__caption">{summary.slice(0, at)}</div>
      <div className="s-month-hero__summary">{missed.charAt(0).toUpperCase() + missed.slice(1)}</div>
    </>
  )
}

function MemberMonth(props: MemberMonthProps) {
  const { space, result, me, profiles, nowMs, hero, weeks, lines, settlements, streak, tierReached, hasList, onSettle, onOpenWeek, onOpenMonthly } = props
  const person = personOf(profiles, result.uid)
  const isMe = result.uid === me
  const name = (id: UID) => firstName(nameOf(profiles, id))
  const docOf = (weekId: WeekId) => weeks.find((w) => w.weekId === weekId)?.week ?? null
  const boundsOf = (weekId: WeekId) => boundsFor(space, weekId, docOf(weekId))
  const onlyJudged = judgeOnly(result)
  const label = result.complete ? 'Final' : 'So far'
  const summary = monthSummary(result, (weekId) => nowMs >= boundsOf(weekId).deadlineAt)
  const pill = result.complete ? streakPill(streak) : null
  // No debts: why nothing's owed (a month that only judged says so in its summary).
  const nothingOwed = result.complete && !onlyJudged && (result.passed === null || result.others.length === 0) ? verdictText(result, me, name, space) : null

  const weekRows = weekIdsInMonth(result.monthId).map((weekId) => {
    const bounds = boundsOf(weekId)
    const started = nowMs >= bounds.startAt
    return (
      <Row
        key={weekId}
        title={formatWeekRange(weekId)}
        detail={weekDetail(result, weekId, bounds, nowMs)}
        chevron={started}
        onPress={started ? () => onOpenWeek(weekId) : undefined}
      />
    )
  })

  const thisWeek = weekIdFor(nowMs, space.timezone)
  return (
    <Section footer={hero && props.streakNote ? props.streakNote : undefined}>
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
          {onlyJudged ? (
            // "Judge · no score this month", and under it, in gray, "Didn’t review 2" when they skipped some.
            <JudgeCaption summary={summary} />
          ) : (
            <>
              <div className="s-month-hero__caption">
                {label} · bar is {space.threshold}%
              </div>
              <div className="s-month-hero__summary">{summary}</div>
            </>
          )}
          {result.complete && (result.passed !== null || pill) && (
            <div className="sk-pills">
              {result.passed !== null && (
                <Pill tone={result.passed ? 'iridescent' : 'gray'} icon={result.passed ? 'sparkles' : 'flame'}>
                  {result.passed ? 'You cleared the bar' : 'You missed the bar'}
                </Pill>
              )}
              {pill && (
                <Pill tone={tierReached ? 'iridescent' : 'gray'} icon="sparkles">
                  {pill}
                </Pill>
              )}
            </div>
          )}
        </div>
      ) : (
        <Row
          leading={<Avatar name={person.name} color={person.color} photo={person.photo} size={36} />}
          title={<span className="t-semibold">{person.name}</span>}
          subtitle={[result.former ? 'Left' : null, onlyJudged ? 'Judge' : summary, pill && streak !== null ? `${streak} in a row` : null].filter(Boolean).join(' · ')}
          accessory={<MiniScore value={result.finalScore} threshold={space.threshold} caption={onlyJudged ? 'Judge' : label} />}
        />
      )}
      {lines.map((line, i) => (
        <DebtRow key={i} line={line} complete={result.complete} space={space} me={me} name={name} settlements={settlements} monthId={result.monthId} onSettle={onSettle} />
      ))}
      {nothingOwed && (
        <Row
          leading={
            <span className="s-status-icon" aria-hidden>
              <Icon name="info" size={19} weight={2} />
            </span>
          }
          title={<span className="t-semibold">{nothingOwed}</span>}
        />
      )}
      {weekRows}
      {hasList && (
        <Row
          title={`${monthName(result.monthId)} list`}
          detail={monthlyDetail(result)}
          chevron={!!onOpenMonthly}
          onPress={onOpenMonthly ? () => onOpenMonthly(result.monthId) : undefined}
        />
      )}
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
      {isMe && !result.complete && result.finalScore === null && !onlyJudged && (
        <Row
          title={
            <span className="c-secondary">
              Scores count once a week closes. This one closes {deadlineText(boundsOf(thisWeek).deadlineAt, space.timezone, nowMs)}.
            </span>
          }
        />
      )}
    </Section>
  )
}

interface DebtRowProps {
  line: DebtLine
  complete: boolean
  space: Space
  me: UID
  name: (uid: UID) => string
  settlements: Settlement[]
  monthId: MonthId
  onSettle: (line: DebtLine, value: boolean) => void
}

/** One line of who owes whom: a check for whoever was owed once the month is complete; while it runs, the score so far. */
function DebtRow({ line, complete, space, me, name, settlements, monthId, onSettle }: DebtRowProps) {
  const text = debtLineText(line, me, name)
  if (!complete) {
    const subtitle = ['So far', line.together && line.debtors.length >= 2 ? 'Together' : null].filter(Boolean).join(' · ')
    return (
      <Row
        leading={
          <span className="sk-line-icon" aria-hidden>
            <Icon name={line.kind === 'penalty' ? 'flame' : line.kind === 'tier' ? 'sparkles' : 'trophy'} size={16} weight={2} />
          </span>
        }
        title={text}
        subtitle={subtitle}
      />
    )
  }
  const settled = lineSettlement(settlements, monthId, line)
  const can = canSettleLine(line, me, space.memberIds)
  return (
    <Row
      leading={<CheckCircle checked={settled.settled} disabled={!can} onChange={() => onSettle(line, !settled.settled)} aria-label={`Settled: ${text}`} />}
      title={<span className="t-semibold">{text}</span>}
      subtitle={debtLineSubtitle(line, settled, me, space.memberIds, name)}
    />
  )
}
