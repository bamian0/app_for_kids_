// Home: every space you're in as a card with your month score and the one thing that matters now.
import { useCallback, useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { useAuth, useMonth, useMySpaces, useProfiles } from '../data/api.ts'
import { isIOS, isStandalone } from '../push/index.ts'
import { computeMonth, computeWeek } from '../domain/scoring.ts'
import { addWeeks, monthIdForWeek, weekBounds, weekIdFor, weekPhase } from '../domain/time.ts'
import type { Space, UID, WeekId } from '../domain/types.ts'
import { Avatar, AvatarStack, Button, EmptyState, GlassButton, Icon, Row, ScoreRing, Screen, Section, cx, useAlert, useNav, useSheet } from '../ui/index.ts'
import { Loading } from './components/Bits.tsx'
import { useNow } from './components/clock.ts'
import { takePendingJoin } from './components/pendingJoin.ts'
import { personOf } from './components/people.ts'
import { spaceStatus } from './components/status.ts'
import type { StatusLine } from './components/status.ts'
import { readLocal, writeLocal } from './components/storage.ts'
import { CreateSpaceSheet } from './CreateSpaceSheet.tsx'
import { InstallGuideSheet } from './InstallGuide.tsx'
import { JoinSheet } from './JoinSheet.tsx'
import { ProfileSheet } from './ProfileSheet.tsx'
import { SpaceScreen } from './SpaceScreen.tsx'

const INSTALL_DISMISSED = 'installCardDismissed'

export function SpacesScreen() {
  const nav = useNav()
  const sheet = useSheet()
  const { actionSheet } = useAlert()
  const auth = useAuth()
  const spaces = useMySpaces()
  const [showInstall, setShowInstall] = useState(() => isIOS() && !isStandalone() && !readLocal(INSTALL_DISMISSED))
  const { push } = nav
  const { present } = sheet

  const openSpace = useCallback((id: string, title?: string) => push(<SpaceScreen spaceId={id} />, { title }), [push])

  const create = useCallback(
    () => present((close) => <CreateSpaceSheet close={close} onOpen={(space) => openSpace(space.id, space.name)} />),
    [present, openSpace],
  )
  const join = useCallback(
    (code?: string) =>
      present((close) => (
        <JoinSheet
          close={close}
          initialCode={code}
          onJoined={(id, name) => {
            close()
            openSpace(id, name)
          }}
        />
      )),
    [present, openSpace],
  )
  const installGuide = useCallback(() => present((close) => <InstallGuideSheet close={close} />), [present])

  // An invite link that arrived before sign-in opens the join flow now.
  useEffect(() => {
    const code = takePendingJoin()
    if (code) join(code)
  }, [join])

  const addMenu = async () => {
    const choice = await actionSheet({ actions: [{ label: 'New Space' }, { label: 'Join with Code' }] })
    if (choice === 'New Space') create()
    if (choice === 'Join with Code') join()
  }

  const me = auth.profile
  const myName = me?.name ?? auth.email ?? 'You'
  const list = spaces.data

  return (
    <Screen
      title="Spaces"
      trailing={
        <>
          <GlassButton icon="plus" aria-label="New space or join" onClick={addMenu} />
          <button type="button" className="s-avatar-button" aria-label="Profile" onClick={() => present((close) => <ProfileSheet close={close} onInstallGuide={installGuide} />)}>
            <Avatar name={myName} color={me?.color ?? 'var(--system-gray)'} size={36} />
          </button>
        </>
      }
    >
      {showInstall && (
        <InstallCard
          onOpen={installGuide}
          onDismiss={() => {
            writeLocal(INSTALL_DISMISSED, '1')
            setShowInstall(false)
          }}
        />
      )}

      {list === undefined ? (
        spaces.error ? (
          <EmptyState icon="info" title="Can’t load your spaces" message={spaces.error.message} />
        ) : (
          <Loading />
        )
      ) : list.length === 0 ? (
        <EmptyState
          icon="person2"
          title="No spaces yet"
          message="A space is you and up to seven friends, one set of stakes, and a reckoning every Friday."
          action={
            <div className="s-empty-actions">
              <Button size="large" fullWidth onClick={create}>
                New Space
              </Button>
              <Button size="large" fullWidth variant="gray" onClick={() => join()}>
                Join with Code
              </Button>
            </div>
          }
        />
      ) : (
        <>
          <div className="s-cards">
            {list.map((space) => (
              <SpaceCard key={space.id} space={space} uid={auth.uid ?? ''} onOpen={() => openSpace(space.id, space.name)} />
            ))}
          </div>
          <Section>
            <Row icon="plus" title="New Space" onPress={create} />
            <Row icon="link" title="Join with Code" onPress={() => join()} />
          </Section>
        </>
      )}
    </Screen>
  )
}

function SpaceCard({ space, uid, onOpen }: { space: Space; uid: UID; onOpen: () => void }) {
  const nowMs = useNow()
  const weekId = weekIdFor(nowMs, space.timezone)
  const monthId = monthIdForWeek(weekId)
  // useMonth reads weeks without joining them: looking at the list doesn't sign you up for a week.
  const month = useMonth(space, monthId)
  const profiles = useProfiles(space.memberIds)
  const weekData = month.data?.find((w) => w.weekId === weekId)
  const bounds = weekData?.week ?? weekBounds(weekId, space.timezone)
  const phase = weekPhase(bounds, nowMs)
  const week = weekData ? computeWeek(weekData, space, nowMs) : null
  const mine = month.data ? computeMonth(space, monthId, month.data, nowMs)[uid] : undefined

  let ring: number | null = null
  let caption = ''
  if (mine?.finalScore != null) {
    ring = mine.finalScore
    caption = mine.complete ? 'Month' : 'So far'
  } else if (week && phase !== 'planning' && week.members[uid]?.participating) {
    ring = week.members[uid].score ?? week.members[uid].provisionalScore
    caption = 'This week'
  }

  const people = space.memberIds.map((id) => personOf(profiles, id))
  const others = space.memberIds.length - 1

  return (
    <button type="button" className="s-space-card" onClick={onOpen}>
      <span className="s-space-card__top">
        <span className="s-space-card__info">
          <span className="s-space-card__name">{space.name}</span>
          <span className="s-space-card__stakes">
            <Icon name="trophy" size={14} weight={2} /> {space.reward}
          </span>
          <span className="s-space-card__people">
            <AvatarStack people={people} size={24} max={5} />
            <span className="s-space-card__count">{others === 0 ? 'Just you' : `You + ${others}`}</span>
          </span>
        </span>
        <span className="s-space-card__score">
          <ScoreRing value={ring} threshold={space.threshold} size={68} stroke={7} aria-label={ring == null ? 'No score yet' : `${Math.floor(ring)} percent`}>
            <span className={cx('s-space-card__ring-value t-tabular', ring == null && 'c-tertiary')}>{ring == null ? '—' : Math.floor(ring + 1e-6)}</span>
          </ScoreRing>
          {caption && <span className="s-space-card__caption">{caption}</span>}
        </span>
      </span>
      {week ? (
        phase === 'closed' ? (
          <WeekendStatus space={space} weekId={weekId} uid={uid} render={(next) => <StatusRow status={spaceStatus(week, bounds, uid, nowMs, next)} />} />
        ) : (
          <StatusRow status={spaceStatus(week, bounds, uid, nowMs, null)} />
        )
      ) : (
        <StatusRow status={null} />
      )}
    </button>
  )
}

/** On the weekend the card also nudges you to plan next week, which needs next week's data. */
function WeekendStatus({ space, weekId, uid, render }: { space: Space; weekId: WeekId; uid: UID; render: (nextWeekTasks: number | null) => ReactNode }) {
  const next = addWeeks(weekId, 1)
  const month = useMonth(space, monthIdForWeek(next))
  const data = month.data?.find((w) => w.weekId === next)
  return <>{render(data ? (data.plans[uid]?.tasks.length ?? 0) : null)}</>
}

function StatusRow({ status }: { status: StatusLine | null }) {
  return (
    <span className={cx('s-space-card__status', status && `s-tone-${status.tone}`)}>
      {status ? (
        <>
          <Icon name={status.icon} size={17} weight={2} />
          <span className="s-space-card__status-text">{status.text}</span>
        </>
      ) : (
        <span className="s-space-card__status-text c-tertiary">Loading…</span>
      )}
      <Icon name="chevronRight" size={18} weight={2.4} className="s-space-card__chevron" />
    </span>
  )
}

function InstallCard({ onOpen, onDismiss }: { onOpen: () => void; onDismiss: () => void }) {
  return (
    <div className="s-install">
      <button type="button" className="s-install__main" onClick={onOpen}>
        <span className="s-install__icon" aria-hidden>
          <Icon name="addToHomeScreen" size={24} weight={1.9} />
        </span>
        <span className="s-install__text">
          <span className="t-headline">Add Stakes to your Home Screen</span>
          <span className="t-subheadline c-secondary">Reminders only work from the installed app. Takes 10 seconds.</span>
        </span>
      </button>
      <button type="button" className="s-install__close" aria-label="Dismiss" onClick={onDismiss}>
        <Icon name="xmark" size={13} weight={2.6} />
      </button>
    </div>
  )
}
