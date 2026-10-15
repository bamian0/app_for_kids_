// One space: the stakes, who's in, and This Week / Next Week / Month. Above the stakes, at most one passing card:
// a request to pause a week, else a change of times. During the review window a floating button sends you
// into the review (this week's lists, and in a month's last week the month's lists too).
import { useState } from 'react'
import type { ReactNode } from 'react'
import { useAuth, useMonthly, useProfiles, useSpace, useWeek } from '../data/api.ts'
import { pauseView } from '../domain/pause.ts'
import { boundsFor } from '../domain/schedule.ts'
import { computeWeek, joinedAfterLock } from '../domain/scoring.ts'
import { addWeeks, formatWeekRange, isMonthlyReviewWeek, monthIdForWeek, weekIdFor } from '../domain/time.ts'
import type { MonthId, Space, UID, WeekId } from '../domain/types.ts'
import { Button, EmptyState, GlassButton, Screen, SegmentedControl, useNav, useSheet } from '../ui/index.ts'
import { Loading } from './components/Bits.tsx'
import { useNow } from './components/clock.ts'
import { monthName } from './components/format.ts'
import { InviteCard } from './components/InviteCard.tsx'
import { compactNames, firstName, listNames, nameOf } from './components/people.ts'
import { readLocal, writeLocal } from './components/storage.ts'
import { deadlineText, deviceHourCycle } from './components/zone.ts'
import { MonthlyCard } from './monthly/MonthlyCard.tsx'
import { MonthlyScreen } from './monthly/MonthlyScreen.tsx'
import { reviewParts } from './monthly/review.ts'
import { MonthView } from './MonthView.tsx'
import { ReviewSheet } from './ReviewSheet.tsx'
import { PauseCard } from './space/PauseCard.tsx'
import { ScheduleNotice } from './space/ScheduleNotice.tsx'
import { ScheduleScreen } from './space/ScheduleScreen.tsx'
import { pauseCardView, scheduleNotice, weekFor } from './space/space.ts'
import { SpaceSettingsScreen } from './SpaceSettingsScreen.tsx'
import { StakesCard } from './stakes/StakesCard.tsx'
import { WeekView } from './WeekView.tsx'

export type SpaceTab = 'this' | 'next' | 'month'
type Tab = SpaceTab

/** Loads a space by id and shows the right state while it loads or after you've left it. */
function SpaceGate({ spaceId, title, render }: { spaceId: string; title?: string; render: (space: Space) => ReactNode }) {
  const nav = useNav()
  const live = useSpace(spaceId)
  if (live.data === undefined) {
    return (
      <Screen title={title ?? ''} titleDisplay="inline">
        {live.error ? <EmptyState icon="info" title="Can’t load this space" message={live.error.message} /> : <Loading />}
      </Screen>
    )
  }
  if (live.data === null) {
    return (
      <Screen title={title ?? 'Space'} titleDisplay="inline">
        <EmptyState
          icon="person2"
          title="You’re not in this space"
          message="You left it, or it no longer exists."
          action={<Button onClick={nav.popToRoot}>Back to Spaces</Button>}
        />
      </Screen>
    )
  }
  return <>{render(live.data)}</>
}

export interface SpaceScreenProps {
  spaceId: string
  /** Open on this tab (e.g. Month, from the verdict notification). */
  initialTab?: SpaceTab
  /** The month the Month tab opens on. */
  initialMonth?: MonthId
}

export function SpaceScreen({ spaceId, initialTab, initialMonth }: SpaceScreenProps) {
  return <SpaceGate spaceId={spaceId} render={(space) => <SpaceContent space={space} initialTab={initialTab} initialMonth={initialMonth} />} />
}

