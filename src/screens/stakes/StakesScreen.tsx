// The Stakes screen (SPEC §12.10): October's stakes while they still count (read-only), your deal (or Make a Deal and
// Same Again), friends' deals waiting on your Agree or your Call Off, what's left to settle, everyone's deals, your
// streak rewards (and friends' new ones to agree to), Past Deals, and the house stakes new deals start from.
import { useEffect, useRef, useState } from 'react'
import { agreeToStakes, useAuth, useDeals, useDealsFrom, useLatestResults, useMonthly, useProfiles, useSpace, useStakes, useWeek } from '../../data/api.ts'
import { dealFriends, lastPlayedDeal } from '../../domain/deals.ts'
import { spaceJudges } from '../../domain/scoring.ts'
import { memberTerms, oldStakesMonth, pairTerms } from '../../domain/stakes.ts'
import { monthIdForWeek, weekIdFor } from '../../domain/time.ts'
import type { Deal, MemberStakes, Space, UID } from '../../domain/types.ts'
import { Avatar, Button, CheckCircle, EmptyState, Facts, GlassButton, Icon, Row, Screen, Section, haptic, useAlert, useNav, useSheet, useToast } from '../../ui/index.ts'
import { Loading } from '../components/Bits.tsx'
import { useNow } from '../components/clock.ts'
import { personOf } from '../components/people.ts'
import type { Profiles } from '../components/people.ts'
import { StakesItems } from '../components/Stakes.tsx'
import { useDealActions } from './dealActions.tsx'
import { DealHistoryScreen } from './DealHistoryScreen.tsx'
import { DealScreen } from './DealScreen.tsx'
import {
  atStakeLine,
  dealNamer,
  dealNow,
  dealPeople,
  dealTitle,
  friendDealRows,
  houseStakesFooter,
  inDeal,
  isOn,
  JUDGE_NO_DEAL,
  lastTimeText,
  leavingFooter,
  NO_FRIENDS,
  octoberFooter,
  octoberHeader,
  possessive,
  SETTLE_FOOTER,
  settleRows,
  sortSettleRows,
  statusLine,
  streakAgreeConfirm,
  streakFooter,
  streakMissingText,
  streakStatus,
  streaksWaitOnMe,
  sameTierList,
  waitingOnYouFooter,
  yourDealFooter,
} from './deals.ts'
import type { Name } from './deals.ts'
import { StreakRewardsSheet } from './StreakRewardsSheet.tsx'
import { friendRows, friendsOf, houseOf, playingFriends, stakesCard, stakesFromLive, termsInForceNow, termsNow, tierRows, tiersShown } from './stakes.ts'
import type { StakesDocs, TermsNow } from './stakes.ts'
import './stakes.css'

const DAY = 86_400_000

