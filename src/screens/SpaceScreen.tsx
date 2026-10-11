// One space: the stakes, who's in, and This Week / Next Week / Month. During the Friday window a
// floating button sends you into the review.
import { useState } from 'react'
import type { ReactNode } from 'react'
import { useAuth, useMonthStakes, useProfiles, useSpace, useWeek } from '../data/api.ts'
import { computeWeek, joinedAfterLock, membersAt, reviewTargets } from '../domain/scoring.ts'
import { addMonths, addWeeks, formatWeekRange, weekBounds, weekIdFor } from '../domain/time.ts'
import type { MonthId, Space, WeekId } from '../domain/types.ts'
import { AvatarStack, Button, EmptyState, GlassButton, Screen, Section, SegmentedControl, useNav, useSheet } from '../ui/index.ts'
import { Loading } from './components/Bits.tsx'
import { useNow } from './components/clock.ts'
import { monthName } from './components/format.ts'
import { InviteCard } from './components/InviteCard.tsx'
import { currentMonth } from './components/month.ts'
import { compactNames, firstName, listNames, nameOf, personOf } from './components/people.ts'
import type { Profiles } from './components/people.ts'
import { StakesList } from './components/Stakes.tsx'
import { stillIn } from './components/status.ts'
import { MonthView } from './MonthView.tsx'
import { ReviewSheet } from './ReviewSheet.tsx'
import { SpaceSettingsScreen } from './SpaceSettingsScreen.tsx'
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
  const thisWeek = weekIdFor(nowMs, space.timezone)
  const nextWeek = addWeeks(thisWeek, 1)

  const week = useWeek(space, thisWeek)
  const weekMembers = week.data?.week?.members ?? []
  const profiles = useProfiles([...space.memberIds, ...weekMembers])
  const result = week.data ? computeWeek(week.data, space, nowMs) : null
  const mine = result?.members[me]
  const bounds = week.data?.week ?? weekBounds(thisWeek, space.timezone)
  const counted = membersAt(space, bounds.deadlineAt)
  const reviewDue = result?.phase === 'review' && mine?.participating === true && !mine.hasSubmitted
  const targets = week.data && reviewDue ? reviewTargets(week.data, me, counted) : []
  // With nobody to review, confirming still unlocks the results early for friends in the week.
  const confirmDue = reviewDue && targets.length === 0 && !!result && stillIn(result, me, counted).length > 0
  // Sitting this week out (joined after the lock, or the week started without you): open on the
  // week you can still do something about.
  const sittingOut = nowMs >= bounds.lockAt && (joinedAfterLock(space, me, bounds.lockAt) || (!!result && !mine?.participating))
  const tab: Tab = picked ?? (sittingOut ? 'next' : 'this')

  const openReview = () =>
    sheet.present((close) => <ReviewSheet space={space} weekId={thisWeek} close={close} />, { 'aria-label': 'Friday review' })
  const openInvite = () => sheet.present((close) => <InviteSheet space={space} close={close} />)
  const openSettings = () => nav.push(<SpaceSettingsScreen spaceId={space.id} />, { title: 'Settings' })

  const others = space.memberIds.filter((id) => id !== me)
  const memberLine = others.length === 0 ? 'Just you so far' : `You, ${listNames(others.map((id) => firstName(nameOf(profiles, id))))}`

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
        tab === 'this' && targets.length > 0 ? (
          <Button size="large" fullWidth icon="checkmark" onClick={openReview}>
            {`Review ${compactNames(targets.map((id) => firstName(nameOf(profiles, id))))}`}
          </Button>
        ) : tab === 'this' && confirmDue ? (
          <Button size="large" fullWidth icon="lockOpen" onClick={openReview}>
            Unlock Results
          </Button>
        ) : undefined
      }
      toolbarFullWidth
    >
      <StakesCard space={space} profiles={profiles} me={me} nowMs={nowMs} onInvite={openInvite} />
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
        <WeekView space={space} weekId={thisWeek} profiles={profiles} onReview={targets.length > 0 || confirmDue ? openReview : undefined} onPlanNext={() => setPicked('next')} />
      )}
      {tab === 'next' && <WeekView space={space} weekId={nextWeek} profiles={profiles} />}
      {tab === 'month' && (
        <MonthView
          space={space}
          profiles={profiles}
          initialMonth={initialMonth}
          onOpenWeek={(weekId) => nav.push(<WeekScreen spaceId={space.id} weekId={weekId} />, { title: formatWeekRange(weekId) })}
        />
      )}
    </Screen>
  )
}

/** This month's stakes: frozen once its first lists locked, so an edit since then starts next month. */
function StakesCard({ space, profiles, me, nowMs, onInvite }: { space: Space; profiles: Profiles; me: string; nowMs: number; onInvite: () => void }) {
  const alone = space.memberIds.length < 2
  const month = currentMonth(space, nowMs)
  const stakes = useMonthStakes(space, month).data ?? space
  const changed = stakes.reward !== space.reward || stakes.penalty !== space.penalty
  return (
    <Section footer={changed ? `New stakes from ${monthName(addMonths(month, 1))}. See Settings.` : undefined}>
      <StakesList reward={stakes.reward} penalty={stakes.penalty} threshold={space.threshold} />
      {alone && (
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
