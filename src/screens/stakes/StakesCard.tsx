// The Space screen's stakes card (SPEC §12.10): your deal (or that nothing is at stake, with Make a Deal and Same
// Again), at most one news line about friends' deals, and, while October's stakes still count (the October window,
// §12.3), October's rows read-only. The whole card pushes the Stakes screen. It never waits: while deals load (or
// if they fail) your block reads "Nothing at stake" without buttons.
import { useState } from 'react'
import { useDeals, useDealsFrom, useProfiles, useStakes } from '../../data/api.ts'
import { lastPlayedDeal } from '../../domain/deals.ts'
import { spaceJudges } from '../../domain/scoring.ts'
import { oldStakesMonth } from '../../domain/stakes.ts'
import type { MonthId, MonthlyList, Space, UID, Week, WeekData } from '../../domain/types.ts'
import { Avatar, Button, Icon, Section, useNav } from '../../ui/index.ts'
import { personOf } from '../components/people.ts'
import type { Profiles } from '../components/people.ts'
import { StakesItems } from '../components/Stakes.tsx'
import { readLocal, writeLocal } from '../components/storage.ts'
import { useDealActions } from './dealActions.tsx'
import { DealScreen } from './DealScreen.tsx'
import { dealCard, dealNamer, dealNews, dealPeople, dealWhen, octoberAlsoLine, octoberHeader } from './deals.ts'
import type { CardBlock, CardNews, Name } from './deals.ts'
import { StakesScreen } from './StakesScreen.tsx'
import { stakesCard, stakesFromLive } from './stakes.ts'
import './stakes.css'

export interface StakesCardProps {
  space: Space
  profiles: Profiles
  me: UID
  nowMs: number
  onInvite: () => void
  /** This week's stored doc (its stored lock and deadline, and whether you judge it). */
  thisWeek?: Week | null
  /** This week's data: once its deadline passed, its result shows before the reminders job confirms it. */
  weekData?: WeekData | null
  /** This month's list (its deadline can end the month later: the October window). */
  monthly?: MonthlyList | null
}

export function StakesCard({ space, profiles, me, nowMs, onInvite, thisWeek, weekData, monthly }: StakesCardProps) {
  const nav = useNav()
  const dealsFrom = useDealsFrom()
  const live = useDeals(space)
  const deals = live.error ? undefined : live.data
  const all = deals ? [...Object.values(deals.open), ...deals.ended] : []
  const leavers = useProfiles(dealPeople(all).filter((id) => !space.memberIds.includes(id)))
  const people: Profiles = { ...leavers, ...profiles }
  const name = dealNamer(people, space.memberIds)
  const oldMonth = oldStakesMonth(space, nowMs, thisWeek, monthly, dealsFrom)
  // Dismissed news lines are remembered on this device; the counter re-renders after a dismiss.
  const [, setDismissed] = useState(0)
  const input = {
    space,
    me,
    nowMs,
    deals,
    name,
    when: (ms: number) => dealWhen(ms, space.timezone, nowMs),
    weeks: [thisWeek],
    live: weekData,
    judging: spaceJudges(space).includes(me),
    oldMonth,
    seen: (key: string) => readLocal(key) !== null,
  }
  const block = dealCard(input)
  const news = dealNews(input)
  const actions = useDealActions(space, me, name)

  const openStakes = (focus?: string) => nav.push(<StakesScreen spaceId={space.id} focus={focus} />, { title: 'Stakes' })
  const openDeal = (dealId: string) => nav.push(<DealScreen spaceId={space.id} dealId={dealId} />, { title: 'Deal' })
  const dismiss = (key: string) => {
    writeLocal(key, '1')
    setDismissed((n) => n + 1)
  }
  const press = (kind: CardBlock['buttons'][number]['kind']) => {
    if (kind === 'invite') onInvite()
    else if (kind === 'same-again') {
      const last = lastPlayedDeal(deals?.ended ?? [], me)
      if (last) void actions.sameAgain(last)
    } else actions.edit()
  }

  return (
    <Section className="sk-card dl-card">
      <button type="button" className="sk-card__main dl-main" onClick={() => openStakes()}>
        <span className="dl-head">
          <span className={block.kind === 'won' ? 'dl-glyph dl-glyph--won' : 'dl-glyph'} aria-hidden>
            <Icon name="handshake" size={20} weight={1.8} />
          </span>
          <span className="dl-head__text">
            <span className="dl-title">{block.title}</span>
            <span className="dl-text">{block.text}</span>
            {block.avatars && block.avatars.length > 0 && <Agreed people={block.avatars} profiles={people} />}
          </span>
          <Icon name="chevronRight" size={18} weight={2.6} className="dl-chevron" />
        </span>
        {block.rows && <StakesItems items={block.rows} />}
      </button>
      {block.note && (
        <NoteLine
          text={block.note.text}
          onPress={() => (block.note?.action === 'take-a-look' && block.deal ? openDeal(block.deal.id) : openStakes())}
          action={block.note.action === 'take-a-look'}
        />
      )}
      {block.buttons.length > 0 && (
        <div className="dl-actions">
          <div className="dl-actions__buttons">
            {block.buttons.map((b, i) => (
              <Button key={b.kind} size="small" variant={i === 0 && b.kind !== 'same-again' ? 'filled' : 'gray'} onClick={() => press(b.kind)}>
                {b.label}
              </Button>
            ))}
          </div>
          {block.caption && <span className="dl-actions__caption">{block.caption}</span>}
        </div>
      )}
      {news && <NewsLine news={news} people={people} onOpen={openStakes} onDismiss={dismiss} />}
      {oldMonth && <OctoberRows space={space} me={me} nowMs={nowMs} thisWeek={thisWeek} monthly={monthly} month={oldMonth} name={name} also={!!deals?.open[me]} />}
    </Section>
  )
}

