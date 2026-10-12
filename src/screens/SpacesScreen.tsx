// Home: every space you're in as a card with your month score and the one thing that matters now.
import { useCallback, useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { useAuth, useMonth, useMySpaces, useProfiles } from '../data/api.ts'
import { enablePush, isIOS, isPushEnabled, isStandalone, preloadPushConfig, pushSupport } from '../push/index.ts'
import { computeMonth, computeWeek, joinedAfterLock } from '../domain/scoring.ts'
import { addWeeks, monthIdForWeek, weekBounds, weekIdFor, weekPhase } from '../domain/time.ts'
import type { Space, UID, WeekId } from '../domain/types.ts'
import { Avatar, AvatarStack, Button, EmptyState, GlassButton, Icon, Row, ScoreRing, Screen, Section, cx, useAlert, useNav, useSheet, useTabBar, useToast } from '../ui/index.ts'
import type { IconName } from '../ui/index.ts'
import { usePress } from '../ui/press.ts'
import { Loading } from './components/Bits.tsx'
import { useNow } from './components/clock.ts'
import { monthName, wholePercent } from './components/format.ts'
import { freshVerdictMonth, verdictStatus } from './components/month.ts'
import { takeOpenTarget } from './components/openTarget.ts'
import { takePendingJoin } from './components/pendingJoin.ts'
import { firstName, nameOf, personOf } from './components/people.ts'
import { spaceStatus } from './components/status.ts'
import type { StatusContext, StatusLine } from './components/status.ts'
import { firstTime, readLocal, writeLocal } from './components/storage.ts'
import { deadlineDay } from './components/zone.ts'
import { CreateSpaceSheet } from './CreateSpaceSheet.tsx'
import { InstallGuideSheet } from './InstallGuide.tsx'
import { JoinSheet } from './JoinSheet.tsx'
import { ProfileSheet } from './ProfileSheet.tsx'
import { SpaceScreen } from './SpaceScreen.tsx'

const INSTALL_DISMISSED = 'installCardDismissed'
const REMINDERS_DISMISSED = 'remindersCardDismissed'

export function SpacesScreen() {
  const nav = useNav()
  const sheet = useSheet()
  const { actionSheet } = useAlert()
  const auth = useAuth()
  const spaces = useMySpaces()
  const [showInstall, setShowInstall] = useState(() => isIOS() && !isStandalone() && !readLocal(INSTALL_DISMISSED))
  const { push } = nav
  const { present } = sheet
  const selectTab = useTabBar()?.select

  const openSpace = useCallback((id: string, title?: string) => push(<SpaceScreen spaceId={id} />, { title }), [push])

  const create = useCallback(
    () => present((close) => <CreateSpaceSheet close={close} onOpen={(space) => openSpace(space.id, space.name)} />),
    [present, openSpace],
  )
  const installGuide = useCallback((joined?: string) => present((close) => <InstallGuideSheet close={close} joined={joined} />), [present])
  const join = useCallback(
    (code?: string) =>
      present((close) => (
        <JoinSheet
          close={close}
          initialCode={code}
          onJoined={(id, name, fresh) => {
            close()
            openSpace(id, name)
            // In a Safari tab, a new member's next step is installing: reminders only reach the Home Screen app.
            if (fresh && isIOS() && !isStandalone() && firstTime('installAfterJoin')) window.setTimeout(() => installGuide(name), 450)
          }}
        />
      )),
    [present, openSpace, installGuide],
  )

  // An invite link that arrived before sign-in opens the join flow now; a notification opens its space.
  // Either way on the Spaces tab, where the space will open.
  useEffect(() => {
    const code = takePendingJoin()
    if (code) {
      selectTab?.('spaces')
      join(code)
      return
    }
    const target = takeOpenTarget()
    if (target) {
      selectTab?.('spaces')
      push(<SpaceScreen spaceId={target.spaceId} initialTab={target.monthId ? 'month' : undefined} initialMonth={target.monthId ?? undefined} />)
    }
  }, [join, push, selectTab])

  const addMenu = async () => {
    const choice = await actionSheet({ actions: [{ label: 'New Space' }, { label: 'Join with Code' }] })
    if (choice === 'New Space') create()
    if (choice === 'Join with Code') join()
  }

  const me = auth.profile
  const mine = personOf(me ? { [me.uid]: me } : {}, auth.uid ?? '')
  const myName = me?.name ?? auth.email ?? 'You'
  const list = spaces.data

  return (
    <Screen
      title="Spaces"
      trailing={
        <>
          <GlassButton icon="plus" aria-label="New space or join" onClick={addMenu} />
          <button type="button" className="s-avatar-button" aria-label="Profile" onClick={() => present((close) => <ProfileSheet close={close} onInstallGuide={() => installGuide()} />)}>
            <Avatar name={myName} color={mine.color} photo={mine.photo} size={36} />
          </button>
        </>
      }
    >
      {showInstall && (
        <NudgeCard
          icon="addToHomeScreen"
          title="Add Stakes to your Home Screen"
          text="Reminders only work from the installed app. Takes 10 seconds."
          onPress={() => installGuide()}
          onDismiss={() => {
            writeLocal(INSTALL_DISMISSED, '1')
            setShowInstall(false)
          }}
        />
      )}
      {auth.uid && <RemindersCard uid={auth.uid} />}

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
  const { pressed, handlers } = usePress(true, 70)
  const weekId = weekIdFor(nowMs, space.timezone)
  const monthId = monthIdForWeek(weekId)
  // A month that ended less than a week ago: its verdict leads the card.
  const fresh = freshVerdictMonth(space, uid, nowMs)
  const month = useMonth(space, monthId)
  const verdictMonth = useMonth(space, fresh ?? monthId)
  const weekData = month.data?.find((w) => w.weekId === weekId)
  const bounds = weekData?.week ?? weekBounds(weekId, space.timezone)
  const phase = weekPhase(bounds, nowMs)
  const week = weekData ? computeWeek(weekData, space, nowMs) : null
  const mine = month.data ? computeMonth(space, monthId, month.data, nowMs)[uid] : undefined
  const verdict = fresh && verdictMonth.data ? computeMonth(space, fresh, verdictMonth.data, nowMs)[uid] : undefined
  const profiles = useProfiles([...space.memberIds, ...(verdict?.others ?? [])])

  let ring: number | null = null
  let caption = ''
  let iridescent = true
  if (fresh && verdict?.finalScore != null) {
    ring = verdict.finalScore
    caption = monthName(fresh)
  } else if (mine?.finalScore != null) {
    ring = mine.finalScore
    caption = mine.complete ? 'Month' : 'So far'
  } else if (week && phase !== 'planning' && week.members[uid]?.participating) {
    const m = week.members[uid]
    ring = m.score ?? m.provisionalScore
    // Your own check-offs until friends' reviews are in: labelled, and never the prism.
    caption = m.score != null ? 'This week' : 'Provisional'
    iridescent = m.score != null
  }

  const verdictLine = fresh && verdict ? verdictStatus(fresh, verdict, uid, (id) => firstName(nameOf(profiles, id))) : null
  const withVerdict = (status: StatusLine): StatusLine =>
    verdict && verdictLine && status.tone !== 'urgent'
      ? { text: verdictLine, icon: verdict.passed ? 'trophy' : 'flame', tone: verdict.passed && verdict.others.length > 0 ? 'done' : 'default' }
      : status
  const ctx = (nextWeekTasks: number | null): StatusContext => ({
    memberIds: space.memberIds,
    joinedLate: joinedAfterLock(space, uid, bounds.lockAt),
    nextWeekTasks,
    nextLock: deadlineDay(weekBounds(addWeeks(weekId, 1), space.timezone).lockAt, space.timezone),
  })

  const people = space.memberIds.map((id) => personOf(profiles, id))
  const others = space.memberIds.length - 1

  return (
    <button type="button" className="s-space-card" data-pressed={pressed || undefined} onClick={onOpen} {...handlers}>
      <span className="s-space-card__top">
        <span className="s-space-card__info">
          <span className="s-space-card__name">{space.name}</span>
          <span className="s-space-card__stakes">
            <Icon name="trophy" size={14} weight={2} />
            <span className="s-space-card__stakes-text">{space.reward}</span>
          </span>
          <span className="s-space-card__people">
            <AvatarStack people={people} size={24} max={5} />
            <span className="s-space-card__count">{others === 0 ? 'Just you' : `You + ${others}`}</span>
          </span>
        </span>
        <span className="s-space-card__score">
          <ScoreRing
            value={ring}
            threshold={space.threshold}
            iridescent={iridescent}
            size={68}
            stroke={7}
            aria-label={ring == null ? 'No score yet' : `${caption}: ${wholePercent(ring)} percent`}
          >
            <span className={cx('s-space-card__ring-value t-tabular', ring == null && 'c-tertiary')}>{ring == null ? '—' : wholePercent(ring)}</span>
          </ScoreRing>
          {caption && <span className="s-space-card__caption">{caption}</span>}
        </span>
      </span>
      {week ? (
        phase === 'closed' ? (
          <WeekendStatus space={space} weekId={weekId} uid={uid} render={(next) => <StatusRow status={withVerdict(spaceStatus(week, bounds, uid, nowMs, ctx(next)))} />} />
        ) : (
          <StatusRow status={withVerdict(spaceStatus(week, bounds, uid, nowMs, ctx(null)))} />
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

interface NudgeCardProps {
  icon: IconName
  title: string
  text: string
  /** A capsule under the text, for cards whose tap does something (rather than opening more). */
  action?: string
  busy?: boolean
  onPress: () => void
  onDismiss: () => void
}

/** A dismissible card above the spaces: install the app, turn on reminders. */
function NudgeCard({ icon, title, text, action, busy, onPress, onDismiss }: NudgeCardProps) {
  return (
    <div className="s-install">
      <button type="button" className="s-install__main" onClick={onPress} disabled={busy}>
        <span className="s-install__icon" aria-hidden>
          <Icon name={icon} size={24} weight={1.9} />
        </span>
        <span className="s-install__text">
          <span className="t-headline">{title}</span>
          <span className="t-subheadline c-secondary">{text}</span>
          {action && <span className={cx('s-install__action', busy && 'is-busy')}>{action}</span>}
        </span>
      </button>
      <button type="button" className="s-install__close" aria-label="Dismiss" onClick={onDismiss}>
        <Icon name="xmark" size={13} weight={2.6} />
      </button>
    </div>
  )
}

/** In the installed app, until reminders are on (or the card is dismissed): one tap to turn them on. */
function RemindersCard({ uid }: { uid: UID }) {
  const toast = useToast()
  const [show, setShow] = useState(false)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (!isStandalone() || pushSupport() !== 'supported' || readLocal(REMINDERS_DISMISSED)) return
    if (typeof Notification === 'undefined' || Notification.permission !== 'default') return
    // Safari only asks for permission inside the tap itself, so everything it needs is fetched now.
    void preloadPushConfig()
    let live = true
    isPushEnabled().then((on) => live && setShow(!on))
    return () => {
      live = false
    }
  }, [uid])

  if (!show) return null

  const turnOn = () => {
    if (busy) return
    const pending = enablePush(uid)
    setBusy(true)
    pending
      .then((ok) => {
        if (ok) {
          toast({ title: 'Reminders on', icon: 'bell' })
          setShow(false)
        } else if (Notification.permission === 'denied') {
          toast({ title: 'Notifications are off', message: 'Allow them in Settings › Notifications › Stakes.' })
          setShow(false)
        }
      })
      .catch((e: unknown) => toast({ title: 'Couldn’t turn on reminders', message: e instanceof Error ? e.message : undefined, tone: 'error' }))
      .finally(() => setBusy(false))
  }

  return (
    <NudgeCard
      icon="bell"
      title="Turn on reminders"
      text="A nudge before your list locks and before reviews are due. A missed review costs 5 points."
      action="Turn On"
      busy={busy}
      onPress={turnOn}
      onDismiss={() => {
        writeLocal(REMINDERS_DISMISSED, '1')
        setShow(false)
      }}
    />
  )
}
