// Home: every space you're in as a card with your month score and the one thing that matters now.
import { useCallback, useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { useAuth, useMonthData, useMySpaces, useProfiles, useWeek } from '../data/api.ts'
import { enablePush, isIOS, isPushEnabled, isStandalone, preloadPushConfig, pushSupport } from '../push/index.ts'
import { isWeekPaused, pauseView } from '../domain/pause.ts'
import { boundsFor } from '../domain/schedule.ts'
import { computeMonth, computeWeek, joinedAfterLock, judgesOf, membersAt, spaceJudges } from '../domain/scoring.ts'
import { addWeeks, isMonthlyReviewWeek, monthIdForWeek, weekIdFor, weekPhase } from '../domain/time.ts'
import type { Space, UID, WeekData, WeekId } from '../domain/types.ts'
import { Avatar, AvatarStack, Button, EmptyState, GlassButton, Icon, Row, ScoreRing, Screen, Section, cx, useAlert, useNav, useSheet, useTabBar, useToast } from '../ui/index.ts'
import type { IconName } from '../ui/index.ts'
import { usePress } from '../ui/press.ts'
import { Loading } from './components/Bits.tsx'
import { useNow } from './components/clock.ts'
import { monthName, wholePercent } from './components/format.ts'
import { freshVerdictMonth, judgeOnly, verdictStatus } from './components/month.ts'
import { takeOpenTarget } from './components/openTarget.ts'
import { takePendingJoin } from './components/pendingJoin.ts'
import { firstName, nameOf, personOf } from './components/people.ts'
import { spaceStatus } from './components/status.ts'
import type { StatusContext, StatusLine } from './components/status.ts'
import { firstTime, readLocal, writeLocal } from './components/storage.ts'
import { deadlineDay, deviceHourCycle } from './components/zone.ts'
import { CreateSpaceSheet } from './CreateSpaceSheet.tsx'
import { HelpButton } from './help/HelpSheet.tsx'
import { InstallGuideSheet } from './InstallGuide.tsx'
import { JoinSheet } from './JoinSheet.tsx'
import { reviewParts } from './monthly/review.ts'
import { ProfileSheet } from './ProfileSheet.tsx'
import { SpaceScreen } from './SpaceScreen.tsx'
import { pauseAskLine, scheduleNotice, weekFor } from './space/space.ts'

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
      leading={<HelpButton />}
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
  const month = useMonthData(space, monthId)
  const verdictMonth = useMonthData(space, fresh ?? monthId)
  const weekData = month.data?.weeks.find((w) => w.weekId === weekId)
  const weekDoc = weekData?.week ?? null
  const bounds = boundsFor(space, weekId, weekDoc)
  const phase = weekPhase(bounds, nowMs)
  const week = weekData ? computeWeek(weekData, space, nowMs) : null
  const mine = month.data ? computeMonth(space, monthId, month.data.weeks, nowMs, month.data.monthly)[uid] : undefined
  const verdict = fresh && verdictMonth.data ? computeMonth(space, fresh, verdictMonth.data.weeks, nowMs, verdictMonth.data.monthly)[uid] : undefined
  const profiles = useProfiles([...space.memberIds, ...(verdict?.others ?? [])])
  const name = (id: UID) => firstName(nameOf(profiles, id))
  const meWeek = week?.members[uid]
  // Only judged this month: someone who also played a week friends skipped isn't (their week says "Skipped").
  const judgeOnlyMonth = !!mine && mine.finalScore === null && judgeOnly(mine)

  let ring: number | null = null
  let caption = ''
  let iridescent = true
  if (fresh && verdict?.finalScore != null) {
    ring = verdict.finalScore
    caption = monthName(fresh)
  } else if (mine?.finalScore != null) {
    ring = mine.finalScore
    caption = mine.complete ? 'Month' : 'So far'
  } else if ((meWeek?.participating && meWeek.judge) || judgeOnlyMonth) {
    // Judging: nothing at stake, so no score to show.
    caption = 'Judge'
  } else if (week && !week.paused && phase !== 'planning' && meWeek?.participating) {
    if (week.revealed && meWeek.skipped) {
      // Friends excused every task (SPEC §10.5): no score, and the week doesn't count.
      caption = 'Skipped'
    } else {
      ring = meWeek.score ?? meWeek.provisionalScore
      // Your own check-offs until friends' reviews are in: labelled, and never the prism. Every task crossed out:
      // there is no provisional score, and the caption says why.
      caption = meWeek.score != null ? 'This week' : ring == null && (meWeek.cancelledCount ?? 0) > 0 ? 'Crossed out' : 'Provisional'
      iridescent = meWeek.score != null
    }
  }

  const verdictLine = fresh && verdict ? verdictStatus(fresh, verdict, uid, name) : null
  const seen = (key: string) => readLocal(key) !== null
  const request = space.pause
  const pause = request ? pauseView(space, uid, nowMs, weekFor(space, request.weekId, [weekDoc])) : null
  const note = space.scheduleNote
  const notice = scheduleNotice({
    space,
    me: uid,
    nowMs,
    thisWeek: weekId,
    fromWeekDeadline: note ? weekFor(space, note.fromWeek, [weekDoc]).deadlineAt : null,
    name,
    seen,
    hourCycle: deviceHourCycle(),
  })
  // In the month's last week the month's lists are reviewed too (even when the week is paused).
  const parts = reviewParts(weekData, isMonthlyReviewWeek(weekId) ? month.data?.monthly : undefined, uid, space, nowMs)
  const ctx = (next: WeekData | undefined): StatusContext => ({
    memberIds: space.memberIds,
    counted: membersAt(space, bounds.lockAt),
    joinedLate: joinedAfterLock(space, uid, bounds.lockAt),
    nextWeekTasks: next ? (next.plans[uid]?.tasks.length ?? 0) : null,
    nextLock: deadlineDay(boundsFor(space, addWeeks(weekId, 1), next?.week ?? null).lockAt, space.timezone),
    monthlyDue: parts.monthly.open && parts.monthly.targets.length > 0,
    pauseAsk: pause ? pauseAskLine(pause, weekId, name) : null,
    nextPaused: isWeekPaused(space, addWeeks(weekId, 1)),
    judgingNext: next?.week ? judgesOf(next.week).includes(uid) : spaceJudges(space).includes(uid),
    verdict:
      verdict && verdictLine
        ? { text: verdictLine, icon: verdict.passed ? 'trophy' : 'flame', tone: verdict.passed && verdict.others.length > 0 ? 'done' : 'default' }
        : null,
    // "New times from next week" for those who knew the old times (not the newcomer's "own times" note).
    notice: notice?.kind === 'change' ? notice.title : null,
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
            aria-label={ring == null ? (caption === 'Judge' ? 'Judge, no score' : caption === 'Skipped' || caption === 'Crossed out' ? `${caption}, no score` : 'No score yet') : `${caption}: ${wholePercent(ring)} percent`}
          >
            <span className={cx('s-space-card__ring-value t-tabular', ring == null && 'c-tertiary')}>{ring == null ? '—' : wholePercent(ring)}</span>
          </ScoreRing>
          {caption && <span className="s-space-card__caption">{caption}</span>}
        </span>
      </span>
      {week ? (
        phase === 'closed' ? (
          <WeekendStatus space={space} weekId={weekId} render={(next) => <StatusRow status={spaceStatus(week, bounds, uid, nowMs, ctx(next))} />} />
        ) : (
          <StatusRow status={spaceStatus(week, bounds, uid, nowMs, ctx(undefined))} />
        )
      ) : (
        <StatusRow status={null} />
      )}
    </button>
  )
}

/** On the weekend the card also looks ahead to next week (plan it, or it's paused or judged), which needs its data. */
function WeekendStatus({ space, weekId, render }: { space: Space; weekId: WeekId; render: (next: WeekData | undefined) => ReactNode }) {
  const next = useWeek(space, addWeeks(weekId, 1))
  return <>{render(next.data)}</>
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
