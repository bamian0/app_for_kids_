// Space settings: the name, the house stakes (the owner's; what new deals start from) and the way to deals and
// stakes, your role, members, the invite, the week's times and the rules, pausing a week, and leaving. Leaving,
// removing someone and turning on Only Rate Friends say what it does to a deal that's on (SPEC §12.10).
import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import {
  askToPause,
  leaveSpace,
  removeMember,
  resetInviteCode,
  setJudge,
  updateSpace,
  useAuth,
  useDeals,
  useDealsFrom,
  useMonthData,
  useMonthly,
  useProfiles,
  useSpace,
  useWeek,
  withdrawPause,
} from '../data/api.ts'
import { formatInviteCode } from '../domain/ids.ts'
import { isWeekPaused, pauseChoices, pauseView } from '../domain/pause.ts'
import { boundsFor, firstUnlockedWeek } from '../domain/schedule.ts'
import { judgesOf, spaceJudges } from '../domain/scoring.ts'
import { oldStakesMonth } from '../domain/stakes.ts'
import { addWeeks, monthIdForWeek, weekIdFor } from '../domain/time.ts'
import type { Deal, MonthlyData, Space, UID, WeekData, WeekId } from '../domain/types.ts'
import { Avatar, EmptyState, GlassButton, Row, Screen, Section, TextArea, TextFieldRow, useAlert, useNav, useToast } from '../ui/index.ts'
import { Loading } from './components/Bits.tsx'
import { useNow } from './components/clock.ts'
import { InviteCard } from './components/InviteCard.tsx'
import { firstName, nameOf, personOf } from './components/people.ts'
import { StakesList } from './components/Stakes.tsx'
import { cityOf, deadlineText, deviceHourCycle } from './components/zone.ts'
import { HelpScreen } from './help/HelpSheet.tsx'
import { ScheduleScreen } from './space/ScheduleScreen.tsx'
import {
  HOUSE_SAVED,
  PAUSE_FOOTER,
  houseFooter,
  judgeConfirm,
  memberSubtitle,
  pauseAskedToast,
  pauseRow,
  pauseSheet,
  playConfirm,
  roleFooter,
  scheduleFooter,
  scheduleSummary,
  weekFor,
} from './space/space.ts'
import { dealNamer, dealNow, judgeDealLine, leaveDealLine, removeDealLine } from './stakes/deals.ts'
import { StakesScreen } from './stakes/StakesScreen.tsx'

export function SpaceSettingsScreen({ spaceId }: { spaceId: string }) {
  const live = useSpace(spaceId)
  if (!live.data) {
    return (
      <Screen title="Settings" titleDisplay="inline">
        {live.data === null ? <EmptyState icon="person2" title="You’re not in this space" /> : <Loading />}
      </Screen>
    )
  }
  return <SettingsContent space={live.data} />
}

/** A confirm's message with what it does to a deal on its own line, so it isn't lost in the rest. */
function withLine(message: string, line: string | null): ReactNode {
  if (!line) return message
  return (
    <>
      {message}
      <span style={{ display: 'block', marginTop: 8 }}>{line}</span>
    </>
  )
}

const joinedFormat = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
const failed = (e: unknown) => (e instanceof Error ? e.message : undefined)