export interface StakesScreenProps {
  spaceId: string
  /** Open scrolled to this deal (Take a Look, "New deal from Lena"). */
  focus?: string
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

/** A tile like the stakes rows' (filled for what you're owed). */
function Tile({ icon, filled }: { icon: 'handshake' | 'plus' | 'undo' | 'clock'; filled?: boolean }) {
  return (
    <span className={filled ? 'dl-tile dl-tile--filled' : 'dl-tile'} aria-hidden>
      <Icon name={icon} size={18} weight={icon === 'handshake' ? 1.8 : 2.2} />
    </span>
  )
}

function StakesBody({ space, focus }: { space: Space; focus?: string }) {
  const { uid } = useAuth()
  const me = uid ?? ''
  const nowMs = useNow()
  const nav = useNav()
  const sheet = useSheet()
  const dealsFrom = useDealsFrom()
  const thisWeekId = weekIdFor(nowMs, space.timezone)
  // Shared with the Space screen's listeners: this week's doc (the clock, its result) and this month's list (the
  // October window).
  const week = useWeek(space, thisWeekId)
  const monthly = useMonthly(space, monthIdForWeek(thisWeekId))
  const thisWeek = week.data?.week ?? null
  const dealsLive = useDeals(space)
  const deals = dealsLive.error ? undefined : dealsLive.data
  const stakesLive = useStakes(space)
  const stakes = stakesFromLive(stakesLive)
  const latest = useLatestResults(space)
  const all = deals ? [...Object.values(deals.open), ...deals.ended] : []
  const leavers = Object.entries(space.leftAt ?? {}).flatMap(([id, at]) => (!space.memberIds.includes(id) && nowMs - at < 62 * DAY ? [id] : []))
  const profiles: Profiles = useProfiles([...new Set([...space.memberIds, ...leavers, ...dealPeople(all)])])
  const name = dealNamer(profiles, space.memberIds)
  const actions = useDealActions(space, me, name)
  const oldMonth = oldStakesMonth(space, nowMs, thisWeek, monthly.data?.monthly ?? null, dealsFrom)
  const judge = spaceJudges(space).includes(me)
  const weeks = [thisWeek]
  const stateOf = (d: Deal) => dealNow(d, space, nowMs, weeks, week.data)
  const ctx = { me, nowMs, tz: space.timezone, threshold: space.threshold, name }

  const mine = deals?.open[me]
  const myState = mine ? stateOf(mine) : null
  const friendsOpen = Object.values(deals?.open ?? {})
    .filter((d) => d.uid !== me && space.memberIds.includes(d.uid))
    .sort((a, b) => (space.joinedAt[a.uid] ?? 0) - (space.joinedAt[b.uid] ?? 0))
    .map((deal) => ({ deal, state: stateOf(deal) }))
  const waitingOnMe = friendsOpen.filter(
    ({ state }) =>
      (state.phase === 'waiting' && state.waitingFor.includes(me)) ||
      (isOn(state) && !state.provisional && state.callOff.asked.length > 0 && state.callOff.waitingFor.includes(me)),
  )
  const toSettle = sortSettleRows(
    (deals?.ended ?? []).filter((d) => d.ended?.outcome === 'won' || d.ended?.outcome === 'lost').flatMap((d) => settleRows(d, stateOf(d), { me, memberIds: space.memberIds, name })),
  )
  const last = deals ? lastPlayedDeal(deals.ended, me) : null
  const playing = dealFriends(space, me)
  const canMake = !!deals && !mine && !judge && playing.length > 0
  const friends = [...space.memberIds].filter((id) => id !== me).sort((a, b) => (space.joinedAt[a] ?? 0) - (space.joinedAt[b] ?? 0))

  // Take a Look: open on that deal.
  const anchors = useRef(new Map<string, HTMLElement>())
  const scrolled = useRef(false)
  const ready = deals !== undefined || !!dealsLive.error
  useEffect(() => {
    if (!focus || !ready || scrolled.current) return
    const el = anchors.current.get(`wait:${focus}`) ?? anchors.current.get(`friend:${focus}`)
    if (!el) return
    scrolled.current = true
    el.scrollIntoView({ block: 'start' })
  }, [focus, ready])
  const anchor = (id: string) => (el: HTMLElement | null) => {
    if (el) anchors.current.set(id, el)
    else anchors.current.delete(id)
  }

  const openDeal = (deal: Deal) => nav.push(<DealScreen spaceId={space.id} dealId={deal.id} />, { title: 'Stakes' })
  const isOwner = space.ownerId === me

  if (!ready && !stakesLive.error && stakesLive.data === undefined) {
    return (
      <Screen title="Stakes" titleDisplay="inline">
        <Loading />
      </Screen>
    )
  }

  return (
    <Screen
      title="Stakes"
      titleDisplay="inline"
      trailing={canMake ? <GlassButton icon="plus" aria-label="Make a Deal" onClick={() => actions.edit()} /> : undefined}
    >
      {oldMonth && <OctoberSection space={space} me={me} nowMs={nowMs} stakes={stakes} thisWeek={thisWeek} monthly={monthly.data?.monthly ?? null} month={oldMonth} name={name} profiles={profiles} />}

      {/* 2. Your Deal */}
      {dealsLive.error ? (
        <Section header="Your Deal">
          <Row leading={<Tile icon="handshake" />} title="Can’t load deals" subtitle={dealsLive.error.message} />
        </Section>
      ) : mine && myState ? (
        <Section header="Your Deal" footer={isOn(myState) ? leavingFooter(space.name) : undefined}>
          <Row leading={<Tile icon="handshake" />} title={dealTitle(mine, space.threshold)} subtitle={<Facts text={statusLine(mine, myState, ctx)} />} chevron onPress={() => openDeal(mine)} />
        </Section>
      ) : judge ? (
        <Section header="Your Deal">
          <Row leading={<Tile icon="handshake" />} title={<span className="sk-note">{JUDGE_NO_DEAL}</span>} />
        </Section>
      ) : playing.length === 0 ? (
        <Section header="Your Deal">
          <Row leading={<Tile icon="handshake" />} title={<span className="sk-note">{NO_FRIENDS}</span>} />
        </Section>
      ) : deals ? (
        <Section header="Your Deal" footer={yourDealFooter(space.threshold)}>
          <Row leading={<Tile icon="plus" filled />} title="Make a Deal" action onPress={() => actions.edit()} />
          {last && <Row leading={<Tile icon="undo" />} title="Same Again" subtitle={lastTimeText(last)} action onPress={() => void actions.sameAgain(last)} />}
        </Section>
      ) : null}

      {/* 3. Waiting on You */}
      {waitingOnMe.map(({ deal, state }, i) => {
        const subject = name(deal.uid)
        const person = personOf(profiles, deal.uid)
        const agreeing = state.phase === 'waiting'
        return (
          <div className="sk-section" key={deal.id} ref={anchor(`wait:${deal.id}`)}>
            <Section header={i === 0 ? 'Waiting on You' : undefined} footer={waitingOnYouFooter(deal, state, me, name, nowMs, space.timezone)}>
              <Row
                leading={<Avatar name={person.name} color={person.color} photo={person.photo} size={30} />}
                title={<span className="t-semibold">{`${possessive(subject)} deal: ${dealTitle(deal, space.threshold)}`}</span>}
                chevron
                onPress={() => openDeal(deal)}
              />
              <StakesItems items={friendDealRows(deal, me, subject)} />
              <div className="sk-agree">
                {agreeing ? (
                  <Button size="large" fullWidth onClick={() => void actions.agree(deal, state)}>
                    {`Agree to ${possessive(subject)} Deal`}
                  </Button>
                ) : (
                  <Button size="large" fullWidth variant="destructive" onClick={() => void actions.callOff(deal, state)}>
                    Call Off
                  </Button>
                )}
              </div>
            </Section>
          </div>
        )
      })}

      {/* 4. To Settle */}
      {toSettle.length > 0 && (
        <Section header="To Settle" footer={SETTLE_FOOTER}>
          {toSettle.map((row) => (
            <Row
              key={`${row.deal.id}-${row.line.keys.join(',')}`}
              leading={<CheckCircle checked={row.settled} disabled={!row.canSettle} onChange={() => actions.settle(row)} aria-label={`Settled: ${row.title}`} />}
              title={<span className="t-semibold">{row.title}</span>}
              subtitle={<Facts text={row.subtitle} />}
            />
          ))}
        </Section>
      )}

      {/* 5. Friends’ Deals */}
      {friends.length > 0 && (
        <Section header="Friends’ Deals">
          {friends.map((f) => {
            const person = personOf(profiles, f)
            const open = friendsOpen.find((x) => x.deal.uid === f)
            const avatar = <Avatar name={person.name} color={person.color} photo={person.photo} size={30} />
            if (!open) return <Row key={f} leading={avatar} title={name(f)} subtitle="Nothing at stake" />
            const stake = inDeal(open.deal, open.state, me) ? atStakeLine(open.deal, me, name(f)) : null
            return (
              <div key={f} ref={anchor(`friend:${open.deal.id}`)} className="sk-section">
                <Row
                  leading={avatar}
                  title={name(f)}
                  subtitle={
                    <>
                      <span className="dl-sub">{statusLine(open.deal, open.state, ctx)}</span>
                      {stake && <span className="dl-sub dl-sub--quiet">{stake}</span>}
                    </>
                  }
                  chevron
                  onPress={() => openDeal(open.deal)}
                />
              </div>
            )
          })}
        </Section>
      )}

      {/* 6. Streak Rewards */}
      {stakes && (
        <StreakRewards
          space={space}
          me={me}
          stakes={stakes}
          now={termsNow(space, nowMs, thisWeek, monthly.data?.monthly ?? null)}
          frozen={!!oldMonth}
          judge={judge}
          streak={latest.data?.members[me]?.streak ?? null}
          name={name}
          profiles={profiles}
          onEdit={() => sheet.present((close) => <StreakRewardsSheet space={space} close={close} />, { 'aria-label': 'Streak Rewards' })}
        />
      )}

      {/* 7. Past Deals */}
      <Section>
        <Row icon="clock" title="Past Deals" chevron onPress={() => nav.push(<DealHistoryScreen spaceId={space.id} />, { title: 'Stakes' })} />
      </Section>

      {/* 8. House Stakes */}
      <Section header="House Stakes" footer={houseStakesFooter(name(space.ownerId), isOwner, oldMonth)}>
        <StakesItems
          items={[
            { icon: 'trophy', label: 'If you make it', text: space.reward },
            { icon: 'flame', label: 'If you miss', text: space.penalty },
          ]}
        />
      </Section>
    </Screen>
  )
}

interface OctoberProps {
  space: Space
  me: UID
  nowMs: number
  stakes: StakesDocs | undefined
  thisWeek: import('../../domain/types.ts').Week | null
  monthly: import('../../domain/types.ts').MonthlyList | null
  month: string
  name: Name
  profiles: Profiles
}

/** October's stakes (read-only): your two rows, then each friend's as they apply to you. */
function OctoberSection({ space, me, nowMs, stakes, thisWeek, monthly, month, name, profiles }: OctoberProps) {
  const model = stakesCard({ space, me, stakes, nowMs, thisWeek, monthly, name })
  const now = model.now
  const friends = playingFriends(space, me)
  return (
    <Section header={octoberHeader(month)} footer={octoberFooter(month)}>
      <StakesItems items={model.rows} />
      {stakes &&
        friends.map((f) => {
          const forMe = termsInForceNow(space, f, stakes, now, [me])[me]
          if (!forMe) return null
          const person = personOf(profiles, f)
          const alone = friendsOf(space, f, now).filter((x) => space.memberIds.includes(x)).length <= 1
          return (
            <div key={f}>
              <div className="sk-subhead dl-subhead">
                <Avatar name={person.name} color={person.color} photo={person.photo} size={18} />
                {name(f)}
              </div>
              <StakesItems items={friendRows(name(f), forMe, space.threshold, alone)} />
            </div>
          )
        })}
    </Section>
  )
}

interface StreakProps {
  space: Space
  me: UID
  stakes: StakesDocs
  now: TermsNow
  /** The October window: no edit, no Agree. */
  frozen: boolean
  judge: boolean
  streak: number | null
  name: Name
  profiles: Profiles
  onEdit: () => void
}

/** Your streak rewards in force (and your new ones with who agreed), and friends' new ones to agree to. */
function StreakRewards({ space, me, stakes, now, frozen, judge, streak, name, profiles, onEdit }: StreakProps) {
  const toast = useToast()
  const { confirm } = useAlert()
  const [busy, setBusy] = useState<UID | null>(null)
  const own: MemberStakes | undefined = stakes[me]
  const friends = friendsOf(space, me, now)
  const shown = friends.filter((f) => space.memberIds.includes(f))
  const terms = memberTerms(space, me, friends, stakes, houseOf(space), Infinity)
  const inForce = tiersShown(terms, shown)
  const mineNew = own && !sameTierList(inForce, own.tiers) ? own.tiers : null
  const others = playingFriends(space, me).filter((f) => streaksWaitOnMe(stakes[f], me))

  const agree = async (subject: UID) => {
    const theirs = stakes[subject]
    const t = pairTerms(theirs, me)
    if (!theirs || !t || busy) return
    const ask = streakAgreeConfirm(name(subject), theirs.tiers)
    const ok = await confirm({
      title: ask.title,
      message: (
        <>
          {ask.lines.map((l, i) => (
            <span key={i} style={{ display: 'block' }}>
              {l}
            </span>
          ))}
        </>
      ),
      confirmLabel: 'Agree',
    })
    if (!ok) return
    setBusy(subject)
    try {
      await agreeToStakes(space, subject, t)
      haptic()
      toast({ title: 'You agreed', message: 'They count once everyone agrees.', icon: 'checkmark', tone: 'success' })
    } catch (e) {
      toast({ title: 'Couldn’t agree', message: e instanceof Error ? e.message : undefined, tone: 'error' })
    } finally {
      setBusy(null)
    }
  }

  return (
    <>
      <Section header="Streak Rewards" footer={streakFooter(space.threshold, streak)}>
        {inForce.length > 0 ? <StakesItems items={tierRows(inForce)} /> : !mineNew && <Row title={<span className="sk-note">No streak rewards yet</span>} />}
        {mineNew && own && (
          <>
            <div className={inForce.length > 0 ? 'sk-subhead' : 'sk-subhead dl-subhead--first'}>Your new streak rewards</div>
            {mineNew.length > 0 ? <StakesItems items={tierRows(mineNew)} /> : <Row title={<span className="sk-note">None: you removed them</span>} />}
            {shown.map((f) => {
              const person = personOf(profiles, f)
              const status = streakStatus(own, f)
              return (
                <Row
                  key={f}
                  leading={<Avatar name={person.name} color={person.color} photo={person.photo} size={30} />}
                  title={name(f)}
                  detail={
                    <span className="sk-status">
                      <Icon name={status === 'Agreed' ? 'checkmark' : 'clock'} size={13} weight={status === 'Agreed' ? 2.6 : 2.2} />
                      {status}
                    </span>
                  }
                />
              )
            })}
          </>
        )}
        {!frozen && !judge && (
          <Row
            leading={
              <span className="sk-action-icon" aria-hidden>
                <Icon name="sparkles" size={19} weight={2} />
              </span>
            }
            title="Edit Streak Rewards"
            action
            onPress={onEdit}
          />
        )}
      </Section>
      {!frozen &&
        !judge &&
        others.map((f) => {
          const theirs = stakes[f]
          const subject = name(f)
          const person = personOf(profiles, f)
          const missing = pairTerms(theirs, me) === null
          return (
            <Section
              key={f}
              header={
                <span className="sk-head">
                  <Avatar name={person.name} color={person.color} photo={person.photo} size={22} />
                  {`${possessive(subject)} streak rewards`}
                </span>
              }
              footer={missing ? streakMissingText(subject) : undefined}
            >
              {theirs.tiers.length > 0 ? <StakesItems items={tierRows(theirs.tiers)} /> : <Row title={<span className="sk-note">No streak rewards anymore</span>} />}
              {!missing && (
                <div className="sk-agree">
                  <Button size="large" fullWidth loading={busy === f} onClick={() => void agree(f)}>
                    {`Agree to ${possessive(subject)} Streak Rewards`}
                  </Button>
                </div>
              )}
            </Section>
          )
        })}
    </>
  )
}
