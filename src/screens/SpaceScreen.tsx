// One space: the stakes, who's in, and This Week / Next Week / Month. During the Friday window a
// floating button sends you into the review.
import { useState } from 'react'
import type { ReactNode } from 'react'
import { useAuth, useProfiles, useSpace, useWeek } from '../data/api.ts'
import { computeWeek, reviewTargets } from '../domain/scoring.ts'
import { addWeeks, formatWeekRange, weekIdFor } from '../domain/time.ts'
import type { Space, WeekId } from '../domain/types.ts'
import { AvatarStack, Button, EmptyState, GlassButton, Icon, Screen, Section, SegmentedControl, useNav, useSheet } from '../ui/index.ts'
import { Loading } from './components/Bits.tsx'
import { useNow } from './components/clock.ts'
import { InviteCard } from './components/InviteCard.tsx'
import { compactNames, firstName, listNames, nameOf, personOf } from './components/people.ts'
import type { Profiles } from './components/people.ts'
import { MonthView } from './MonthView.tsx'
import { ReviewSheet } from './ReviewSheet.tsx'
import { SpaceSettingsScreen } from './SpaceSettingsScreen.tsx'
import { WeekView } from './WeekView.tsx'

type Tab = 'this' | 'next' | 'month'

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

export function SpaceScreen({ spaceId }: { spaceId: string }) {
  return <SpaceGate spaceId={spaceId} render={(space) => <SpaceContent space={space} />} />
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
  const profiles = useProfiles(space.memberIds)
  return <WeekView space={space} weekId={weekId} profiles={profiles} />
}

function SpaceContent({ space }: { space: Space }) {
  const nav = useNav()
  const sheet = useSheet()
  const { uid } = useAuth()
  const me = uid ?? ''
  const nowMs = useNow()
  const [picked, setPicked] = useState<Tab | null>(null)
  const thisWeek = weekIdFor(nowMs, space.timezone)
  const nextWeek = addWeeks(thisWeek, 1)

  // Opening a space opens its current week: before the lock that makes you a participant.
  const week = useWeek(space, thisWeek)
  const weekMembers = week.data?.week?.members ?? []
  const profiles = useProfiles([...space.memberIds, ...weekMembers])
  const result = week.data ? computeWeek(week.data, space, nowMs) : null
  const mine = result?.members[me]
  const reviewDue = result?.phase === 'review' && mine?.participating === true && !mine.hasSubmitted
  const targets = week.data && reviewDue ? reviewTargets(week.data, me) : []
  // On a weekend after a week you sat out, open on the week you can still do something about.
  const tab: Tab = picked ?? (result?.phase === 'closed' && !mine?.participating ? 'next' : 'this')

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
        tab === 'this' && reviewDue ? (
          <Button size="large" fullWidth icon="checkmark" onClick={openReview}>
            {targets.length > 0 ? `Review ${compactNames(targets.map((id) => firstName(nameOf(profiles, id))))}` : 'Finish Review'}
          </Button>
        ) : undefined
      }
      toolbarFullWidth
    >
      <StakesCard space={space} profiles={profiles} me={me} onInvite={openInvite} />
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
      {tab === 'this' && <WeekView space={space} weekId={thisWeek} profiles={profiles} onReview={reviewDue ? openReview : undefined} />}
      {tab === 'next' && <WeekView space={space} weekId={nextWeek} profiles={profiles} />}
      {tab === 'month' && (
        <MonthView space={space} profiles={profiles} onOpenWeek={(weekId) => nav.push(<WeekScreen spaceId={space.id} weekId={weekId} />, { title: formatWeekRange(weekId) })} />
      )}
    </Screen>
  )
}

function StakesCard({ space, profiles, me, onInvite }: { space: Space; profiles: Profiles; me: string; onInvite: () => void }) {
  const alone = space.memberIds.length < 2
  return (
    <Section>
      <div className="s-stakes">
        <div className="s-stakes__item">
          <span className="s-stakes__icon s-stakes__icon--win" aria-hidden>
            <Icon name="trophy" size={18} weight={2} />
          </span>
          <span className="s-stakes__text">
            <span className="s-stakes__label">Hit {space.threshold}%, they owe you</span>
            <span className="s-stakes__value">{space.reward}</span>
          </span>
        </div>
        <div className="s-stakes__item">
          <span className="s-stakes__icon" aria-hidden>
            <Icon name="flame" size={18} weight={2} />
          </span>
          <span className="s-stakes__text">
            <span className="s-stakes__label">Miss, you owe them</span>
            <span className="s-stakes__value">{space.penalty}</span>
          </span>
        </div>
      </div>
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
      trailing={
        <GlassButton prominent onClick={close}>
          Done
        </GlassButton>
      }
    >
      <div className="s-sheet-hero">
        <div className="s-sheet-hero__title">Bring friends into {space.name}</div>
        <div className="s-sheet-hero__text">{left > 0 ? `Room for ${left} more.` : 'This space is full: 8 people max.'}</div>
      </div>
      <InviteCard space={space} />
    </Screen>
  )
}