function SettingsContent({ space }: { space: Space }) {
  const nav = useNav()
  const toast = useToast()
  const { confirm, actionSheet } = useAlert()
  const { uid } = useAuth()
  const me = uid ?? ''
  const nowMs = useNow()
  const profiles = useProfiles(space.memberIds)
  const isOwner = me === space.ownerId
  const name = (id: UID) => firstName(nameOf(profiles, id))
  const when = (ms: number) => deadlineText(ms, space.timezone, nowMs)
  const city = cityOf(space.timezone)

  // This week and next (pausing, your role), and this month's list (when this month's terms end).
  const thisWeek = weekIdFor(nowMs, space.timezone)
  const nextWeek = addWeeks(thisWeek, 1)
  const thisData = useWeek(space, thisWeek).data
  const nextData = useWeek(space, nextWeek).data
  const thisDoc = thisData?.week ?? null
  const nextDoc = nextData?.week ?? null
  const monthly = useMonthly(space, monthIdForWeek(thisWeek)).data
  const dealsFrom = useDealsFrom()
  // The October window (SPEC §12.3): October's house stakes are set; the owner sees them read-only.
  const oldMonth = oldStakesMonth(space, nowMs, thisDoc, monthly?.monthly ?? null, dealsFrom)
  const editHouse = isOwner && !oldMonth
  // Deals that are on: leaving or a removal counts as a miss for them.
  const deals = useDeals(space).data
  const dealName = dealNamer(profiles, space.memberIds)
  const dealOf = (id: UID): { deal: Deal | undefined; state: ReturnType<typeof dealNow> | null } => {
    const deal = deals?.open[id]
    return { deal, state: deal ? dealNow(deal, space, nowMs, [thisDoc, nextDoc]) : null }
  }

  const [name_, setName] = useState(space.name)
  const [reward, setReward] = useState(space.reward)
  const [penalty, setPenalty] = useState(space.penalty)
  const [saving, setSaving] = useState(false)
  const stakesDirty = editHouse && (reward !== space.reward || penalty !== space.penalty)
  const dirty = name_ !== space.name || stakesDirty
  const valid = name_.trim() !== '' && (!editHouse || (reward.trim() !== '' && penalty.trim() !== ''))

  // A friend's edit shows up live unless you're changing things yourself.
  useEffect(() => {
    if (dirty) return
    setName(space.name)
    setReward(space.reward)
    setPenalty(space.penalty)
    // Only the server values should trigger this.
  }, [space.name, space.reward, space.penalty])

  const save = async () => {
    if (!valid || saving) return
    setSaving(true)
    const stakesChanged = editHouse && (reward.trim() !== space.reward || penalty.trim() !== space.penalty)
    try {
      // Only the owner changes the house stakes (not in the October window); everyone can rename.
      await updateSpace(space.id, editHouse ? { name: name_.trim(), reward: reward.trim(), penalty: penalty.trim() } : { name: name_.trim() })
      setName(name_.trim())
      setReward(reward.trim())
      setPenalty(penalty.trim())
      toast({ title: 'Saved', message: stakesChanged ? HOUSE_SAVED : undefined, tone: 'success' })
    } catch (e) {
      toast({ title: 'Couldn’t save', message: failed(e), tone: 'error' })
    } finally {
      setSaving(false)
    }
  }

  // When the owner leaves, the member who joined first takes over.
  const heir = space.memberIds.filter((id) => id !== uid).sort((a, b) => (space.joinedAt[a] ?? Infinity) - (space.joinedAt[b] ?? Infinity))[0]

  const leave = async () => {
    const last = space.memberIds.length === 1
    const mine = dealOf(me)
    const dealLine = leaveDealLine(mine.deal, mine.state, dealName)
    const ok = await confirm({
      title: `Leave “${space.name}”?`,
      message: last
        ? 'You’re the last one here. The space and its invite code will be gone.'
        : withLine(`Your past weeks stay in your friends’ history. To come back, you’ll need the code.${isOwner && heir ? ` ${firstName(nameOf(profiles, heir))} becomes the owner.` : ''}`, dealLine),
      confirmLabel: 'Leave',
      destructive: true,
    })
    if (!ok) return
    nav.popToRoot()
    try {
      await leaveSpace(space.id)
      toast({ title: `You left ${space.name}` })
    } catch (e) {
      toast({ title: 'Couldn’t leave', message: failed(e), tone: 'error' })
    }
  }

  const remove = async (id: UID) => {
    const who = firstName(nameOf(profiles, id))
    const theirs = dealOf(id)
    const dealLine = removeDealLine(theirs.deal, theirs.state, dealName)
    const choice = await actionSheet({
      title: `Remove ${who} from ${space.name}?`,
      message: withLine(`${who} loses access right away and leaves this week’s reviews. Weeks already played stay in the history. To come back, they’d need the code.`, dealLine),
      actions: [{ label: 'Remove from Space', style: 'destructive' }],
    })
    if (choice !== 'Remove from Space') return
    try {
      await removeMember(space.id, id)
      toast({ title: `${who} was removed` })
    } catch (e) {
      toast({ title: 'Couldn’t remove', message: failed(e), tone: 'error' })
    }
  }

  const resetCode = async () => {
    const ok = await confirm({
      title: 'Reset the invite code?',
      message: `${formatInviteCode(space.inviteCode)} and every invite link sent so far stop working right away. Everyone already in stays in.`,
      confirmLabel: 'Reset',
      destructive: true,
    })
    if (!ok) return
    try {
      const code = await resetInviteCode(space.id)
      toast({ title: 'New invite code', message: formatInviteCode(code), icon: 'link' })
    } catch (e) {
      toast({ title: 'Couldn’t reset the code', message: failed(e), tone: 'error' })
    }
  }

  // ----- Pausing a week -----
  const thisW = weekFor(space, thisWeek, [thisDoc])
  const nextW = weekFor(space, nextWeek, [nextDoc])
  const choices = pauseChoices(space, me, nowMs, { thisWeek: { id: thisWeek, reviewOpenAt: thisW.reviewOpenAt }, nextWeek: { id: nextWeek, reviewOpenAt: nextW.reviewOpenAt } })
  const requestWeek = space.pause ? weekFor(space, space.pause.weekId, [thisDoc, nextDoc]) : null
  const view = requestWeek ? pauseView(space, me, nowMs, requestWeek) : ({ kind: 'none' } as const)
  const pause = pauseRow(view, me, choices, { thisWeek, nextWeek })

  const askPause = async () => {
    const spec = pauseSheet(space.name, choices, { thisWeek: thisW.reviewOpenAt, nextWeek: nextW.reviewOpenAt }, when)
    const choice = await actionSheet({ title: spec.title, message: spec.message, actions: spec.actions.map((label) => ({ label })) })
    if (!choice) return
    const weekId = choice === 'Pause This Week' ? thisWeek : nextWeek
    try {
      const outcome = await askToPause(space, weekId)
      toast({ ...pauseAskedToast(outcome, weekId, thisWeek), icon: 'pause', tone: 'success' })
    } catch (e) {
      toast({ title: 'Couldn’t ask', message: failed(e), tone: 'error' })
    }
  }

  const cancelPause = async () => {
    const ok = await confirm({ title: 'Cancel the request?', confirmLabel: 'Cancel Request', cancelLabel: 'Keep It', destructive: true })
    if (!ok) return
    try {
      await withdrawPause(space)
    } catch (e) {
      toast({ title: 'Couldn’t cancel', message: failed(e), tone: 'error' })
    }
  }

  const members = [...space.memberIds].sort((a, b) => (space.joinedAt[a] ?? 0) - (space.joinedAt[b] ?? 0))
  const judges = spaceJudges(space)

  return (
    <Screen
      title="Settings"
      titleDisplay="inline"
      trailing={
        dirty ? (
          <GlassButton prominent onClick={save} disabled={!valid || saving}>
            Save
          </GlassButton>
        ) : undefined
      }
    >
      <Section header="Name">
        <TextFieldRow value={name_} onChange={setName} placeholder="Space name" maxLength={40} aria-label="Space name" autoCapitalize="words" />
      </Section>

      {editHouse ? (
        <>
          <Section header={`House stakes: if you hit ${space.threshold}%, they owe you…`}>
            <TextArea value={reward} onChange={setReward} placeholder="Dinner, on them" maxLength={120} minRows={1} maxRows={4} aria-label="Reward" />
          </Section>
          <Section header="If you miss, you owe them…" footer={houseFooter(true, name(space.ownerId), null)}>
            <TextArea value={penalty} onChange={setPenalty} placeholder="Coffee for everyone, for a week" maxLength={120} minRows={1} maxRows={4} aria-label="Penalty" />
          </Section>
          <Section>
            <DealsRow spaceId={space.id} />
          </Section>
        </>
      ) : (
        <Section header="House stakes" footer={houseFooter(isOwner, name(space.ownerId), oldMonth)}>
          <StakesList reward={space.reward} penalty={space.penalty} threshold={space.threshold} />
          <DealsRow spaceId={space.id} />
        </Section>
      )}

      <RoleSection space={space} me={me} nowMs={nowMs} thisData={thisData} nextData={nextData} when={when} dealLine={judgeDealLine(dealOf(me).deal, dealOf(me).state)} />

      <Section header={`Members · ${space.memberIds.length} of 8`} footer={isOwner && space.memberIds.length > 1 ? 'You’re the owner: tap someone to remove them.' : undefined}>
        {members.map((id) => {
          const person = personOf(profiles, id)
          const joined = space.joinedAt[id]
          return (
            <Row
              key={id}
              leading={<Avatar name={person.name} color={person.color} photo={person.photo} size={32} />}
              title={id === uid ? `${person.name} (You)` : person.name}
              subtitle={memberSubtitle(id === space.ownerId, judges.includes(id), joined ? joinedFormat.format(joined) : null)}
              onPress={isOwner && id !== uid ? () => void remove(id) : undefined}
            />
          )
        })}
      </Section>

      <InviteCard space={space} />
      {isOwner && (
        <Section footer="Code out in the wild? A new one locks out the old code and every link sent so far.">
          <Row title="Reset Invite Code" action onPress={() => void resetCode()} />
        </Section>
      )}

      <Section footer={scheduleFooter(space.schedule, city, deviceHourCycle())}>
        <Row icon="calendar" title="Week Schedule" detail={scheduleSummary(space.schedule)} chevron onPress={() => nav.push(<ScheduleScreen spaceId={space.id} />, { title: 'Week Schedule' })} />
        <Row
          icon="info"
          title="How Stakes Works"
          chevron
          onPress={() => nav.push(<HelpScreen timezone={city} schedule={space.schedule} judge={judges.includes(me)} />, { title: 'How Stakes Works' })}
        />
        <Row icon="clock" title="Time Zone" detail={city} />
      </Section>

      <Section footer={PAUSE_FOOTER}>
        {pause.enabled ? (
          <Row icon="pause" title="Pause a Week" chevron onPress={() => void askPause()} />
        ) : (
          <Row
            icon="pause"
            iconBackground="var(--system-gray3)"
            title={pause.detail ? pause.title : <span className="c-tertiary">{pause.title}</span>}
            detail={pause.detail}
            subtitle={pause.subtitle}
          />
        )}
        {pause.canCancel && <Row title="Cancel Request" destructive onPress={() => void cancelPause()} />}
      </Section>

      <Section>
        <Row title="Leave Space" destructive onPress={leave} />
      </Section>
    </Screen>
  )
}

