// "New Deal" / "Edit Deal" (SPEC §12.10): how long (weeks or months, 1–12), what friends owe you if you make it and
// what you owe them if you miss one, each the same for everyone or different per friend. It says when the deal
// would start if everyone agrees, and proposes it; friends then tap Agree. Edit proposes the edited deal in place
// of your waiting one (everyone agrees again).
import { useState } from 'react'
import { proposeDeal, useAuth, useProfiles } from '../../data/api.ts'
import { agreeBy, dealFriends, dealLengthText, dealProblem, dealProblemText, firstPeriodAfter, DEAL_COUNTS, DEAL_DEFAULT } from '../../domain/deals.ts'
import type { DealProblem } from '../../domain/deals.ts'
import type { Deal, DealInput, DealUnit, Space, StakesMode, UID } from '../../domain/types.ts'
import { ActivityIndicator, Avatar, GlassButton, Icon, Row, Screen, Section, SegmentedControl, TextArea, haptic, useAlert, useToast } from '../../ui/index.ts'
import { ErrorText } from '../components/Bits.tsx'
import { useNow } from '../components/clock.ts'
import { firstName, nameOf, personOf } from '../components/people.ts'
import { clockOf, dealWhen, EDITOR_FOOTER, editorLengthFooter, missingTextsLine, proposedToast } from './deals.ts'
import './stakes.css'

export interface DealEditorSheetProps {
  space: Space
  /** Start from these terms (Same Again with texts missing). */
  input?: DealInput
  /** Same Again: friends without a text from last time. */
  missing?: UID[]
  /** Edit: your waiting deal (prefilled; Propose replaces it). */
  replace?: Deal
  close: () => void
  /** After a successful proposal (the deal screen of an edited deal steps back: that deal is withdrawn). */
  onProposed?: () => void
  /** First names from the screen that opened it (already loaded), for the toast and the fields. */
  name?: (uid: UID) => string
}

type Line = 'reward' | 'penalty'

interface Draft {
  unit: DealUnit
  count: number
  rewardMode: StakesMode
  penaltyMode: StakesMode
  reward: string
  penalty: string
  per: Record<UID, { reward: string; penalty: string }>
}

const MODES = [
  { value: 'group' as const, label: 'Same for Everyone' },
  { value: 'each' as const, label: 'Different per Friend' },
]
const UNITS = [
  { value: 'week' as const, label: 'Weeks' },
  { value: 'month' as const, label: 'Months' },
]

function draftOf(space: Space, friends: UID[], from?: DealInput): Draft {
  const per: Draft['per'] = {}
  for (const f of friends) per[f] = { reward: from?.per[f]?.reward ?? '', penalty: from?.per[f]?.penalty ?? '' }
  if (!from) return { ...DEAL_DEFAULT, rewardMode: 'group', penaltyMode: 'group', reward: space.reward, penalty: space.penalty, per }
  return { unit: from.unit, count: from.count, rewardMode: from.rewardMode, penaltyMode: from.penaltyMode, reward: from.reward, penalty: from.penalty, per }
}

/** Switching a line to per friend fills its empty fields with the shared text, and back (as the stakes editor did). */
function switchMode(d: Draft, line: Line, mode: StakesMode): Draft {
  const key = line === 'reward' ? 'rewardMode' : 'penaltyMode'
  if (d[key] === mode) return d
  const next: Draft = { ...d, [key]: mode, per: { ...d.per } }
  if (mode === 'each') {
    for (const f of Object.keys(next.per)) if (next.per[f][line].trim() === '') next.per[f] = { ...next.per[f], [line]: d[line] }
  } else if (d[line].trim() === '') {
    const first = Object.values(d.per).find((e) => e[line].trim() !== '')
    if (first) next[line] = first[line]
  }
  return next
}

