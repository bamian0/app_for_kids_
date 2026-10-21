// Someone's profile showcase (SPEC §11.9.3): who they are to you, their ring (friends and you only), their
// stats, and the money items they chose to show. Anyone signed in can open anyone's; the actions at the end
// follow the relation (Remove Friend, Accept, Cancel Request, Add Friend; Edit on your own).
import { useState } from 'react'
import { cancelFriendRequest, removeFriend, useAuth, useProfiles, useShowcase, useStats } from '../../data/api.ts'
import { formatMoney } from '../../domain/money.ts'
import { ringLine, showOf, statsView } from '../../domain/showcase.ts'
import type { Showcase, UID } from '../../domain/types.ts'
import { Avatar, Button, GlassButton, Icon, ProgressBar, Row, ScoreRing, Screen, Section, useAlert, useNav, useToast } from '../../ui/index.ts'
import { Loading } from '../components/Bits.tsx'
import { useNow } from '../components/clock.ts'
import { monthName } from '../components/format.ts'
import { firstName } from '../components/people.ts'
import {
  acrossSpaces,
  askAgainText,
  cancelConfirm,
  earnedIn,
  nothingSharedText,
  relationLine,
  removeConfirm,
  shortDay,
  statsFooter,
  updatedFooter,
} from './copy.ts'
import { errorText, personFor, relationTo, useFriendActions, useRingView, useView } from './parts.tsx'
import type { Relation } from './parts.tsx'
import { ShowcaseEditorScreen } from './ShowcaseEditorScreen.tsx'

interface Props {
  uid: UID
  /** Their name as the caller knows it, shown until the profile loads. */
  name?: string
  /** On your own showcase opened from the editor: Edit goes back instead of stacking another editor. */
  onEdit?: () => void
}

export function ShowcaseScreen({ uid, name, onEdit }: Props) {
  const nav = useNav()
  const auth = useAuth()
  const nowMs = useNow()
  const { view } = useView()
  const profiles = useProfiles([uid])
  const showcase = useShowcase(uid)
  const isMe = uid === auth.uid
  const profile = isMe ? (auth.profile ?? profiles[uid]) : profiles[uid]
  const person = personFor(profile ? { [uid]: profile } : {}, uid, name)
  const rel = relationTo(view, auth.uid, uid, nowMs)
  const line = relationLine(rel.relation, rel.at, nowMs)

  const edit = onEdit ?? (() => nav.push(<ShowcaseEditorScreen />, { title: 'Showcase' }))

  return (
    <Screen
      title={person.name}
      titleDisplay="inline"
      trailing={
        isMe ? (
          <GlassButton aria-label="Edit" onClick={edit}>
            Edit
          </GlassButton>
        ) : undefined
      }
    >
      <div className="fr-hero">
        <Avatar name={person.name} color={person.color} photo={person.photo} size={88} />
        <div className="fr-hero__name">{person.name}</div>
        {line && <div className="fr-hero__line">{line}</div>}
      </div>

      {(rel.relation === 'friend' || isMe) && <RingSection uid={uid} mine={isMe} />}

      {showcase.data === undefined ? (
        showcase.error ? (
          <Section>
            <Row title="Can’t load this showcase" subtitle={showcase.error.message} />
          </Section>
        ) : (
          <Loading />
        )
      ) : (
        <Items uid={uid} name={person.name} showcase={showcase.data} mine={isMe} onEdit={edit} />
      )}

      {!isMe && <Actions uid={uid} name={person.name} rel={rel} />}
    </Screen>
  )
}

function RingSection({ uid, mine }: { uid: UID; mine: boolean }) {
  const ring = useRingView(uid)
  const across = acrossSpaces(ring.spaces)
  return (
    <Section padded footer={mine ? 'Only friends see your ring.' : undefined}>
      <div className="fr-ring">
        <ScoreRing key={ring.value === null ? 'empty' : 'score'} value={ring.value} size={120} stroke={13} aria-label={ringLine(ring)} />
        <div className="fr-ring__line t-tabular">{ringLine(ring)}</div>
        {across && <div className="fr-ring__across">{across}</div>}
      </div>
    </Section>
  )
}

