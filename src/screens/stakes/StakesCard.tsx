// The Space screen's stakes card (SPEC §9.7): what counts right now for you, live from the space and the
// stakes docs (no months/ read: the month whose terms count now is never complete, so its house stakes are the
// space's), then at most two status lines: news, and what's pending. It never waits for the stakes listener:
// while it loads, or if it fails, everyone is on the house stakes and there are no status lines.
import { useState } from 'react'
import { useProfiles, useStakes } from '../../data/api.ts'
import type { MonthlyList, Space, UID, Week } from '../../domain/types.ts'
import { Avatar, AvatarStack, Button, Icon, Section, useNav, useSheet } from '../../ui/index.ts'
import type { IconName } from '../../ui/index.ts'
import { firstName, nameOf, personOf } from '../components/people.ts'
import type { Person, Profiles } from '../components/people.ts'
import { StakesItems } from '../components/Stakes.tsx'
import { readLocal, writeLocal } from '../components/storage.ts'
import { StakesEditorSheet } from './StakesEditorSheet.tsx'
import { StakesScreen } from './StakesScreen.tsx'
import { stakesCard, stakesFromLive } from './stakes.ts'
import type { CardNews, CardPending } from './stakes.ts'
import './stakes.css'

const DAY = 86_400_000

export interface StakesCardProps {
  space: Space
  profiles: Profiles
  me: UID
  nowMs: number
  onInvite: () => void
  /** This week's stored doc (its stored deadline can end the month early or late, for termsMonth). */
  thisWeek?: Week | null
  /** This month's list (its deadline can end the month later, for termsMonth). */
  monthly?: MonthlyList | null
}

/** Friends who left lately: the leaver line names them. */
function recentLeavers(space: Space, nowMs: number): UID[] {
  return Object.entries(space.leftAt ?? {}).flatMap(([uid, at]) => (!space.memberIds.includes(uid) && nowMs - at < 62 * DAY ? [uid] : []))
}

export function StakesCard({ space, profiles, me, nowMs, onInvite, thisWeek, monthly }: StakesCardProps) {
  const nav = useNav()
  const sheet = useSheet()
  const live = useStakes(space)
  const stakes = stakesFromLive(live)
  const leavers = useProfiles(recentLeavers(space, nowMs))
  const people: Profiles = { ...leavers, ...profiles }
  const name = (uid: UID) => firstName(nameOf(people, uid))
  // Dismissed notices are remembered on this device; the counter re-renders after a dismiss.
  const [, setDismissed] = useState(0)
  const model = stakesCard({ space, me, stakes, nowMs, thisWeek, monthly, name, seen: (key) => readLocal(key) !== null })

  const openStakes = (focus?: UID) => nav.push(<StakesScreen spaceId={space.id} focus={focus} />, { title: 'Stakes' })
  const openEditor = (focus?: UID) =>
    sheet.present((close) => <StakesEditorSheet space={space} own={stakes?.[me]} now={model.now} focus={focus} close={close} />)
  const dismiss = (key: string) => {
    writeLocal(key, '1')
    setDismissed((n) => n + 1)
  }

  return (
    <Section className="sk-card">
      <button type="button" className="sk-card__main" onClick={() => openStakes()}>
        <StakesItems items={model.rows} />
        <Icon name="chevronRight" size={18} weight={2.6} className="sk-card__chevron" />
      </button>
      {model.news && <NewsLine news={model.news} people={people} onOpen={openStakes} onDismiss={dismiss} />}
      {model.pending && <PendingLine pending={model.pending} people={people} onOpen={() => openStakes()} onEdit={openEditor} />}
      {model.alone && (
        <div className="s-alone">
          <AvatarStack people={[personOf(profiles, me)]} size={28} />
          <span className="s-alone__text">Stakes need witnesses. Invite at least one friend.</span>
          <Button size="small" onClick={onInvite}>
            Invite
          </Button>
        </div>
      )}
    </Section>
  )
}

function Glyph({ icon, done }: { icon: IconName; done?: boolean }) {
  return (
    <span className="sk-line__lead" aria-hidden>
      <span className={done ? 'sk-line__glyph sk-line__glyph--done' : 'sk-line__glyph'}>
        <Icon name={icon} size={15} weight={2.2} />
      </span>
    </span>
  )
}

