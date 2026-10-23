// Past Deals (SPEC §12.10): every deal of the space, one section per person (you first, then members in join
// order, then former members), newest first, withdrawn ones left out. A row opens the deal (its lines can be
// settled there, also after the 60 days the Stakes screen shows).
import { useAuth, useDealHistory, useProfiles, useSpace, useWeek } from '../../data/api.ts'
import { weekIdFor } from '../../domain/time.ts'
import type { Deal, Space, UID } from '../../domain/types.ts'
import { Avatar, EmptyState, Row, Screen, Section, useNav } from '../../ui/index.ts'
import { Loading } from '../components/Bits.tsx'
import { useNow } from '../components/clock.ts'
import { personOf } from '../components/people.ts'
import { DealScreen } from './DealScreen.tsx'
import { dealNamer, dealNow, dealPeople, historyRow } from './deals.ts'
import './stakes.css'

export function DealHistoryScreen({ spaceId }: { spaceId: string }) {
  const live = useSpace(spaceId)
  if (!live.data) {
    return (
      <Screen title="Past Deals" titleDisplay="inline">
        {live.data === null ? <EmptyState icon="person2" title="You’re not in this space" message="You left it, or it no longer exists." /> : <Loading />}
      </Screen>
    )
  }
  return <History space={live.data} />
}

/** You first, then members in join order, then former members by name. */
export function historyOrder(people: UID[], me: UID, space: Pick<Space, 'memberIds' | 'joinedAt'>, name: (uid: UID) => string): UID[] {
  const members = space.memberIds.filter((id) => id !== me).sort((a, b) => (space.joinedAt[a] ?? 0) - (space.joinedAt[b] ?? 0))
  const former = people.filter((id) => id !== me && !space.memberIds.includes(id)).sort((a, b) => name(a).localeCompare(name(b)))
  return [me, ...members, ...former].filter((id) => people.includes(id))
}

function History({ space }: { space: Space }) {
  const { uid } = useAuth()
  const me = uid ?? ''
  const nowMs = useNow()
  const nav = useNav()
  const history = useDealHistory(space)
  const week = useWeek(space, weekIdFor(nowMs, space.timezone))
  const deals = (history.data ?? []).filter((d) => d.ended?.outcome !== 'withdrawn')
  const profiles = useProfiles([...new Set([...space.memberIds, ...dealPeople(deals)])])
  const name = dealNamer(profiles, space.memberIds)

  if (history.data === undefined) {
    return (
      <Screen title="Past Deals" titleDisplay="inline">
        {history.error ? <EmptyState icon="info" title="Can’t load deals" message={history.error.message} /> : <Loading />}
      </Screen>
    )
  }
  if (deals.length === 0) {
    return (
      <Screen title="Past Deals" titleDisplay="inline">
        <EmptyState icon="handshake" title="No deals yet" message="Deals you and your friends make show up here." />
      </Screen>
    )
  }
  const byPerson = new Map<UID, Deal[]>()
  for (const d of deals) byPerson.set(d.uid, [...(byPerson.get(d.uid) ?? []), d])
  const order = historyOrder([...byPerson.keys()], me, space, name)
  return (
    <Screen title="Past Deals" titleDisplay="inline">
      {order.map((person) => {
        const p = personOf(profiles, person)
        const list = [...(byPerson.get(person) ?? [])].sort((a, b) => b.seq - a.seq)
        return (
          <Section
            key={person}
            header={
              <span className="sk-head">
                <Avatar name={p.name} color={p.color} photo={p.photo} size={22} />
                {person === me ? 'You' : name(person)}
              </span>
            }
          >
            {list.map((deal) => {
              const row = historyRow(deal, dealNow(deal, space, nowMs, [week.data?.week]), space.threshold, space.timezone)
              return (
                <Row
                  key={deal.id}
                  title={row.title}
                  subtitle={row.subtitle || undefined}
                  chevron
                  onPress={() => nav.push(<DealScreen spaceId={space.id} dealId={deal.id} />, { title: 'Past Deals' })}
                />
              )
            })}
          </Section>
        )
      })}
    </Screen>
  )
}