function DealsRow({ spaceId }: { spaceId: string }) {
  const nav = useNav()
  return <Row icon="handshake" title="Deals and Stakes" chevron onPress={() => nav.push(<StakesScreen spaceId={spaceId} />, { title: 'Stakes' })} />
}

interface RoleProps {
  space: Space
  me: UID
  nowMs: number
  thisData: WeekData | undefined
  nextData: WeekData | undefined
  when: (ms: number) => string
  /** With a deal on: what judging does to it (judgeDealLine). */
  dealLine: string | null
}

/** Only Rate Friends (SPEC §9.4): your choice, from the next week and monthly list that haven't locked. */
function RoleSection({ space, me, nowMs, thisData, nextData, when, dealLine }: RoleProps) {
  const toast = useToast()
  const { confirm } = useAlert()
  const judging = spaceJudges(space).includes(me)
  // The switch moves at once; the space doc catches up a moment later (or the change fails and it moves back).
  const [pending, setPending] = useState<boolean | null>(null)
  useEffect(() => {
    if (pending !== null && judging === pending) setPending(null)
  }, [judging, pending])

  const thisWeek = weekIdFor(nowMs, space.timezone)
  const thisDoc = thisData?.week ?? null
  const fromWeek = firstUnlockedWeek(space, thisDoc, nowMs)
  const fromData = fromWeek === thisWeek ? thisData : nextData
  const month = monthIdForWeek(fromWeek)
  const list = useMonthly(space, month).data
  const weeks = useMonthData(space, month).data?.weeks ?? []

  // This week's snapshot, once it has locked: your role there no longer follows the switch.
  const thisRole = thisDoc && nowMs >= thisDoc.lockAt && thisDoc.members.includes(me) ? (judgesOf(thisDoc).includes(me) ? 'judge' : 'player') : null

  const toggle = async (next: boolean) => {
    if (pending !== null) return
    const message = next ? judgeMessage(space, me, nowMs, fromWeek, thisWeek, fromData, list, weeks) : playMessage(space, me, nowMs, fromWeek, thisWeek, fromData, weeks, when)
    const ok = await confirm({ title: message.title, message: withLine(message.message, next ? dealLine : null), confirmLabel: message.confirmLabel })
    if (!ok) return
    setPending(next)
    try {
      await setJudge(space.id, next)
    } catch (e) {
      setPending(null)
      toast({ title: 'Couldn’t change your role', message: failed(e), tone: 'error' })
    }
  }

  const on = pending ?? judging
  return (
    <Section header="Your role" footer={roleFooter(on, thisRole, addWeeks(thisWeek, 1))}>
      <Row title="Only Rate Friends" toggle={on} onToggle={(v) => void toggle(v)} />
    </Section>
  )
}