function CloseButton({ onPress }: { onPress: () => void }) {
  return (
    <button type="button" className="sk-line__close" aria-label="Dismiss" onClick={onPress}>
      <span className="sk-line__close-dot">
        <Icon name="xmark" size={11} weight={3} />
      </span>
    </button>
  )
}

function NewsLine({ news, people, onOpen, onDismiss }: { news: CardNews; people: Profiles; onOpen: (focus?: UID) => void; onDismiss: (key: string) => void }) {
  if (news.kind === 'agree') {
    return (
      <button type="button" className="sk-line" onClick={() => onOpen(news.focus)}>
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
  if (news.kind === 'friend') {
    const person = personOf(people, news.uid)
    return (
      <div className="sk-line sk-line--split">
        <button type="button" className="sk-line__main" onClick={() => onOpen(news.uid)}>
          <span className="sk-line__lead" aria-hidden>
            <Avatar name={person.name} color={person.color} photo={person.photo} size={28} />
          </span>
          <span className="sk-line__text">
            <span className="sk-line__title">{news.text}</span>
          </span>
        </button>
        <CloseButton onPress={() => onDismiss(news.seenKey)} />
      </div>
    )
  }
  return (
    <div className="sk-line sk-line--split">
      <button type="button" className="sk-line__main" onClick={() => onOpen()}>
        <Glyph icon="bell" />
        <span className="sk-line__text">
          <span className="sk-line__title">{news.text}</span>
          <span>{news.message}</span>
        </span>
      </button>
      <CloseButton onPress={() => onDismiss(news.seenKey)} />
    </div>
  )
}

/** Who you wait for, in the glyph column so the words line up with the rows above: one avatar, or two
 *  overlapping on the diagonal (like a group in Messages) when it's more than one friend. */
function Waiting({ people }: { people: Person[] }) {
  if (people.length === 1) {
    const [p] = people
    return <Avatar name={p.name} color={p.color} photo={p.photo} size={28} />
  }
  return (
    <span className="sk-cluster">
      {people.slice(0, 2).map((p, i) => (
        <Avatar key={p.id ?? i} name={p.name} color={p.color} photo={p.photo} size={20} className={i === 0 ? 'sk-cluster__back' : 'sk-cluster__front'} />
      ))}
    </span>
  )
}

function PendingLine({ pending, people, onOpen, onEdit }: { pending: CardPending; people: Profiles; onOpen: () => void; onEdit: (focus?: UID) => void }) {
  switch (pending.kind) {
    case 'waiting':
      return (
        <button type="button" className="sk-line" onClick={onOpen}>
          <span className="sk-line__lead" aria-hidden>
            <Waiting people={pending.uids.map((uid) => personOf(people, uid))} />
          </span>
          <span className="sk-line__text">
            <span className="sk-line__title">{pending.text}</span>
          </span>
        </button>
      )
    case 'missing':
      return (
        <button type="button" className="sk-line" onClick={() => onEdit(pending.uids[0])}>
          <Glyph icon="plus" />
          <span className="sk-line__text">
            <span className="sk-line__title sk-line__title--action">{pending.text}</span>
          </span>
        </button>
      )
    case 'house':
      return (
        <button type="button" className="sk-line" onClick={() => onEdit()}>
          <Glyph icon="person2" />
          <span className="sk-line__text">{pending.text}</span>
          <span className="sk-line__action">Set Your Own</span>
        </button>
      )
    case 'agreed':
      return (
        <button type="button" className="sk-line" onClick={onOpen}>
          <Glyph icon="checkmark" done />
          <span className="sk-line__text">
            <span className="sk-line__title">{pending.text}</span>
          </span>
        </button>
      )
    case 'leaver':
      return (
        <button type="button" className="sk-line" onClick={onOpen}>
          <Glyph icon="info" />
          <span className="sk-line__text">{pending.text}</span>
        </button>
      )
    case 'judge':
      return (
        <button type="button" className="sk-line" onClick={onOpen}>
          <Glyph icon="person2" />
          <span className="sk-line__text">{pending.text}</span>
        </button>
      )
  }
}
