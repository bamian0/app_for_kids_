// Pieces the Friends screens share: a person row with its own trailing actions, a friend's ring, and the
// hooks that decide who shows where (People in Your Spaces, a person's relation to you).
import { useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { acceptFriend, askFriend, declineFriend, useAuth, useFriendships, useMySpaces, useProfiles, useRing } from '../../data/api.ts'
import { askAgainAt, relationOf } from '../../domain/friends.ts'
import { ringLine, ringView } from '../../domain/showcase.ts'
import type { FriendRelation, FriendsView, RingView, UID, UserProfile } from '../../domain/types.ts'
import { Avatar, Button, Icon, ScoreRing, cx, haptic, useToast } from '../../ui/index.ts'
import { usePress } from '../../ui/press.ts'
import { useNow } from '../components/clock.ts'
import { personOf } from '../components/people.ts'
import type { Person } from '../components/people.ts'
import { deviceZone } from '../components/zone.ts'
import { addResultToast, askAgainText, declinedToast, friendsToast, peopleInSpaces } from './copy.ts'
import type { PersonInSpaces, ToastCopy } from './copy.ts'

export const EMPTY_VIEW: FriendsView = Object.freeze({ friends: [], incoming: [], sent: [], withdrawn: [] }) as unknown as FriendsView

export function errorText(e: unknown, fallback = 'Something went wrong. Try again.'): string {
  return e instanceof Error && e.message ? e.message : fallback
}

/** A toast from copy.ts's wording (success ones get the check and the haptic). */
export function useCopyToast(): (copy: ToastCopy) => void {
  const toast = useToast()
  return (copy) => {
    if (copy.success) haptic()
    toast({ title: copy.title, message: copy.message, tone: copy.success ? 'success' : 'default', icon: copy.success ? 'checkmark' : undefined })
  }
}

interface PersonRowProps {
  person: Person
  subtitle?: ReactNode
  /** Trailing secondary text ("Requested", "Ask again Nov 19"). */
  detail?: ReactNode
  /** Trailing controls (Add…) or a ring; they stay tappable on their own. */
  trailing?: ReactNode
  /** Controls under the name and line (a request's Accept and Decline), tappable on their own. */
  below?: ReactNode
  chevron?: boolean
  /** Opens their showcase: the whole row is the target, except the trailing controls. */
  onOpen?: () => void
}

/** A list row for a person: avatar, name and a line, with trailing buttons that don't open the row. */
export function PersonRow({ person, subtitle, detail, trailing, below, chevron, onOpen }: PersonRowProps) {
  const { pressed, handlers } = usePress(!!onOpen)
  return (
    <div className={cx('ui-row fr-person', subtitle != null && 'ui-row--subtitle')} data-pressed={pressed || undefined}>
      {onOpen && (
        <button
          type="button"
          className="fr-person__open"
          aria-label={typeof subtitle === 'string' ? `${person.name}, ${subtitle}` : person.name}
          onClick={onOpen}
          {...handlers}
        />
      )}
      <span className="ui-row__leading">
        <Avatar name={person.name} color={person.color} photo={person.photo} size={40} />
      </span>
      <span className="ui-row__main">
        <span className="ui-row__text">
          <span className="ui-row__title">{person.name}</span>
          {subtitle != null && <span className="ui-row__subtitle">{subtitle}</span>}
          {below && <span className="fr-person__below">{below}</span>}
        </span>
        {detail != null && <span className="ui-row__detail">{detail}</span>}
        {trailing && <span className="ui-row__accessory fr-person__trailing">{trailing}</span>}
        {chevron && <Icon name="chevronRight" size={20} weight={2.6} className="ui-row__chevron" />}
      </span>
    </div>
  )
}

/** A small ring for a list row: the number is in the row's line already, so the ring stands alone. */
export function MiniRing({ view }: { view: RingView }) {
  return (
    <ScoreRing
      key={view.value === null ? 'empty' : 'score'}
      value={view.value}
      size={44}
      stroke={5}
      className="fr-mini-ring"
      aria-label={ringLine(view)}
    />
  )
}

/** Someone's ring as this device shows it. Only yours and friends' are readable: mount it for those alone. */
export function useRingView(uid: UID): RingView {
  const ring = useRing(uid)
  const nowMs = useNow()
  return useMemo(() => ringView(ring.data ?? null, nowMs, deviceZone()), [ring.data, nowMs])
}

/** Your pairs, or an empty view while they load. */
export function useView(): { view: FriendsView; loaded: boolean; error: Error | null } {
  const live = useFriendships()
  return { view: live.data ?? EMPTY_VIEW, loaded: live.data !== undefined, error: live.error }
}

export interface Relation {
  relation: FriendRelation
  /** When the pair's state began (friends since, asked at), for the showcase's line. */
  at: number | null
  /** Your canceled request's cool-down end, while it runs. */
  askAgain: number | null
}

/** How `uid` relates to you right now. */
export function relationTo(view: FriendsView, me: UID | null, uid: UID, nowMs: number): Relation {
  const relation = me ? relationOf(view, me, uid) : 'none'
  const pair = [...view.friends, ...view.incoming, ...view.sent].find((p) => p.uid === uid)
  return { relation, at: pair?.at ?? null, askAgain: relation === 'none' ? askAgainAt(view, uid, nowMs) : null }
}

/**
 * People in Your Spaces, with their profiles. `sticky`: once listed, someone stays listed while the caller lives
 * (the Add Friend sheet: their row turns to "Requested" in place instead of jumping away).
 */
export function usePeopleInSpaces(view: FriendsView, sticky = false): { people: PersonInSpaces[]; profiles: Record<UID, UserProfile> } {
  const { uid: me } = useAuth()
  const spaces = useMySpaces().data
  const memberIds = useMemo(() => [...new Set((spaces ?? []).flatMap((s) => s.memberIds))].filter((u) => u !== me), [spaces, me])
  const profiles = useProfiles(memberIds)
  const seen = useRef(new Map<UID, PersonInSpaces>())
  const people = useMemo(() => {
    if (!me || !spaces) return []
    const now = peopleInSpaces(spaces, me, view, profiles)
    if (!sticky) return now
    for (const p of now) seen.current.set(p.uid, p)
    const listed = new Set(now.map((p) => p.uid))
    // Someone listed earlier keeps their place (with their current relation) while the sheet is up.
    const kept = [...seen.current.values()].filter((p) => !listed.has(p.uid) && profiles[p.uid] && spaces.some((s) => s.memberIds.includes(p.uid)))
    const nameOf = (uid: UID) => profiles[uid]?.name?.trim() || ''
    return [...now, ...kept].sort((a, b) => nameOf(a.uid).localeCompare(nameOf(b.uid)) || (a.uid < b.uid ? -1 : 1))
  }, [me, spaces, view, profiles, sticky])
  return { people, profiles }
}

/** Ask, accept, decline: each with its toast, and busy while it runs. */
export function useFriendActions(): {
  busy: string | null
  ask: (uid: UID, name: string, askAgain?: number | null) => Promise<void>
  accept: (uid: UID, name: string) => Promise<void>
  decline: (uid: UID, name: string) => Promise<void>
} {
  const toast = useToast()
  const show = useCopyToast()
  const { view } = useView()
  const [busy, setBusy] = useState<string | null>(null)
  const run = async (key: string, work: () => Promise<void>) => {
    if (busy) return
    setBusy(key)
    try {
      await work()
    } finally {
      setBusy(null)
    }
  }
  return {
    busy,
    ask: (uid, name) =>
      run(`ask:${uid}`, async () => {
        try {
          const result = await askFriend(uid)
          const copy = addResultToast(result, name, askAgainAt(view, uid, Date.now()), Date.now())
          if (copy) show(copy)
        } catch (e) {
          toast({ title: 'Couldn’t send the request', message: errorText(e), tone: 'error' })
        }
      }),
    accept: (uid, name) =>
      run(`accept:${uid}`, async () => {
        try {
          await acceptFriend(uid)
          show(friendsToast(name))
        } catch (e) {
          toast({ title: 'Couldn’t accept', message: errorText(e), tone: 'error' })
        }
      }),
    decline: (uid, name) =>
      run(`decline:${uid}`, async () => {
        try {
          await declineFriend(uid)
          show(declinedToast(name))
        } catch (e) {
          toast({ title: 'Couldn’t decline', message: errorText(e), tone: 'error' })
        }
      }),
  }
}

/** The trailing part of a person's row by relation: Add / Ask again / Requested / Friends / Accept. */
export function RelationAction({
  uid,
  name,
  rel,
  actions,
}: {
  uid: UID
  name: string
  rel: Relation
  actions: ReturnType<typeof useFriendActions>
}) {
  const nowMs = useNow()
  if (rel.relation === 'friend') return <span className="fr-detail">Friends</span>
  if (rel.relation === 'sent') return <span className="fr-detail">Requested</span>
  if (rel.relation === 'incoming') {
    return (
      <Button size="small" loading={actions.busy === `accept:${uid}`} disabled={!!actions.busy} onClick={() => void actions.accept(uid, name)}>
        Accept
      </Button>
    )
  }
  if (rel.relation === 'none' && rel.askAgain !== null) return <span className="fr-detail">{askAgainText(rel.askAgain, nowMs)}</span>
  if (rel.relation === 'none') {
    return (
      <Button size="small" loading={actions.busy === `ask:${uid}`} disabled={!!actions.busy} onClick={() => void actions.ask(uid, name)} aria-label={`Add ${name}`}>
        Add
      </Button>
    )
  }
  return null
}

/** A person from the profiles record (or a placeholder name while it loads). */
export function personFor(profiles: Record<UID, UserProfile>, uid: UID, fallbackName?: string): Person {
  const person = personOf(profiles, uid)
  return profiles[uid] || !fallbackName ? person : { ...person, name: fallbackName }
}
