// The Stakes screen (SPEC §9.7): what counts now for you, your new stakes and who still has to agree, each
// friend's stakes as they apply to you (with Agree), and the house stakes. Every "counts now" row is memberTerms
// for termsMonth with termsFriends of that row's subject and the space's house stakes, as on the stakes card.
import { useEffect, useRef, useState } from 'react'
import { agreeToStakes, useAuth, useLatestResults, useMonthly, useProfiles, useSpace, useStakes, useWeek } from '../../data/api.ts'
import { agreementStatus, memberTerms, missingFor, pairTerms, waitingFor } from '../../domain/stakes.ts'
import { monthIdForWeek, weekIdFor } from '../../domain/time.ts'
import type { MemberStakes, Space, TermsInForce, UID } from '../../domain/types.ts'
import { Avatar, Button, EmptyState, GlassButton, Icon, Row, Screen, Section, haptic, useAlert, useSheet, useToast } from '../../ui/index.ts'
import { Loading } from '../components/Bits.tsx'
import { useNow } from '../components/clock.ts'
import { firstName, nameOf, personOf } from '../components/people.ts'
import type { Profiles } from '../components/people.ts'
import { StakesItems, StakesList } from '../components/Stakes.tsx'
import { StakesEditorSheet } from './StakesEditorSheet.tsx'
import {
  agreeConfirm,
  agreeOutcomeNow,
  agreeToast,
  differsFromCurrent,
  friendOrder,
  friendRows,
  friendsOf,
  friendStatus,
  houseFooter,
  houseOf,
  isJudging,
  JUDGE_NOTE,
  leaversHolding,
  newFriendRows,
  NO_OWN_FOOTER,
  ownFooter,
  ownRows,
  proposedRows,
  stakesFromLive,
  streakLine,
  termsInForceNow,
  termsNow,
  tierRows,
  tiersShown,
  waitingFooter,
} from './stakes.ts'
import type { StakesDocs, TermsNow } from './stakes.ts'
import './stakes.css'

const DAY = 86_400_000

export interface StakesScreenProps {
  spaceId: string
  /** Open scrolled to this friend's section (Take a Look, "Lena has new stakes"). */
  focus?: UID
}

export function StakesScreen({ spaceId, focus }: StakesScreenProps) {
  const live = useSpace(spaceId)
  if (live.data === undefined) {
    return (
      <Screen title="Stakes" titleDisplay="inline">
        {live.error ? <EmptyState icon="info" title="Can’t load the stakes" message={live.error.message} /> : <Loading />}
      </Screen>
    )
  }
  if (live.data === null) {
    return (
      <Screen title="Stakes" titleDisplay="inline">
        <EmptyState icon="person2" title="You’re not in this space" message="You left it, or it no longer exists." />
      </Screen>
    )
  }
  return <StakesBody space={live.data} focus={focus} />
}

