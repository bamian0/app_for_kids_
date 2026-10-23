// One deal (SPEC §12.10): what it is and where it stands, its terms (as they apply to you), each week or month so
// far, who agreed (while it waits), what's owed once it's over, and what you can do: Edit or Withdraw your waiting
// deal, Agree to a friend's, Call Off an agreed one, or Same Again once yours is over.
import { Fragment } from 'react'
import type { ReactNode } from 'react'
import { useAuth, useDealHistory, useDeals, useProfiles, useSpace, useWeek } from '../../data/api.ts'
import { dealLengthText, firstPeriodAfter, lastPlayedDeal, startPhrase } from '../../domain/deals.ts'
import { weekIdFor } from '../../domain/time.ts'
import type { Deal, Space } from '../../domain/types.ts'
import { Avatar, Button, CheckCircle, EmptyState, Facts, Icon, Row, Screen, Section, useNav } from '../../ui/index.ts'
import { Loading } from '../components/Bits.tsx'
import { useNow } from '../components/clock.ts'
import { personOf } from '../components/people.ts'
import type { Profiles } from '../components/people.ts'
import { StakesItems } from '../components/Stakes.tsx'
import { useDealActions } from './dealActions.tsx'
import {
  clockOf,
  dealFooter,
  dealNamer,
  dealNote,
  dealNow,
  dealTitle,
  dealWhen,
  friendAgreement,
  friendDealRows,
  isOn,
  lineFriends,
  lineText,
  liveScore,
  ownDealRows,
  periodRows,
  possessive,
  settleRows,
  statusLine,
  weekOwnScore,
} from './deals.ts'
import type { StakesRow } from './stakes.ts'
import './stakes.css'

export interface DealScreenProps {
  spaceId: string
  dealId: string
}

export function DealScreen({ spaceId, dealId }: DealScreenProps) {
  const live = useSpace(spaceId)
  if (!live.data) {
    return (
      <Screen title="Deal" titleDisplay="inline">
        {live.data === null ? <EmptyState icon="person2" title="You’re not in this space" message="You left it, or it no longer exists." /> : <Loading />}
      </Screen>
    )
  }
  return <DealLookup space={live.data} dealId={dealId} />
}

/** The deal from the open and recent deals the app already listens to, else from the whole collection. */
function DealLookup({ space, dealId }: { space: Space; dealId: string }) {
  const deals = useDeals(space)
  const found = deals.data ? (Object.values(deals.data.open).find((d) => d.id === dealId) ?? deals.data.ended.find((d) => d.id === dealId)) : undefined
  if (found) return <DealBody space={space} deal={found} known={deals.data ? [...Object.values(deals.data.open), ...deals.data.ended] : []} />
  if (deals.error) {
    return (
      <Screen title="Deal" titleDisplay="inline">
        <EmptyState icon="info" title="Can’t load deals" message={deals.error.message} />
      </Screen>
    )
  }
  if (!deals.data) {
    return (
      <Screen title="Deal" titleDisplay="inline">
        <Loading />
      </Screen>
    )
  }
  return <FromHistory space={space} dealId={dealId} />
}

function FromHistory({ space, dealId }: { space: Space; dealId: string }) {
  const history = useDealHistory(space)
  const found = history.data?.find((d) => d.id === dealId)
  if (found) return <DealBody space={space} deal={found} known={history.data ?? []} />
  return (
    <Screen title="Deal" titleDisplay="inline">
      {history.data === undefined && !history.error ? <Loading /> : <EmptyState icon="handshake" title="This deal is gone" message={history.error?.message ?? 'It may have been withdrawn.'} />}
    </Screen>
  )
}

function Glyph({ kind }: { kind: 'pass' | 'miss' | null }) {
  if (!kind) return null
  return (
    <span className={kind === 'pass' ? 'dl-result dl-result--pass' : 'dl-result dl-result--miss'} aria-hidden>
      {kind === 'pass' ? <Icon name="checkmark" size={12} weight={3} /> : <span className="dl-result__zero">0</span>}
    </span>
  )
}