/** Which section a problem shows under. */
function problemSection(p: DealProblem | null, d: Draft): 'length' | Line | 'footer' | null {
  if (!p) return null
  if (p === 'count') return 'length'
  if (p === 'fill-reward-each') return 'reward'
  if (p === 'fill-penalty-each') return 'penalty'
  if (p === 'fill-group') return d.rewardMode === 'group' && d.reward.trim() === '' ? 'reward' : 'penalty'
  if (p === 'long') {
    const long = (s: string) => s.trim().length > 120
    return long(d.reward) || Object.values(d.per).some((e) => d.rewardMode === 'each' && long(e.reward)) ? 'reward' : 'penalty'
  }
  return 'footer'
}

export function DealEditorSheet({ space, input, missing = [], replace, close, onProposed, name: given }: DealEditorSheetProps) {
  const { uid } = useAuth()
  const me = uid ?? ''
  const nowMs = useNow()
  const toast = useToast()
  const { actionSheet } = useAlert()
  const friends = dealFriends(space, me)
  const profiles = useProfiles(friends)
  const name = (id: UID) => (profiles[id] || !given ? firstName(nameOf(profiles, id)) : given(id))
  const [initial] = useState(() => draftOf(space, friends, input ?? replace))
  const [draft, setDraft] = useState<Draft>(initial)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const asInput = (d: Draft): DealInput => ({ ...d, per: d.rewardMode === 'each' || d.penaltyMode === 'each' ? d.per : {} })
  const problem = dealProblem(asInput(draft), friends)
  const where = problemSection(problem, draft)
  const dirty = JSON.stringify(asInput(draft)) !== JSON.stringify(asInput(initial))

  // When it would start if everyone agreed now, and until when they can agree for that.
  const clock = clockOf(space, draft.unit)
  const start = firstPeriodAfter(space, draft.unit, nowMs, clock)
  const by = dealWhen(agreeBy(start, clock), space.timezone, nowMs)

  const propose = async () => {
    if (problem || busy) return
    setBusy(true)
    setError(null)
    try {
      await proposeDeal(space, asInput(draft), replace ? { replace: replace.id } : undefined)
      haptic()
      const done = proposedToast(friends, name, !!replace)
      toast({ title: done.title, message: done.message, icon: 'handshake', tone: 'success' })
      close()
      onProposed?.()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Couldn’t propose the deal. Try again.')
      setBusy(false)
    }
  }

  const cancel = async () => {
    if (busy) return
    if (dirty) {
      const choice = await actionSheet({ actions: [{ label: 'Discard Changes', style: 'destructive' }], cancelLabel: 'Keep Editing' })
      if (choice !== 'Discard Changes') return
    }
    close()
  }

  const set = (patch: Partial<Draft>) => setDraft((d) => ({ ...d, ...patch }))
  const setPer = (friend: UID, line: Line, text: string) =>
    setDraft((d) => ({ ...d, per: { ...d.per, [friend]: { ...(d.per[friend] ?? { reward: '', penalty: '' }), [line]: text } } }))

  const problemNote = (section: 'length' | Line | 'footer') => (where === section && problem ? <ErrorText>{dealProblemText(problem)}</ErrorText> : null)
  const footerWith = (section: 'length' | Line, text: string) => {
    const note = problemNote(section)
    return note ? (
      <>
        {note} {text}
      </>
    ) : (
      text
    )
  }

  const lineSection = (line: Line) => {
    const mode = line === 'reward' ? draft.rewardMode : draft.penaltyMode
    const header = line === 'reward' ? 'If you make it, they owe you…' : 'If you miss, you owe them…'
    const footer =
      line === 'reward'
        ? mode === 'group'
          ? 'One thing from the whole group, together.'
          : 'Each friend owes you their own.'
        : mode === 'group'
          ? 'One thing you give the group.'
          : 'You owe each friend their own.'
    return (
      <Section header={header} footer={footerWith(line, footer)}>
        <div className="sk-mode">
          <SegmentedControl<StakesMode>
            size="small"
            aria-label={line === 'reward' ? 'Reward' : 'Penalty'}
            options={MODES}
            value={mode}
            onChange={(m) => setDraft((d) => switchMode(d, line, m))}
          />
        </div>
        {mode === 'group' ? (
          <TextArea
            value={draft[line]}
            onChange={(v) => set({ [line]: v })}
            placeholder={line === 'reward' ? 'Dinner, on them' : 'Coffee for everyone, for a week'}
            maxLength={120}
            minRows={1}
            maxRows={4}
            aria-label={line === 'reward' ? 'What they owe you' : 'What you owe them'}
          />
        ) : (
          friends.map((f) => {
            const person = personOf(profiles, f)
            const label = line === 'reward' ? `${name(f)} owes you…` : `You owe ${name(f)}…`
            return (
              <div className="sk-field" key={f}>
                <div className="sk-field__label">
                  <Avatar name={person.name} color={person.color} photo={person.photo} size={22} />
                  <span className="sk-field__who">
                    <strong>{label}</strong>
                  </span>
                </div>
                <TextArea
                  value={draft.per[f]?.[line] ?? ''}
                  onChange={(v) => setPer(f, line, v)}
                  placeholder={line === 'reward' ? 'Lunch, on them' : 'A coffee'}
                  maxLength={120}
                  minRows={1}
                  maxRows={4}
                  aria-label={label}
                />
              </div>
            )
          })
        )}
      </Section>
    )
  }

  const stillMissing = missing.filter((f) => friends.includes(f) && ((draft.rewardMode === 'each' && !draft.per[f]?.reward.trim()) || (draft.penaltyMode === 'each' && !draft.per[f]?.penalty.trim())))
  const missingLine = missingTextsLine(
    stillMissing,
    draft.rewardMode === 'each' && stillMissing.some((f) => !draft.per[f]?.reward.trim()),
    draft.penaltyMode === 'each' && stillMissing.some((f) => !draft.per[f]?.penalty.trim()),
    name,
  )
  const counts = DEAL_COUNTS[draft.unit]

  return (
    <Screen
      title={replace ? 'Edit Deal' : 'New Deal'}
      titleDisplay="inline"
      leading={<GlassButton icon="xmark" aria-label="Cancel" onClick={() => void cancel()} />}
      trailing={
        busy ? (
          <span className="s-bar-spinner">
            <ActivityIndicator color="var(--secondary-label)" label="Proposing" />
          </span>
        ) : (
          <GlassButton prominent icon="checkmark" aria-label="Propose" onClick={() => void propose()} disabled={!!problem} />
        )
      }
    >
      {error && (
        <p className="dl-editor-error">
          <ErrorText>{error}</ErrorText>
        </p>
      )}
      <Section header="How long?" footer={footerWith('length', editorLengthFooter(draft.unit, space.threshold, start, by, nowMs, space.timezone))}>
        <div className="sk-mode">
          <SegmentedControl<DealUnit> size="small" aria-label="Unit" options={UNITS} value={draft.unit} onChange={(unit) => set({ unit })} />
        </div>
        <Row
          title="Length"
          accessory={
            <label className="dl-capsule">
              <span className="dl-capsule__text">{dealLengthText(draft.unit, draft.count)}</span>
              <Icon name="chevronUp" size={10} weight={2.6} className="dl-capsule__up" />
              <Icon name="chevronDown" size={10} weight={2.6} className="dl-capsule__down" />
              <select className="dl-capsule__select" aria-label="Length" value={draft.count} onChange={(e) => set({ count: Number(e.currentTarget.value) })}>
                {counts.map((n) => (
                  <option key={n} value={n}>
                    {dealLengthText(draft.unit, n)}
                  </option>
                ))}
              </select>
            </label>
          }
        />
      </Section>
      {lineSection('reward')}
      {lineSection('penalty')}
      <p className="sk-editor-footer">
        {problemNote('footer')}
        {[EDITOR_FOOTER, missingLine].filter(Boolean).join(' ')}
      </p>
    </Screen>
  )
}