/** Who a waiting deal is with: the ones who agreed in full, the rest faded. */
function Agreed({ people, profiles }: { people: Array<{ uid: UID; agreed: boolean }>; profiles: Profiles }) {
  return (
    <span className="dl-avatars" aria-hidden>
      {people.slice(0, 7).map(({ uid, agreed }) => {
        const p = personOf(profiles, uid)
        // An opaque disc under each avatar, so a faded one doesn't show the next through it.
        return (
          <span key={uid} className={agreed ? 'dl-avatars__item' : 'dl-avatars__item dl-avatars__item--waiting'}>
            <Avatar name={p.name} color={p.color} photo={p.photo} size={22} />
          </span>
        )
      })}
    </span>
  )
}

function NoteLine({ text, onPress, action }: { text: string; onPress: () => void; action: boolean }) {
  return (
    <button type="button" className="sk-line dl-note" onClick={onPress}>
      <span className="sk-line__lead" aria-hidden>
        <span className="sk-line__glyph">
          <Icon name={action ? 'xmark' : 'clock'} size={14} weight={2.2} />
        </span>
      </span>
      <span className="sk-line__text">{text}</span>
      {action && <span className="sk-line__action sk-line__action--filled">Take a Look</span>}
    </button>
  )
}

function NewsLine({ news, people, onOpen, onDismiss }: { news: CardNews; people: Profiles; onOpen: (focus?: string) => void; onDismiss: (key: string) => void }) {
  if (news.kind === 'agree' || news.kind === 'call-off') {
    return (
      <button type="button" className="sk-line" onClick={() => onOpen(news.dealId)}>
        <span className="sk-line__lead" aria-hidden>
          <span className="sk-line__dot" />
        </span>
        <span className="sk-line__text">
          <span className="sk-line__title sk-line__title--strong">{news.text}</span>
        </span>
        <span className="sk-line__action sk-line__action--filled">Take a Look</span>
      </button>
    )
  }
  const person = personOf(people, news.uid)
  return (
    <div className="sk-line sk-line--split">
      <button type="button" className="sk-line__main" onClick={() => onOpen(news.dealId)}>
        <span className="sk-line__lead" aria-hidden>
          <Avatar name={person.name} color={person.color} photo={person.photo} size={28} />
        </span>
        <span className="sk-line__text">
          <span className="sk-line__title">{news.text}</span>
        </span>
      </button>
      <button type="button" className="sk-line__close" aria-label="Dismiss" onClick={() => onDismiss(news.seenKey)}>
        <span className="sk-line__close-dot">
          <Icon name="xmark" size={11} weight={3} />
        </span>
      </button>
    </div>
  )
}

interface OctoberProps {
  space: Space
  me: UID
  nowMs: number
  thisWeek?: Week | null
  monthly?: MonthlyList | null
  month: MonthId
  name: Name
  /** You have a deal in play: both count. */
  also: boolean
}

/** October's two rows (what counts for you in October, as agreed, read-only), only in the October window. */
function OctoberRows({ space, me, nowMs, thisWeek, monthly, month, name, also }: OctoberProps) {
  const stakes = stakesFromLive(useStakes(space))
  const model = stakesCard({ space, me, stakes, nowMs, thisWeek, monthly, name })
  return (
    <div className="dl-october">
      <div className="sk-subhead">{octoberHeader(month)}</div>
      <StakesItems items={model.rows} />
      {also && <p className="dl-october__also">{octoberAlsoLine(month)}</p>}
    </div>
  )
}
