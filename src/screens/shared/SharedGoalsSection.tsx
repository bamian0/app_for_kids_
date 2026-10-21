// The Friends tab's Shared Goals section (SPEC §11.9.5): invitations first (Join / Decline), then your goals that
// are still going (those waiting for your check-in first) with their team bar and a Check In capsule, then New
// Shared Goal and Finished. It presents its own sheets and pushes on the Friends stack.
import { useCallback, useEffect, useState } from 'react'
import { declineSharedGoal, joinSharedGoal, useAuth, useCheckins, useProfiles, useSharedGoals } from '../../data/api.ts'
import { canCheckIn, goalWeek, openInvites } from '../../domain/shared.ts'
import type { SharedGoal, UID, UserProfile } from '../../domain/types.ts'
import { Button, Icon, Row, Section, haptic, useNav, useSheet, useToast } from '../../ui/index.ts'
import { useNow } from '../components/clock.ts'
import { nameOf } from '../components/people.ts'
import { CheckInSheet } from './CheckInSheet.tsx'
import { finishedGoals, inviteSubtitle, joinedToast, rowSubtitle, SECTION_FOOTER, sectionGoals } from './copy.ts'
import { FinishedGoalsScreen } from './FinishedGoalsScreen.tsx'
import { useNewSharedGoal } from './NewSharedGoalSheet.tsx'
import { OpenRow, errorText } from './parts.tsx'
import { SharedGoalScreen } from './SharedGoalScreen.tsx'
import { TeamBar } from './TeamBar.tsx'
import './shared.css'

export function SharedGoalsSection() {
  const nav = useNav()
  const { uid: me } = useAuth()
  const live = useSharedGoals()
  const nowMs = useNow()
  const newGoal = useNewSharedGoal()
  // Whether you checked in this week, per goal, as each row learns it (for "waiting for you first").
  const [checkedIn, setCheckedIn] = useState<Record<string, boolean>>({})
  const report = useCallback((goalId: string, done: boolean) => setCheckedIn((m) => (m[goalId] === done ? m : { ...m, [goalId]: done })), [])

  const view = live.data
  const invites = view ? openInvites(view, nowMs) : []
  const goals = view && me ? sectionGoals(view.goals, me, nowMs, checkedIn) : []
  const finished = view ? finishedGoals(view.goals, nowMs) : []
  const uids = [...invites, ...goals].flatMap((g) => [g.ownerId, ...Object.keys(g.totals)])
  const profiles = useProfiles(uids)
  const open = (goal: SharedGoal) => nav.push(<SharedGoalScreen goalId={goal.id} />, { title: goal.name })
  const empty = view !== undefined && invites.length === 0 && goals.length === 0 && finished.length === 0

  return (
    <Section header="Shared Goals" footer={empty ? SECTION_FOOTER : undefined}>
      {live.error && !view && <Row title="Can’t load shared goals" subtitle={live.error.message} className="sg-quiet-row" />}
      {invites.map((goal) => (
        <InviteRow key={goal.id} goal={goal} inviter={nameOf(profiles, goal.ownerId)} onOpen={() => open(goal)} />
      ))}
      {me &&
        goals.map((goal) => <GoalListRow key={goal.id} goal={goal} me={me} profiles={profiles} nowMs={nowMs} onKnown={report} onOpen={() => open(goal)} />)}
      <Row title="New Shared Goal" action leading={<Icon name="plus" size={20} weight={2.2} />} onPress={newGoal} />
      {finished.length > 0 && (
        <Row title="Finished" detail={String(finished.length)} chevron onPress={() => nav.push(<FinishedGoalsScreen />, { title: 'Finished' })} />
      )}
    </Section>
  )
}

function InviteRow({ goal, inviter, onOpen }: { goal: SharedGoal; inviter: string; onOpen: () => void }) {
  const toast = useToast()
  const [busy, setBusy] = useState<'join' | 'decline' | null>(null)
  const subtitle = inviteSubtitle(inviter, goal)

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
      toast({ title: 'Invitation declined', icon: 'xmark' })
    } catch (e) {
      toast({
        title: 'Couldn’t decline',
        message: errorText(e),
        tone: 'error',
      })
    } finally {
      setBusy(null)
    }
  }

  return (
    <OpenRow
      title={goal.name}
      subtitle={subtitle}
      label={`${goal.name}, ${subtitle}`}
      onOpen={onOpen}
      below={
        <span className="sg-actions">
          <Button size="small" loading={busy === 'join'} disabled={busy !== null} onClick={() => void join()}>
            Join
          </Button>
          <Button size="small" variant="gray" loading={busy === 'decline'} disabled={busy !== null} onClick={() => void decline()}>
            Decline
          </Button>
        </span>
      }
    />
  )
}

function GoalListRow({
  goal,
  me,
  profiles,
  nowMs,
  onKnown,
  onOpen,
}: {
  goal: SharedGoal
  me: UID
  profiles: Record<UID, UserProfile>
  nowMs: number
  onKnown: (goalId: string, done: boolean) => void
  onOpen: () => void
}) {
  const nav = useNav()
  const sheet = useSheet()
  const week = goalWeek(goal, nowMs)
  const checkins = useCheckins(goal.id, week)
  const done = checkins.data ? checkins.data.some((c) => c.uid === me && c.weekId === week) : undefined
  useEffect(() => {
    if (done !== undefined) onKnown(goal.id, done)
  }, [done, goal.id, onKnown])

  const wants = done === false && canCheckIn(goal, me, nowMs)
  const subtitle = rowSubtitle(goal, nowMs)
  const checkIn = () =>
    sheet.present((close) => <CheckInSheet goal={goal} close={close} onReached={() => nav.push(<SharedGoalScreen goalId={goal.id} />, { title: goal.name })} />)

  return (
    <OpenRow
      title={goal.name}
      middle={<TeamBar goal={goal} profiles={profiles} size="row" className="sg-row-bar" />}
      subtitle={subtitle}
      label={`${goal.name}, ${subtitle}`}
      onOpen={onOpen}
      chevron={!wants}
      trailing={
        wants ? (
          <Button size="small" onClick={checkIn}>
            Check In
          </Button>
        ) : undefined
      }
    />
  )
}
