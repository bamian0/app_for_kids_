// A shared goal (SPEC §11.9.5): the team's number and bar, your Check In, the reached moment, this week's check-ins,
// everyone's part and the details. Members see it all; an invitee sees the goal with Join / Decline; a finished or
// ended goal is read-only. Pushed from the Friends tab and by a check-in push (?goal=).
import { useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import {
  cancelSharedInvite,
  declineSharedGoal,
  finishSharedGoal,
  joinSharedGoal,
  leaveSharedGoal,
  useAuth,
  useCheckins,
  useProfiles,
  useSharedGoal,
} from '../../data/api.ts'
import { canCheckIn, goalShares, goalStatus, goalWeek, nextOwner, weekProgress } from '../../domain/shared.ts'
import type { SharedGoal, UID, UserProfile } from '../../domain/types.ts'
import {
  ActivityIndicator,
  Avatar,
  Button,
  EmptyState,
  GlassButton,
  Icon,
  Row,
  Screen,
  Section,
  haptic,
  useAlert,
  useNav,
  useSheet,
  useToast,
} from '../../ui/index.ts'
import { Loading } from '../components/Bits.tsx'
import { useNow } from '../components/clock.ts'
import { nameOf, personOf } from '../components/people.ts'
import { firstTime } from '../components/storage.ts'
import { CheckInSheet } from './CheckInSheet.tsx'
import {
  amountText,
  bigNumber,
  dayText,
  FORMER_MEMBER,
  finishConfirm,
  invitedYou,
  joinedToast,
  leaveConfirm,
  MOMENT_TITLE,
  momentOthers,
  momentText,
  monDay,
  ofTarget,
  shareSubtitle,
  statusLine,
  THIS_WEEK_FOOTER,
  thisWeekHeader,
  weeksFooter,
} from './copy.ts'
import { EditSharedGoalSheet } from './EditSharedGoalSheet.tsx'
import { InviteFriendsSheet } from './InviteFriendsSheet.tsx'
import { errorText, personOrFormer } from './parts.tsx'
import { TeamBar } from './TeamBar.tsx'
import './shared.css'

export function SharedGoalScreen({ goalId }: { goalId: string }) {
  const live = useSharedGoal(goalId)
  const { uid: me } = useAuth()
  const goal = live.data

  if (goal === undefined || goal === null || !me) {
    return (
      <Screen title={goal?.name ?? 'Shared Goal'} titleDisplay="inline">
        {goal === null ? (
          <EmptyState icon="target" title="Can’t open this goal" message="It’s only for its members and the people they invite." />
        ) : live.error ? (
          <EmptyState icon="info" title="Can’t load this goal" message={live.error.message} />
        ) : (
          <Loading />
        )}
      </Screen>
    )
  }
  return <GoalView goal={goal} me={me} />
}

function useGoalProfiles(goal: SharedGoal): Record<UID, UserProfile> {
  const uids = useMemo(
    () => [...new Set([goal.ownerId, ...goal.memberIds, ...goal.invited, ...Object.keys(goal.totals)])],
    [goal.ownerId, goal.memberIds, goal.invited, goal.totals],
  )
  return useProfiles(uids)
}

function GoalView({ goal, me }: { goal: SharedGoal; me: UID }) {
  const nav = useNav()
  const sheet = useSheet()
  const toast = useToast()
  const { confirm, actionSheet } = useAlert()
  const profiles = useGoalProfiles(goal)
  const nowMs = useNow()
  const [busy, setBusy] = useState(false)
  const status = goalStatus(goal, nowMs)
  const member = goal.memberIds.includes(me)
  const owner = member && goal.ownerId === me
  const open = status !== 'finished' && status !== 'ended'

  const editGoal = (keepGoing = false) => sheet.present((close) => <EditSharedGoalSheet goal={goal} close={close} keepGoing={keepGoing} />)
  const inviteFriends = () => sheet.present((close) => <InviteFriendsSheet goal={goal} close={close} />)

  const finish = async () => {
    const copy = finishConfirm(goal.name)
    if (!(await confirm({ ...copy, destructive: true }))) return
    setBusy(true)
    try {
      await finishSharedGoal(goal.id)
      toast({ title: 'Goal finished', icon: 'checkmark' })
    } catch (e) {
      toast({
        title: 'Couldn’t finish the goal',
        message: errorText(e),
        tone: 'error',
      })
    } finally {
      setBusy(false)
    }
  }

  const leave = async () => {
    const next = goal.ownerId === me ? nextOwner(goal, me) : null
    const copy = leaveConfirm(goal, me, next ? nameOf(profiles, next) : null)
    if (!(await confirm({ ...copy, destructive: true }))) return
    setBusy(true)
    try {
      await leaveSharedGoal(goal.id)
      nav.pop()
      toast({ title: `You left ${goal.name}`, icon: 'signOut' })
    } catch (e) {
      setBusy(false)
      toast({
        title: 'Couldn’t leave the goal',
        message: errorText(e),
        tone: 'error',
      })
    }
  }

  const menu = async () => {
    const actions: { label: string; style?: 'destructive' }[] = []
    if (owner && open) actions.push({ label: 'Invite Friends' })
    if (owner && status !== 'finished') actions.push({ label: 'Edit Goal' }, { label: 'Finish Goal', style: 'destructive' })
    actions.push({ label: 'Leave Goal', style: 'destructive' })
    const choice = await actionSheet({ actions })
    if (choice === 'Invite Friends') inviteFriends()
    if (choice === 'Edit Goal') editGoal()
    if (choice === 'Finish Goal') void finish()
    if (choice === 'Leave Goal') void leave()
  }

  const trailing = !member ? undefined : busy ? (
    <span className="s-bar-spinner">
      <ActivityIndicator color="var(--secondary-label)" label="Saving" />
    </span>
  ) : (
    <GlassButton icon="ellipsis" aria-label="Goal options" onClick={() => void menu()} />
  )

  return (
    <Screen title={goal.name} titleDisplay="inline" trailing={trailing}>
      {member ? (
        <MemberView goal={goal} me={me} profiles={profiles} owner={owner} onKeepGoing={() => editGoal(true)} onFinish={() => void finish()} />
      ) : (
        <InviteeView goal={goal} me={me} profiles={profiles} />
      )}
      <PartsSection goal={goal} profiles={profiles} owner={owner && open} />
      <DetailsSection goal={goal} profiles={profiles} />
    </Screen>
  )
}

// ---------- Hero ----------

function Hero({ goal, profiles, sweep, action }: { goal: SharedGoal; profiles: Record<UID, UserProfile>; sweep?: unknown; action?: ReactNode }) {
  const nowMs = useNow()
  return (
    <div className="sg-hero">
      <div className="sg-hero__numbers">
        <span className="sg-hero__value t-tabular">{bigNumber(goal)}</span>
        <span className="sg-hero__of t-tabular">{ofTarget(goal)}</span>
      </div>
      <TeamBar goal={goal} profiles={profiles} size="hero" sweep={sweep} />
      <div className="sg-hero__status t-tabular">{statusLine(goal, nowMs)}</div>
      {action && <div className="sg-hero__action">{action}</div>}
    </div>
  )
}

// ---------- Members ----------

function MemberView({
  goal,
  me,
  profiles,
  owner,
  onKeepGoing,
  onFinish,
}: {
  goal: SharedGoal
  me: UID
  profiles: Record<UID, UserProfile>
  owner: boolean
  onKeepGoing: () => void
  onFinish: () => void
}) {
  const sheet = useSheet()
  const nowMs = useNow()
  const week = goalWeek(goal, nowMs)
  const checkins = useCheckins(goal.id, week)
  const status = goalStatus(goal, nowMs)
  const open = status !== 'finished' && status !== 'ended'
  const can = canCheckIn(goal, me, nowMs)
  const mine = (checkins.data ?? []).some((c) => c.uid === me && c.weekId === week)

  // The moment: the first time this device sees the goal reached, the bar sweeps and the phone taps once.
  const [sweep, setSweep] = useState<string | undefined>()
  useEffect(() => {
    if (goal.reachedAt === null || goal.archivedAt !== null) return
    const key = `sharedReached.${goal.id}.${goal.reachedAt}`
    if (firstTime(key)) {
      setSweep(key)
      haptic()
    }
  }, [goal.id, goal.reachedAt, goal.archivedAt])

  const checkIn = () => sheet.present((close) => <CheckInSheet goal={goal} close={close} />)
  const action = can ? (
    <Button size="large" fullWidth onClick={checkIn} disabled={checkins.data === undefined}>
      {mine ? 'Edit Check-In' : 'Check In'}
    </Button>
  ) : undefined

  const ownerName = profiles[goal.ownerId] ? nameOf(profiles, goal.ownerId) : null

  return (
    <>
      <Hero goal={goal} profiles={profiles} sweep={sweep} action={action} />

      {status === 'reached' && (
        <section className="sg-moment" aria-label={MOMENT_TITLE}>
          <span className="sg-moment__icon" aria-hidden>
            <Icon name="sparkles" size={24} weight={1.8} />
          </span>
          <div className="sg-moment__title">{MOMENT_TITLE}</div>
          <div className="sg-moment__text">{momentText(goal)}</div>
          {owner ? (
            <div className="sg-moment__actions">
              <Button onClick={onKeepGoing}>Keep Going</Button>
              <Button variant="gray" onClick={onFinish}>
                Finish Goal
              </Button>
            </div>
          ) : (
            <div className="sg-moment__note">{momentOthers(ownerName)}</div>
          )}
        </section>
      )}

      {open && <ThisWeek goal={goal} me={me} profiles={profiles} week={week} checkins={checkins.data} />}
    </>
  )
}

function ThisWeek({
  goal,
  me,
  profiles,
  week,
  checkins,
}: {
  goal: SharedGoal
  me: UID
  profiles: Record<UID, UserProfile>
  week: string
  checkins: ReturnType<typeof useCheckins>['data']
}) {
  const progress = weekProgress(goal, checkins ?? [], week)
  // You first, then everyone else in the order they joined.
  const rows = [...progress.rows].sort((a, b) => (a.uid === me ? -1 : b.uid === me ? 1 : 0))
  return (
    <Section header={thisWeekHeader(week)} footer={THIS_WEEK_FOOTER}>
      {rows.map(({ uid, checkin }) => {
        const person = personOf(profiles, uid)
        return (
          <Row
            key={uid}
            leading={<Avatar name={person.name} color={person.color} photo={person.photo} size={32} />}
            title={person.name}
            subtitle={checkin?.note ? `“${checkin.note}”` : undefined}
            detail={
              checkins === undefined ? undefined : checkin ? <span className="sg-amount-detail">{amountText(checkin.amount, goal.unit)}</span> : 'Not yet'
            }
          />
        )
      })}
    </Section>
  )
}

// ---------- Invitees ----------

function InviteeView({ goal, me, profiles }: { goal: SharedGoal; me: UID; profiles: Record<UID, UserProfile> }) {
  const nav = useNav()
  const toast = useToast()
  const nowMs = useNow()
  const [busy, setBusy] = useState<'join' | 'decline' | null>(null)
  const status = goalStatus(goal, nowMs)
  const invited = goal.invited.includes(me)
  const canJoin = status !== 'finished' && status !== 'ended'

  const join = async () => {
    setBusy('join')
    try {
      await joinSharedGoal(goal.id)
      const copy = joinedToast(goal.name)
      haptic()
      toast({
        title: copy.title,
        message: copy.message,
        icon: 'checkmark',
        tone: 'success',
      })
    } catch (e) {
      toast({ title: 'Couldn’t join', message: errorText(e), tone: 'error' })
    } finally {
      setBusy(null)
    }
  }

  const decline = async () => {
    setBusy('decline')
    try {
      await declineSharedGoal(goal.id)
      nav.pop()
      toast({ title: 'Invitation declined', icon: 'xmark' })
    } catch (e) {
      setBusy(null)
      toast({
        title: 'Couldn’t decline',
        message: errorText(e),
        tone: 'error',
      })
    }
  }

  return (
    <>
      <Hero goal={goal} profiles={profiles} />
      {invited && (
        <section className="sg-invite">
          <div className="sg-invite__text">{invitedYou(nameOf(profiles, goal.ownerId))}</div>
          <div className="sg-invite__actions">
            {canJoin && (
              <Button loading={busy === 'join'} disabled={busy !== null} onClick={() => void join()}>
                Join
              </Button>
            )}
            <Button variant="gray" loading={busy === 'decline'} disabled={busy !== null} onClick={() => void decline()}>
              Decline
            </Button>
          </div>
        </section>
      )}
    </>
  )
}

// ---------- Everyone's part and details ----------

function PartsSection({ goal, profiles, owner }: { goal: SharedGoal; profiles: Record<UID, UserProfile>; owner: boolean }) {
  const toast = useToast()
  const { actionSheet } = useAlert()
  const shares = goalShares(goal)
  const invited = goal.invited
  if (shares.length === 0 && invited.length === 0) return null

  const cancelInvite = async (uid: UID) => {
    const choice = await actionSheet({
      actions: [{ label: 'Cancel Invite', style: 'destructive' }],
    })
    if (choice !== 'Cancel Invite') return
    try {
      await cancelSharedInvite(goal.id, uid)
    } catch (e) {
      toast({
        title: 'Couldn’t cancel the invite',
        message: errorText(e),
        tone: 'error',
      })
    }
  }

  return (
    <Section header="Everyone’s part">
      {shares.map((s) => {
        const person = personOrFormer(profiles, s.uid, s.former, FORMER_MEMBER)
        return (
          <Row
            key={s.uid}
            leading={<Avatar name={person.name} color={s.former && !profiles[s.uid] ? 'var(--system-gray2)' : person.color} photo={person.photo} size={32} />}
            title={person.name}
            subtitle={shareSubtitle(s.amount, goal.total, s.former)}
            detail={<span className="sg-amount-detail">{amountText(s.amount, goal.unit)}</span>}
          />
        )
      })}
      {invited.map((uid) => {
        const person = personOf(profiles, uid)
        return (
          <Row
            key={uid}
            leading={<Avatar name={person.name} color={person.color} photo={person.photo} size={32} />}
            title={person.name}
            detail="Invited"
            onPress={owner ? () => void cancelInvite(uid) : undefined}
            aria-label={owner ? `${person.name}, Invited` : undefined}
            className="sg-invited"
          />
        )
      })}
    </Section>
  )
}

function DetailsSection({ goal, profiles }: { goal: SharedGoal; profiles: Record<UID, UserProfile> }) {
  const nowMs = useNow()
  return (
    <Section header="Details" footer={weeksFooter(goal.timezone)}>
      <Row title="Started" detail={monDay(goal.createdAt, nowMs)} />
      <Row title="Ends" detail={goal.endsOn ? dayText(goal.endsOn, nowMs) : 'No end date'} />
      <Row title="Owner" detail={profiles[goal.ownerId] ? nameOf(profiles, goal.ownerId) : ''} />
    </Section>
  )
}