function StakesBody({ space, focus }: { space: Space; focus?: UID }) {
  const { uid } = useAuth()
  const me = uid ?? ''
  const nowMs = useNow()
  const sheet = useSheet()
  const toast = useToast()
  const { confirm } = useAlert()
  const thisWeekId = weekIdFor(nowMs, space.timezone)
  // Shared with the Space screen's listeners: this week's stored doc and this month's list tell when the month ends.
  const week = useWeek(space, thisWeekId)
  const monthly = useMonthly(space, monthIdForWeek(thisWeekId))
  const stakesLive = useStakes(space)
  const stakes = stakesFromLive(stakesLive)
  const latest = useLatestResults(space)
  const leavers = Object.entries(space.leftAt ?? {}).flatMap(([id, at]) => (!space.memberIds.includes(id) && nowMs - at < 62 * DAY ? [id] : []))
  const profiles: Profiles = useProfiles([...space.memberIds, ...leavers])
  const name = (id: UID) => firstName(nameOf(profiles, id))
  const [busy, setBusy] = useState<UID | null>(null)

  const thisWeek = week.data?.week ?? null
  const now = termsNow(space, nowMs, thisWeek, monthly.data?.monthly ?? null)
  const house = houseOf(space)
  const judge = isJudging(space, me, thisWeek)
  const own = stakes?.[me]
  const friends = friendsOf(space, me, now)
  const shown = friends.filter((f) => space.memberIds.includes(f))
  const terms = stakes ? memberTerms(space, me, friends, stakes, house, Infinity) : {}
  const streak = latest.data?.members[me]?.streak ?? null

  // Take a Look: open on that friend's section.
  const sections = useRef(new Map<UID, HTMLElement>())
  const scrolled = useRef(false)
  const ready = stakesLive.data !== undefined || !!stakesLive.error
  useEffect(() => {
    if (!focus || !ready || scrolled.current) return
    const el = sections.current.get(focus)
    if (!el) return
    scrolled.current = true
    el.scrollIntoView({ block: 'start' })
  }, [focus, ready])

  const openEditor = (friend?: UID) => sheet.present((close) => <StakesEditorSheet space={space} own={own} now={now} focus={friend} close={close} />)

  const agree = async (subject: UID) => {
    const terms = pairTerms(stakes?.[subject], me)
    if (!terms || busy) return
    const outcome = agreeOutcomeNow(space, subject, me, stakes, now, nowMs)
    const ask = agreeConfirm(name(subject), terms, outcome, now, name, space.threshold)
    const ok = await confirm({
      title: ask.title,
      message: (
        <>
          {ask.lines.map((line, i) => (
            <span key={i} style={{ display: 'block', marginTop: i === ask.lines.length - 1 ? 8 : 0 }}>
              {line}
            </span>
          ))}
        </>
      ),
      confirmLabel: 'Agree',
    })
    if (!ok) return
    setBusy(subject)
    try {
      await agreeToStakes(space, subject, terms)
      haptic()
      const done = agreeToast(name(subject), outcome, now, name)
      toast({ title: done.title, message: done.message, icon: 'checkmark', tone: 'success' })
    } catch (e) {
      toast({ title: 'Couldn’t agree', message: e instanceof Error ? e.message : undefined, tone: 'error' })
    } finally {
      setBusy(null)
    }
  }

  if (!ready) {
    return (
      <Screen title="Stakes" titleDisplay="inline">
        <Loading />
      </Screen>
    )
  }

  const owner = space.ownerId === me
  return (
    <Screen
      title="Stakes"
      titleDisplay="inline"
      trailing={judge || space.memberIds.length < 2 ? undefined : <GlassButton onClick={() => openEditor()}>Edit</GlassButton>}
    >
      {stakesLive.error && <EmptyState icon="info" title="Can’t load everyone’s stakes" message="For now, the house stakes count for everyone." />}
      {judge && (
        <Section>
          <Row leading={<span className="sk-line-icon" aria-hidden><Icon name="person2" size={16} weight={2.2} /></span>} title={<span className="sk-note">{JUDGE_NOTE}</span>} />
        </Section>
      )}

      {stakes && space.memberIds.length > 1 && (
        <YourStakes space={space} own={own} friends={friends} shown={shown} terms={terms} now={now} streak={streak} judge={judge} name={name} profiles={profiles} onEdit={openEditor} />
      )}

      {stakes &&
        friendOrder(space, me, stakes, judge).map((subject) => (
          <FriendStakes
            key={subject}
            sectionRef={(el) => {
              if (el) sections.current.set(subject, el)
              else sections.current.delete(subject)
            }}
            space={space}
            me={me}
            subject={subject}
            stakes={stakes}
            now={now}
            judge={judge}
            busy={busy === subject}
            name={name}
            profiles={profiles}
            onAgree={() => void agree(subject)}
          />
        ))}

      <Section header="House stakes" footer={houseFooter(name(space.ownerId), owner)}>
        <StakesList reward={house.reward} penalty={house.penalty} threshold={space.threshold} />
      </Section>
    </Screen>
  )
}

interface YourStakesProps {
  space: Space
  own: MemberStakes | undefined
  friends: UID[]
  shown: UID[]
  terms: Record<UID, TermsInForce>
  now: TermsNow
  streak: number | null
  judge: boolean
  name: (uid: UID) => string
  profiles: Profiles
  onEdit: (friend?: UID) => void
}