function Items({ uid, name, showcase, mine, onEdit }: { uid: UID; name: string; showcase: Showcase | null; mine: boolean; onEdit: () => void }) {
  const nowMs = useNow()
  const show = showOf(showcase)
  const achieved = show.achieved ? (showcase?.achieved ?? []) : []
  const goals = show.goals ? (showcase?.goals ?? []) : []
  const earnings = show.earnings ? (showcase?.earnings ?? null) : null
  const money = achieved.length > 0 || goals.length > 0 || earnings !== null
  const updated = money && showcase ? updatedFooter(showcase.updatedAt, nowMs) : null
  // The footer goes under the last money section shown.
  const last = earnings ? 'earnings' : goals.length > 0 ? 'goals' : 'achieved'

  if (!show.stats && !money) {
    return mine ? (
      <Section padded>
        <div className="fr-nothing">
          <div className="fr-nothing__text">Nothing on your showcase yet.</div>
          <Button variant="gray" onClick={onEdit}>
            Choose What to Show
          </Button>
        </div>
      </Section>
    ) : (
      <Section padded>
        <div className="fr-nothing">
          <div className="fr-nothing__text">{nothingSharedText(name)}</div>
        </div>
      </Section>
    )
  }

  return (
    <>
      {show.stats && <StatsSection uid={uid} />}
      {achieved.length > 0 && (
        <Section header="Achieved" footer={last === 'achieved' ? updated : undefined}>
          {achieved.map((g, i) => (
            <Row
              key={`${g.name}-${g.at}-${i}`}
              leading={<Icon name="checkmarkCircleFill" size={24} weight={1.9} className="fr-achieved" />}
              title={g.name}
              detail={shortDay(g.at, nowMs)}
            />
          ))}
        </Section>
      )}
      {goals.length > 0 && (
        <Section header="Saving For" footer={last === 'goals' ? updated : undefined}>
          {goals.map((g, i) => {
            const funded = g.pct >= 100
            return (
              <div key={`${g.name}-${i}`} className="fr-goal">
                <div className="fr-goal__top">
                  <span className="fr-goal__name">{g.name}</span>
                  <span className={funded ? 'fr-goal__pct is-funded' : 'fr-goal__pct t-tabular'}>{funded ? 'Funded' : `${g.pct}%`}</span>
                </div>
                <ProgressBar className="fr-goal__bar" value={g.pct / 100} tone={funded ? 'iridescent' : 'label'} label={`${g.name}: ${g.pct} percent funded`} />
              </div>
            )
          })}
        </Section>
      )}
      {earnings && (
        <Section header="Last Month" footer={updated}>
          <Row title={earnedIn(monthName(earnings.monthId))} detail={<span className="fr-amount">{formatMoney(earnings.amount, earnings.currency)}</span>} />
        </Section>
      )}
    </>
  )
}

/** The four stats, read only while the showcase shows them (the rules refuse them otherwise). */
function StatsSection({ uid }: { uid: UID }) {
  const live = useStats(uid)
  const loading = live.data === undefined && !live.error
  const stats = statsView(live.data ?? null)
  const nothing = !loading && stats.finishedMonths === 0 && stats.weeksPlayed === 0
  if (nothing) {
    return (
      <Section header="Stats">
        <Row title="No finished months yet." />
      </Section>
    )
  }
  const facts: [number, string][] = [
    [stats.monthsCleared, 'Months at 90%+'],
    [stats.currentStreak, 'Month streak'],
    [stats.bestStreak, 'Best streak'],
    [stats.weeksPlayed, 'Weeks played'],
  ]
  return (
    <Section header="Stats" footer={loading ? undefined : statsFooter(stats.since)}>
      <div className="fr-stats" aria-busy={loading || undefined}>
        {facts.map(([n, label]) => (
          <div key={label} className="fr-stat">
            <span className="fr-stat__value t-tabular">{loading ? '–' : n}</span>
            <span className="fr-stat__label">{label}</span>
          </div>
        ))}
      </div>
    </Section>
  )
}

function Actions({ uid, name, rel }: { uid: UID; name: string; rel: Relation }) {
  const nav = useNav()
  const toast = useToast()
  const nowMs = useNow()
  const { confirm } = useAlert()
  const actions = useFriendActions()
  const [busy, setBusy] = useState(false)

  const remove = async () => {
    const copy = removeConfirm(name)
    const ok = await confirm({ title: copy.title, message: copy.message, confirmLabel: copy.confirmLabel, cancelLabel: copy.cancelLabel, destructive: true })
    if (!ok) return
    setBusy(true)
    try {
      await removeFriend(uid)
      nav.pop()
      toast({ title: `Removed ${firstName(name)}`, icon: 'person' })
    } catch (e) {
      toast({ title: 'Couldn’t remove', message: errorText(e), tone: 'error' })
    } finally {
      setBusy(false)
    }
  }

  const cancel = async () => {
    const copy = cancelConfirm(name)
    const ok = await confirm({ title: copy.title, message: copy.message, confirmLabel: copy.confirmLabel, cancelLabel: copy.cancelLabel, destructive: true })
    if (!ok) return
    setBusy(true)
    try {
      await cancelFriendRequest(uid)
      toast({ title: 'Request canceled', icon: 'xmark' })
    } catch (e) {
      toast({ title: 'Couldn’t cancel', message: errorText(e), tone: 'error' })
    } finally {
      setBusy(false)
    }
  }

  if (rel.relation === 'friend') {
    return (
      <Section>
        <Row title="Remove Friend" destructive disabled={busy} onPress={() => void remove()} />
      </Section>
    )
  }
  if (rel.relation === 'incoming') {
    return (
      <Section>
        <Row title="Accept" action disabled={!!actions.busy} onPress={() => void actions.accept(uid, name)} />
        <Row title="Decline" disabled={!!actions.busy} onPress={() => void actions.decline(uid, name)} />
      </Section>
    )
  }
  if (rel.relation === 'sent') {
    return (
      <Section>
        <Row title="Requested" disabled />
        <Row title="Cancel Request" destructive disabled={busy} onPress={() => void cancel()} />
      </Section>
    )
  }
  if (rel.askAgain !== null) {
    return (
      <Section>
        <Row title={askAgainText(rel.askAgain, nowMs)} disabled />
      </Section>
    )
  }
  return (
    <Section>
      <Row title="Add Friend" action leading={<Icon name="personPlus" size={22} weight={1.9} />} disabled={!!actions.busy} onPress={() => void actions.ask(uid, name)} />
    </Section>
  )
}