/** A single past week, opened from the month view. */
export function WeekScreen({ spaceId, weekId }: { spaceId: string; weekId: WeekId }) {
  const title = `Week of ${formatWeekRange(weekId)}`
  return (
    <SpaceGate
      spaceId={spaceId}
      title={title}
      render={(space) => (
        <Screen title={title} titleDisplay="inline">
          <WeekWithProfiles space={space} weekId={weekId} />
        </Screen>
      )}
    />
  )
}

function WeekWithProfiles({ space, weekId }: { space: Space; weekId: WeekId }) {
  // A past week can hold people who have left since: load them too.
  const live = useWeek(space, weekId)
  const profiles = useProfiles([...space.memberIds, ...(live.data?.week?.members ?? [])])
  return <WeekView space={space} weekId={weekId} profiles={profiles} />
}

function SpaceContent({ space, initialTab, initialMonth }: { space: Space; initialTab?: Tab; initialMonth?: MonthId }) {
  const nav = useNav()
  const sheet = useSheet()
  const { uid } = useAuth()
  const me = uid ?? ''
  const nowMs = useNow()
  const [picked, setPicked] = useState<Tab | null>(initialTab ?? null)
  // Dismissed notices are remembered on this device; the counter re-renders after a dismiss.
  const [, setDismissed] = useState(0)
  const thisWeek = weekIdFor(nowMs, space.timezone)
  const nextWeek = addWeeks(thisWeek, 1)
  const thisMonth = monthIdForWeek(thisWeek)
  const nextMonth = monthIdForWeek(nextWeek)

  const week = useWeek(space, thisWeek)
  const weekDoc = week.data?.week ?? null
  // This month's list: the review toolbar in its last week, and when this month's terms end (the stakes card).
  const monthlyLive = useMonthly(space, thisMonth)
  const monthly = monthlyLive.error ? undefined : monthlyLive.data
  const profiles = useProfiles([...space.memberIds, ...(weekDoc?.members ?? []), ...(monthly?.monthly?.members ?? [])])
  const result = week.data ? computeWeek(week.data, space, nowMs) : null
  const mine = result?.members[me]
  const bounds = boundsFor(space, thisWeek, weekDoc)
  // Both review parts of this week (the month's lists only in its last week): whom to review, or confirm.
  const parts = reviewParts(week.data, isMonthlyReviewWeek(thisWeek) ? monthly : undefined, me, space, nowMs)
  const reviewDue = parts.people.length > 0 || parts.confirm
  // Sitting this week out (joined after the lock, or the week started without you): open on the
  // week you can still do something about.
  const sittingOut = nowMs >= bounds.lockAt && (joinedAfterLock(space, me, bounds.lockAt) || (!!result && !mine?.participating))
  const tab: Tab = picked ?? (sittingOut ? 'next' : 'this')

  const name = (id: UID) => firstName(nameOf(profiles, id))
  const when = (ms: number) => deadlineText(ms, space.timezone, nowMs)
  const seen = (key: string) => readLocal(key) !== null
  const dismiss = (key: string) => {
    writeLocal(key, '1')
    setDismissed((n) => n + 1)
  }

  // At most one transient card above the stakes card: the pause card, else the schedule notice.
  const request = space.pause
  const requestWeek = request ? weekFor(space, request.weekId, [weekDoc]) : null
  const pauseCard =
    request && requestWeek
      ? pauseCardView({ space, me, nowMs, view: pauseView(space, me, nowMs, requestWeek), week: requestWeek, thisWeek, name, when, seen })
      : null
  const note = space.scheduleNote
  const notice = pauseCard
    ? null
    : scheduleNotice({
        space,
        me,
        nowMs,
        thisWeek,
        fromWeekDeadline: note ? weekFor(space, note.fromWeek, [weekDoc]).deadlineAt : null,
        name,
        seen,
        hourCycle: deviceHourCycle(),
      })

  const openReview = () => sheet.present((close) => <ReviewSheet space={space} weekId={thisWeek} close={close} />, { 'aria-label': 'Review' })
  const openInvite = () => sheet.present((close) => <InviteSheet space={space} close={close} />)
  const openSettings = () => nav.push(<SpaceSettingsScreen spaceId={space.id} />, { title: 'Settings' })
  const openSchedule = () => nav.push(<ScheduleScreen spaceId={space.id} />, { title: 'Week Schedule' })
  const openMonthly = (monthId: MonthId) => nav.push(<MonthlyScreen spaceId={space.id} monthId={monthId} />, { title: `${monthName(monthId)} List` })

  const others = space.memberIds.filter((id) => id !== me)
  const memberLine = others.length === 0 ? 'Just you so far' : `You, ${listNames(others.map(name))}`

  return (
    <Screen
      title={space.name}
      subtitle={memberLine}
      trailing={
        <>
          <GlassButton icon="share" aria-label="Invite friends" onClick={openInvite} />
          <GlassButton icon="gear" aria-label="Space settings" onClick={openSettings} />
        </>
      }
      toolbar={
        tab === 'this' && parts.people.length > 0 ? (
          <Button size="large" fullWidth icon="checkmark" onClick={openReview}>
            {`Review ${compactNames(parts.people.map(name))}`}
          </Button>
        ) : tab === 'this' && parts.confirm ? (
          <Button size="large" fullWidth icon="lockOpen" onClick={openReview}>
            Unlock Results
          </Button>
        ) : undefined
      }
      toolbarFullWidth
    >
      {pauseCard && request ? (
        <PauseCard space={space} view={pauseCard} profiles={profiles} askerName={name(request.by)} onDismiss={dismiss} />
      ) : notice ? (
        <ScheduleNotice view={notice} onOpen={openSchedule} onDismiss={dismiss} />
      ) : null}
      <StakesCard space={space} profiles={profiles} me={me} nowMs={nowMs} onInvite={openInvite} thisWeek={weekDoc} monthly={monthly?.monthly ?? null} />
      <div className="s-tabs">
        <SegmentedControl<Tab>
          aria-label="View"
          options={[
            { value: 'this', label: 'This Week' },
            { value: 'next', label: 'Next Week' },
            { value: 'month', label: 'Month' },
          ]}
          value={tab}
          onChange={setPicked}
        />
      </div>
      {tab === 'this' && (
        <WeekView
          space={space}
          weekId={thisWeek}
          profiles={profiles}
          onReview={reviewDue ? openReview : undefined}
          onPlanNext={() => setPicked('next')}
          extra={<MonthlyCard space={space} monthId={thisMonth} profiles={profiles} />}
        />
      )}
      {tab === 'next' && (
        <WeekView
          space={space}
          weekId={nextWeek}
          profiles={profiles}
          // Next week starts a new month: that month's list can be planned now.
          extra={nextMonth !== thisMonth ? <MonthlyCard space={space} monthId={nextMonth} profiles={profiles} /> : undefined}
        />
      )}
      {tab === 'month' && (
        <MonthView
          space={space}
          profiles={profiles}
          initialMonth={initialMonth}
          onOpenWeek={(weekId) => nav.push(<WeekScreen spaceId={space.id} weekId={weekId} />, { title: formatWeekRange(weekId) })}
          onOpenMonthly={openMonthly}
        />
      )}
    </Screen>
  )
}

function InviteSheet({ space, close }: { space: Space; close: () => void }) {
  const left = 8 - space.memberIds.length
  return (
    <Screen
      title="Invite Friends"
      titleDisplay="inline"
      trailing={<GlassButton prominent icon="checkmark" aria-label="Done" onClick={close} />}
    >
      <div className="s-sheet-hero">
        <div className="s-sheet-hero__title">Bring friends into {space.name}</div>
        <div className="s-sheet-hero__text">{left > 0 ? `Room for ${left} more.` : 'This space is full: 8 people max.'}</div>
      </div>
      <InviteCard space={space} />
    </Screen>
  )
}