function YourStakes({ space, own, friends, shown, terms, now, streak, judge, name, profiles, onEdit }: YourStakesProps) {
  const house = houseOf(space)
  const rowsNow = [...ownRows(terms, shown, house, name, space.threshold), ...tierRows(tiersShown(terms, shown))]
  if (!own) {
    const footer = [judge ? null : NO_OWN_FOOTER, streakLine(streak)].filter(Boolean).join(' ')
    return (
      <Section header="Your stakes" footer={footer || undefined}>
        <StakesItems items={rowsNow} />
        {!judge && <Row leading={<span className="sk-action-icon" aria-hidden><Icon name="plus" size={20} weight={2.2} /></span>} title="Set Your Own Stakes" action onPress={() => onEdit()} />}
      </Section>
    )
  }
  const differs = shown.some((f) => differsFromCurrent(terms[f], pairTerms(own, f)))
  const waiting = waitingFor(own, shown)
  const missing = missingFor(own, shown)
  const footer = ownFooter({
    waiting: waiting.map(name),
    total: shown.length,
    leavers: leaversHolding(space, own, friends, terms).map(name),
    month: now.month,
    allAgreed: !differs && waiting.length === 0 && missing.length === 0,
    streak,
  })
  const statusRows = shown.map((f) => {
    const person = personOf(profiles, f)
    const avatar = <Avatar name={person.name} color={person.color} photo={person.photo} size={32} />
    const status = friendStatus(own, f, terms[f])
    if (status.kind === 'missing') {
      return judge ? (
        <Row key={f} leading={avatar} title={name(f)} subtitle="No stakes set for them yet" />
      ) : (
        <Row key={f} leading={avatar} title={`Add Stakes for ${name(f)}`} action onPress={() => onEdit(f)} />
      )
    }
    if (status.kind === 'agreed') {
      return (
        <Row
          key={f}
          leading={avatar}
          title={name(f)}
          detail={
            <span className="sk-status">
              <Icon name="checkmark" size={13} weight={2.6} />
              Agreed
            </span>
          }
        />
      )
    }
    return (
      <Row
        key={f}
        leading={avatar}
        title={name(f)}
        subtitle={status.subtitle}
        detail={
          <span className="sk-status">
            <Icon name="clock" size={13} weight={2.2} />
            Waiting
          </span>
        }
      />
    )
  })
  if (!differs) {
    return (
      <Section header="Your stakes" footer={footer ?? undefined}>
        <StakesItems items={rowsNow} />
        {statusRows}
      </Section>
    )
  }
  return (
    <>
      <Section header="Your stakes" headerAccessory={<span className="sk-head__counts">Counts now</span>}>
        <StakesItems items={rowsNow} />
      </Section>
      <Section header="Your new stakes" footer={footer ?? undefined}>
        <StakesItems items={proposedRows(own, shown, name, space.threshold)} />
        {statusRows}
      </Section>
    </>
  )
}

interface FriendStakesProps {
  sectionRef: (el: HTMLElement | null) => void
  space: Space
  me: UID
  subject: UID
  stakes: StakesDocs
  now: TermsNow
  judge: boolean
  busy: boolean
  name: (uid: UID) => string
  profiles: Profiles
  onAgree: () => void
}

function FriendStakes({ sectionRef, space, me, subject, stakes, now, judge, busy, name, profiles, onAgree }: FriendStakesProps) {
  const theirs = stakes[subject]
  const subjectName = name(subject)
  const person = personOf(profiles, subject)
  // What counts between them and you now (with you among their friends even while you judge).
  const forMe = termsInForceNow(space, subject, stakes, now, [me])[me]
  const theirFriends = friendsOf(space, subject, now).filter((f) => space.memberIds.includes(f))
  const alone = theirFriends.length <= 1
  const current = pairTerms(theirs, me)
  const status = theirs ? agreementStatus(theirs, me) : 'missing'
  const showNew = differsFromCurrent(forMe, current)
  const footer =
    theirs && status !== 'missing' ? waitingFooter(waitingFor(theirs, theirFriends), me, name) : `${subjectName} hasn’t set stakes with you yet. The house stakes count.`
  return (
    <div className="sk-section" ref={sectionRef}>
      <Section
        header={
          <span className="sk-head">
            <Avatar name={person.name} color={person.color} photo={person.photo} size={22} />
            {subjectName}
          </span>
        }
        footer={footer}
      >
        {forMe && <StakesItems items={friendRows(subjectName, forMe, space.threshold, alone)} />}
        {showNew && current && (
          <>
            <div className="sk-subhead">New</div>
            <StakesItems items={newFriendRows(subjectName, current, space.threshold, alone)} />
          </>
        )}
        {status === 'missing' ? null : status === 'agreed' ? (
          <Row
            leading={
              <span className="sk-line-icon" aria-hidden>
                <Icon name="checkmark" size={15} weight={2.6} />
              </span>
            }
            title="You agreed"
          />
        ) : judge ? null : (
          <div className="sk-agree">
            <Button size="large" fullWidth loading={busy} onClick={onAgree}>
              {`Agree to ${subjectName}’s Stakes`}
            </Button>
          </div>
        )}
      </Section>
    </div>
  )
}