function DealBody({ space, deal, known }: { space: Space; deal: Deal; known: Deal[] }) {
  const { uid } = useAuth()
  const me = uid ?? ''
  const nowMs = useNow()
  const nav = useNav()
  const thisWeekId = weekIdFor(nowMs, space.timezone)
  const week = useWeek(space, thisWeekId)
  const thisWeek = week.data?.week ?? null
  const profiles: Profiles = useProfiles([...new Set([...space.memberIds, deal.uid, ...deal.friends])])
  const name = dealNamer(profiles, space.memberIds)
  const actions = useDealActions(space, me, name)
  const state = dealNow(deal, space, nowMs, [thisWeek], week.data)
  const clock = clockOf(space, deal.unit, [thisWeek])
  const mine = deal.uid === me
  const subject = name(deal.uid)
  const t = space.threshold
  const ctx = { me, nowMs, tz: space.timezone, threshold: t, name }
  const live = liveScore(space, deal.uid, week.data, nowMs)
  const own = (e: Parameters<typeof weekOwnScore>[0]) => (deal.unit === 'week' ? weekOwnScore(e, space, live) : null)
  const note = deal.ended ? null : dealNote(deal, state, { me, threshold: t, latePenalty: space.latePenalty, name, own })
  const myOpen = known.find((d) => d.uid === me && !d.ended)
  const canSameAgain = mine && !!deal.ended && !myOpen && lastPlayedDeal(known, me)?.id === deal.id

  // Terms: yours; a friend's as they apply to you; else what friends owe in it.
  const terms: StakesRow[] = mine
    ? ownDealRows(deal, state, name)
    : deal.friends.includes(me)
      ? friendDealRows(deal, me, subject)
      : [
          { icon: 'trophy', label: `${subject} makes it, friends owe`, text: lineText(deal, 'reward', lineFriends(state), name) },
          { icon: 'flame', label: `${subject} misses one, friends get`, text: lineText(deal, 'penalty', lineFriends(state), name) },
        ]

  const rows = periodRows(deal, state, own)
  const before = state.phase === 'waiting' || state.phase === 'scheduled'
  const start = state.start ?? firstPeriodAfter(space, deal.unit, nowMs, clock)
  const settle = deal.ended && (deal.ended.outcome === 'won' || deal.ended.outcome === 'lost') ? settleRows(deal, state, { me, memberIds: space.memberIds, name, all: true }) : []
  const footer = dealFooter(deal, state, { ...ctx, latePenalty: space.latePenalty, when: (ms) => dealWhen(ms, space.timezone, nowMs), clock, canSameAgain })

  // What you can do with it.
  const party = mine || state.parties.includes(me)
  const actionRows: ReactNode[] = []
  if (!deal.ended && state.phase === 'waiting' && mine) {
    actionRows.push(<Row key="edit" title="Edit Deal" action onPress={() => actions.edit({ replace: deal, onProposed: () => nav.pop() })} />)
    actionRows.push(
      <Row
        key="withdraw"
        title="Withdraw Deal"
        destructive
        onPress={() => {
          void actions.withdraw(deal).then((done) => {
            if (done) nav.pop()
          })
        }}
      />,
    )
  }
  let callOffNote: string | null = null
  if (!deal.ended && isOn(state) && party && !state.provisional) {
    if (state.callOff.completeAt !== null) callOffNote = 'Everyone called it off. It’s confirmed within a few hours.'
    else if (state.callOff.asked.includes(me)) callOffNote = 'You asked to call it off.'
    else actionRows.push(<Row key="off" title="Call Off Deal" destructive onPress={() => void actions.callOff(deal, state)} />)
  }
  if (canSameAgain) actionRows.push(<Row key="same" title="Same Again" action onPress={() => void actions.sameAgain(deal)} />)
  const agreeing = !deal.ended && state.phase === 'waiting' && state.waitingFor.includes(me)

  const hero = statusLine(deal, state, ctx)
  const sections: Array<{ key: string; render: (footer?: string) => ReactNode }> = []
  sections.push({
    key: 'terms',
    render: (f) => (
      <Section header="Terms" footer={f}>
        <StakesItems items={terms} />
      </Section>
    ),
  })
  if (before || rows.length > 0) {
    sections.push({
      key: 'periods',
      render: (f) => (
        <Section header={deal.unit === 'week' ? 'Weeks' : 'Months'} footer={f}>
          {before ? (
            <Row title={`Starts ${startPhrase(deal.unit, start, nowMs, space.timezone)}`} detail={dealLengthText(deal.unit, deal.count)} />
          ) : (
            rows.map((r) => (
              <Row
                key={r.id}
                title={<span className={r.state === 'upcoming' ? 'c-secondary' : undefined}>{r.title}</span>}
                detail={
                  r.detail ? (
                    <span className="dl-period">
                      <Glyph kind={r.glyph} />
                      {r.detail}
                    </span>
                  ) : undefined
                }
              />
            ))
          )}
        </Section>
      ),
    })
  }
  if (state.phase === 'waiting' && !deal.ended) {
    sections.push({
      key: 'friends',
      render: (f) => (
        <Section header="Friends" footer={f}>
          {deal.friends.map((fr) => {
            const person = personOf(profiles, fr)
            const status = friendAgreement(deal, fr, space.memberIds)
            return (
              <Row
                key={fr}
                leading={<Avatar name={person.name} color={person.color} photo={person.photo} size={30} />}
                title={fr === me ? `${name(fr)} (You)` : name(fr)}
                detail={
                  <span className="sk-status">
                    {status !== 'Left' && <Icon name={status === 'Agreed' ? 'checkmark' : 'clock'} size={13} weight={status === 'Agreed' ? 2.6 : 2.2} />}
                    {status}
                  </span>
                }
              />
            )
          })}
        </Section>
      ),
    })
  }
  if (settle.length > 0) {
    sections.push({
      key: 'settle',
      render: (f) => (
        <Section header="Settle" footer={f}>
          {settle.map((row) => (
            <Row
              key={row.line.keys.join(',')}
              leading={<CheckCircle checked={row.settled} disabled={!row.canSettle} onChange={() => actions.settle(row)} aria-label={`Settled: ${row.title}`} />}
              title={<span className="t-semibold">{row.title}</span>}
              subtitle={<Facts text={row.subtitle} />}
            />
          ))}
        </Section>
      ),
    })
  }
  if (actionRows.length > 0 || callOffNote) {
    sections.push({
      key: 'actions',
      render: (f) => (
        <Section footer={f}>
          {callOffNote && <Row title={<span className="sk-note">{callOffNote}</span>} />}
          {actionRows}
        </Section>
      ),
    })
  }

  return (
    <Screen title={mine ? 'Your Deal' : `${possessive(subject)} Deal`} titleDisplay="inline">
      <div className="dl-hero">
        <span className={deal.ended?.outcome === 'won' ? 'dl-hero__glyph dl-hero__glyph--won' : 'dl-hero__glyph'} aria-hidden>
          <Icon name="handshake" size={34} weight={1.7} />
        </span>
        <div className="dl-hero__title">{dealTitle(deal, t)}</div>
        <div className="dl-hero__line">{hero}</div>
        {note && <div className="dl-hero__note">{note.text}</div>}
      </div>
      {agreeing && (
        <div className="dl-hero-action">
          <Button size="large" fullWidth onClick={() => void actions.agree(deal, state)}>
            {`Agree to ${possessive(subject)} Deal`}
          </Button>
        </div>
      )}
      {sections.map((s, i) => (
        <Fragment key={s.key}>{s.render(i === sections.length - 1 ? footer : undefined)}</Fragment>
      ))}
    </Screen>
  )
}