/** Weeks of the month before `fromWeek` that locked with you in them, as a player or as a judge (not paused). */
function lockedRoles(space: Space, me: UID, nowMs: number, fromWeek: WeekId, weeks: WeekData[]): { played: boolean; judged: boolean } {
  let played = false
  let judged = false
  for (const w of weeks) {
    const doc = w.week
    if (!doc || w.weekId >= fromWeek || nowMs < doc.lockAt || !doc.members.includes(me) || isWeekPaused(space, w.weekId)) continue
    if (judgesOf(doc).includes(me)) judged = true
    else played = true
  }
  return { played, judged }
}

/** Your month's list as a player, with tasks on it: still open, or locked (it counts either way once locked). */
function myListState(list: MonthlyData | undefined, me: UID, nowMs: number): 'unlocked' | 'locked' | null {
  const doc = list?.monthly
  if (!list || !doc || !doc.members.includes(me) || judgesOf(doc).includes(me) || (list.plans[me]?.tasks.length ?? 0) === 0) return null
  return nowMs < doc.lockAt ? 'unlocked' : 'locked'
}

function judgeMessage(space: Space, me: UID, nowMs: number, fromWeek: WeekId, thisWeek: WeekId, fromData: WeekData | undefined, list: MonthlyData | undefined, weeks: WeekData[]) {
  const listState = myListState(list, me, nowMs)
  return judgeConfirm({
    fromWeek,
    thisWeek,
    plannedTasks: (fromData?.plans[me]?.tasks.length ?? 0) > 0,
    monthlyList: listState,
    played: lockedRoles(space, me, nowMs, fromWeek, weeks).played || listState === 'locked',
  })
}

function playMessage(space: Space, me: UID, nowMs: number, fromWeek: WeekId, thisWeek: WeekId, fromData: WeekData | undefined, weeks: WeekData[], when: (ms: number) => string) {
  const lockAt = boundsFor(space, fromWeek, fromData?.week ?? null).lockAt
  return playConfirm(fromWeek, thisWeek, when(lockAt), lockedRoles(space, me, nowMs, fromWeek, weeks).judged)
}
