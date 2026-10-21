// The Friends tab (SPEC §11.9.1): requests, shared goals, your friends with their rings, people from your
// spaces, the requests you sent, and the ways to add someone. Friends' showcases push from here; a friend link
// (?friend=) opens Add Friend and a check-in push (?goal=) opens its goal.
import { useCallback, useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { cancelFriendRequest, friendLink, useAuth, useMyFriendCode, useProfiles, useSharedGoals } from '../../data/api.ts'
import type { Friendship, UID } from '../../domain/types.ts'
import { ringLine } from '../../domain/showcase.ts'
import { ActivityIndicator, Button, EmptyState, GlassButton, Icon, Row, Screen, Section, useAlert, useNav, useSheet, useTabBar, useToast } from '../../ui/index.ts'
import { Loading } from '../components/Bits.tsx'
import { useNow } from '../components/clock.ts'
import { shareOrCopy } from '../components/share.ts'
import { HelpButton } from '../help/HelpSheet.tsx'
import { SharedGoalScreen, SharedGoalsSection, useNewSharedGoal } from '../shared/index.ts'
import { AddFriendSheet } from './AddFriendSheet.tsx'
import {
  EMPTY_TITLE,
  PEOPLE_FOOTER,
  RING_FOOTER,
  byName,
  cancelConfirm,
  emptyMessage,
  requestedText,
  requestSubtitle,
  shareLinkData,
  spacesSubtitle,
  youLine,
} from './copy.ts'
import type { PersonInSpaces } from './copy.ts'
import { takeGoalTarget, takePendingFriend } from './links.ts'
import { MiniRing, PersonRow, RelationAction, errorText, personFor, relationTo, useFriendActions, usePeopleInSpaces, useRingView, useView } from './parts.tsx'
import { ShowcaseScreen } from './ShowcaseScreen.tsx'
import './friends.css'

/** People in Your Spaces on the root, before See All. */
const PEOPLE_ON_ROOT = 5

export function FriendsScreen() {
  const nav = useNav()
  const sheet = useSheet()
  const { actionSheet } = useAlert()
  const selectTab = useTabBar()?.select
  const newSharedGoal = useNewSharedGoal()
  const { push } = nav
  const { present } = sheet

  const addFriend = useCallback((code?: string) => present((close) => <AddFriendSheet close={close} initialCode={code} />), [present])

  // A friend link that arrived before (or with) sign-in opens Add Friend on its code; a check-in push opens its
  // goal. Either way on the Friends tab.
  useEffect(() => {
    const code = takePendingFriend()
    const goalId = takeGoalTarget()
    if (code || goalId) selectTab?.('friends')
    if (goalId) push(<SharedGoalScreen goalId={goalId} />)
    if (code) addFriend(code)
  }, [addFriend, push, selectTab])

  const menu = async () => {
    const choice = await actionSheet({ actions: [{ label: 'Add Friend' }, { label: 'New Shared Goal' }] })
    if (choice === 'Add Friend') addFriend()
    if (choice === 'New Shared Goal') newSharedGoal()
  }

  return (
    <Screen title="Friends" leading={<HelpButton />} trailing={<GlassButton icon="plus" aria-label="Add friend or new shared goal" onClick={() => void menu()} />}>
      <FriendsContent onAddFriend={() => addFriend()} />
    </Screen>
  )
}

function FriendsContent({ onAddFriend }: { onAddFriend: () => void }) {
  const nav = useNav()
  const auth = useAuth()
  const me = auth.uid
  const { view, loaded, error } = useView()
  const shared = useSharedGoals()
  const pairUids = [...view.friends, ...view.incoming, ...view.sent].map((p) => p.uid)
  const profiles = useProfiles(pairUids)
  const { people, profiles: spaceProfiles } = usePeopleInSpaces(view)
  const share = useShareMyLink()

  const openShowcase = useCallback(
    (uid: UID, name?: string) => nav.push(<ShowcaseScreen uid={uid} name={name} />, { title: name }),
    [nav],
  )

  if (!loaded) {
    return error ? <EmptyState icon="info" title="Can’t load your friends" message={error.message} /> : <Loading />
  }

  // Pairs with someone whose profile is gone (a deleted account's leftovers) are hidden everywhere.
  const shown = (list: Friendship[]) => list.filter((p) => profiles[p.uid])
  const incoming = shown(view.incoming)
  const friends = byName(shown(view.friends), profiles)
  const sent = shown(view.sent)
  const goals = shared.data ? shared.data.goals.length + shared.data.invites.length : 0
  const empty = view.friends.length + view.incoming.length + view.sent.length === 0 && goals === 0

  const peopleSection = people.length > 0 && <PeopleSection people={people} profiles={spaceProfiles} onSeeAll={onAddFriend} onOpen={openShowcase} />

  if (empty) {
    return (
      <>
        <EmptyState
          icon="person2"
          title={EMPTY_TITLE}
          message={emptyMessage(people.length > 0)}
          action={
            <div className="s-empty-actions">
              <Button size="large" fullWidth onClick={onAddFriend}>
                Add Friend
              </Button>
              <Button size="large" fullWidth variant="gray" loading={share.busy} onClick={share.start}>
                Share My Link
              </Button>
            </div>
          }
        />
        {peopleSection}
        {share.runner}
      </>
    )
  }

  return (
    <>
      {incoming.length > 0 && <RequestsSection requests={incoming} profiles={profiles} onOpen={openShowcase} />}

      <SharedGoalsSection />

      <Section header="Friends" footer={RING_FOOTER}>
        {me && <YouRow uid={me} onOpen={() => openShowcase(me, auth.profile?.name)} />}
        {friends.map((pair) => (
          <FriendRow key={pair.uid} pair={pair} name={personFor(profiles, pair.uid).name} onOpen={openShowcase} />
        ))}
      </Section>

      {peopleSection}

      {sent.length > 0 && <SentSection sent={sent} profiles={profiles} onOpen={openShowcase} />}

      <Section>
        <Row title="Add Friend" action leading={<Icon name="personPlus" size={22} weight={1.9} />} onPress={onAddFriend} />
        <Row
          title="Share My Link"
          action
          leading={<Icon name="share" size={21} weight={1.9} />}
          accessory={share.busy ? <ActivityIndicator color="var(--secondary-label)" label="Getting your link" /> : undefined}
          onPress={share.start}
        />
      </Section>
      {share.runner}
    </>
  )
}

// ---------- Rows ----------

function RequestsSection({ requests, profiles, onOpen }: { requests: Friendship[]; profiles: ReturnType<typeof useProfiles>; onOpen: (uid: UID, name?: string) => void }) {
  const nowMs = useNow()
  const actions = useFriendActions()
  return (
    <Section header="Requests">
      {requests.map((pair) => {
        const person = personFor(profiles, pair.uid)
        return (
          <PersonRow
            key={pair.uid}
            person={person}
            subtitle={requestSubtitle(pair.at, nowMs)}
            onOpen={() => onOpen(pair.uid, person.name)}
            below={
              <span className="fr-actions">
                <Button size="small" loading={actions.busy === `accept:${pair.uid}`} disabled={!!actions.busy} onClick={() => void actions.accept(pair.uid, person.name)}>
                  Accept
                </Button>
                <Button
                  size="small"
                  variant="gray"
                  loading={actions.busy === `decline:${pair.uid}`}
                  disabled={!!actions.busy}
                  onClick={() => void actions.decline(pair.uid, person.name)}
                >
                  Decline
                </Button>
              </span>
            }
          />
        )
      })}
    </Section>
  )
}

function YouRow({ uid, onOpen }: { uid: UID; onOpen: () => void }) {
  const auth = useAuth()
  const ring = useRingView(uid)
  const person = personFor(auth.profile ? { [uid]: auth.profile } : {}, uid, auth.email ?? 'You')
  return <PersonRow person={person} subtitle={youLine(ringLine(ring))} trailing={<MiniRing view={ring} />} chevron onOpen={onOpen} />
}

function FriendRow({ pair, name, onOpen }: { pair: Friendship; name: string; onOpen: (uid: UID, name?: string) => void }) {
  const profiles = useProfiles([pair.uid])
  const ring = useRingView(pair.uid)
  return <PersonRow person={personFor(profiles, pair.uid, name)} subtitle={ringLine(ring)} trailing={<MiniRing view={ring} />} chevron onOpen={() => onOpen(pair.uid, name)} />
}

function PeopleSection({
  people,
  profiles,
  onSeeAll,
  onOpen,
}: {
  people: PersonInSpaces[]
  profiles: ReturnType<typeof useProfiles>
  onSeeAll: () => void
  onOpen: (uid: UID, name?: string) => void
}) {
  const { view } = useView()
  const { uid: me } = useAuth()
  const nowMs = useNow()
  const actions = useFriendActions()
  // More than five: the first five, then See All (the Add Friend sheet lists everyone).
  const more = people.length > PEOPLE_ON_ROOT
  const listed = people.slice(0, PEOPLE_ON_ROOT)
  return (
    <Section header="People in Your Spaces" footer={PEOPLE_FOOTER}>
      {listed.map((p) => {
        const person = personFor(profiles, p.uid)
        return (
          <PersonRow
            key={p.uid}
            person={person}
            subtitle={spacesSubtitle(p.spaces)}
            onOpen={() => onOpen(p.uid, person.name)}
            trailing={<RelationAction uid={p.uid} name={person.name} rel={relationTo(view, me, p.uid, nowMs)} actions={actions} />}
          />
        )
      })}
      {more && <Row title="See All" detail={String(people.length)} chevron onPress={onSeeAll} />}
    </Section>
  )
}

function SentSection({ sent, profiles, onOpen }: { sent: Friendship[]; profiles: ReturnType<typeof useProfiles>; onOpen: (uid: UID, name?: string) => void }) {
  const nowMs = useNow()
  const toast = useToast()
  const { confirm } = useAlert()
  const [busy, setBusy] = useState<UID | null>(null)

  const cancel = async (uid: UID, name: string) => {
    const copy = cancelConfirm(name)
    const ok = await confirm({ title: copy.title, message: copy.message, confirmLabel: copy.confirmLabel, cancelLabel: copy.cancelLabel, destructive: true })
    if (!ok) return
    setBusy(uid)
    try {
      await cancelFriendRequest(uid)
      toast({ title: 'Request canceled' })
    } catch (e) {
      toast({ title: 'Couldn’t cancel', message: errorText(e), tone: 'error' })
    } finally {
      setBusy(null)
    }
  }

  return (
    <Section header="Sent">
      {sent.map((pair) => {
        const person = personFor(profiles, pair.uid)
        return (
          <PersonRow
            key={pair.uid}
            person={person}
            subtitle={requestedText(pair.at, nowMs)}
            onOpen={() => onOpen(pair.uid, person.name)}
            trailing={
              <Button size="small" variant="gray" loading={busy === pair.uid} disabled={busy !== null} onClick={() => void cancel(pair.uid, person.name)}>
                Cancel
              </Button>
            }
          />
        )
      })}
    </Section>
  )
}

// ---------- Share My Link ----------

/**
 * Share My Link: the code is fetched (or created) only once someone asks for it (SPEC §11.6), then shared at once;
 * later taps share straight away. `runner` is the hidden piece that holds the code while the screen lives.
 */
function useShareMyLink(): { busy: boolean; start: () => void; runner: ReactNode } {
  const toast = useToast()
  const [wanted, setWanted] = useState(false)
  const [busy, setBusy] = useState(false)
  const code = useRef<string | null>(null)
  const pending = useRef(false)

  const shareCode = useCallback(
    async (c: string) => {
      const link = friendLink(c)
      const result = await shareOrCopy(shareLinkData(link))
      if (result === 'copied') toast({ title: 'Link copied', icon: 'link' })
      if (result === 'failed') toast({ title: 'Couldn’t share', message: link, tone: 'error' })
    },
    [toast],
  )

  const start = () => {
    if (pending.current) return
    if (code.current) {
      void shareCode(code.current)
      return
    }
    pending.current = true
    setBusy(true)
    setWanted(true)
  }

  const onCode = useCallback(
    (c: string) => {
      code.current = c
      if (!pending.current) return
      pending.current = false
      setBusy(false)
      void shareCode(c)
    },
    [shareCode],
  )
  const onError = useCallback(
    (e: Error) => {
      if (!pending.current) return
      pending.current = false
      setBusy(false)
      toast({ title: 'Couldn’t get your link', message: e.message, tone: 'error' })
    },
    [toast],
  )

  return { busy, start, runner: wanted ? <CodeRunner onCode={onCode} onError={onError} /> : null }
}

/** Holds your friend code (creating it the first time) and reports each new code or error. Renders nothing. */
function CodeRunner({ onCode, onError }: { onCode: (code: string) => void; onError: (e: Error) => void }) {
  const live = useMyFriendCode()
  useEffect(() => {
    if (live.data) onCode(live.data)
    else if (live.error) onError(live.error)
  }, [live.data, live.error, onCode, onError])
  return null
}
