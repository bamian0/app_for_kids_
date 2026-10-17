// "Your Stakes" (SPEC §9.7): your reward line and your penalty line, each Same for Everyone or Different per
// Friend, and your streak rewards. Saving says when the change counts: now, or as soon as the friends who
// still have to agree do.
import { useEffect, useRef, useState } from 'react'
import { saveMyStakes, useAuth, useProfiles, useStakes } from '../../data/api.ts'
import { now as appNow } from '../../domain/clock.ts'
import { spaceJudges } from '../../domain/scoring.ts'
import { MAX_TIERS, TIER_CHOICES } from '../../domain/stakes.ts'
import type { MemberStakes, Space, StakesMode, UID } from '../../domain/types.ts'
import { Avatar, GlassButton, Icon, Row, Screen, Section, SegmentedControl, TextArea, useAlert, useToast } from '../../ui/index.ts'
import { firstName, nameOf, personOf } from '../components/people.ts'
import { SwipeToDelete } from '../components/SwipeToDelete.tsx'
import { draftChanged, draftFrom, draftInput, draftValid, EDITOR_FOOTER, friendsOf, houseOf, saveMessage, stakesAfterSave, switchMode, termsNow, TIERS_FOOTER, unusedTierChoices, waitingAfterSave } from './stakes.ts'
import type { EditorDraft, TermsNow } from './stakes.ts'
import './stakes.css'

export interface StakesEditorSheetProps {
  space: Space
  /** Your stakes doc, when you have one: the editor starts from it (else from the house stakes, the same for everyone). */
  own?: MemberStakes
  /** When changes count (termsNow with this week's doc and this month's list); from the space alone without it. */
  now?: TermsNow
  /** Open with this friend's fields in view ("Add your stakes for Kim"). */
  focus?: UID
  close: () => void
}

type LineKey = 'reward' | 'penalty'

const MODES = [
  { value: 'group' as const, label: 'Same for Everyone' },
  { value: 'each' as const, label: 'Different per Friend' },
]

export function StakesEditorSheet({ space, own, now, focus, close }: StakesEditorSheetProps) {
  const { uid } = useAuth()
  const me = uid ?? ''
  const toast = useToast()
  const { actionSheet } = useAlert()
  const live = useStakes(space)
  // Everyone else in the space, in join order; judges too (their fields are optional).
  const friends = space.memberIds.filter((id) => id !== me).sort((a, b) => (space.joinedAt[a] ?? 0) - (space.joinedAt[b] ?? 0))
  const judges = spaceJudges(space)
  const profiles = useProfiles(friends)
  const name = (id: UID) => firstName(nameOf(profiles, id))

  // Opened before your stakes had loaded (no `own`): start from them once they arrive, unless you started typing.
  const mine = own ?? live.data?.[me]
  const [initial, setInitial] = useState(() => draftFrom(mine, houseOf(space), friends))
  const [draft, setDraft] = useState<EditorDraft>(initial)
  const [seeded, setSeeded] = useState(own !== undefined || live.data !== undefined)
  if (!seeded && live.data !== undefined) {
    setSeeded(true)
    if (draft === initial) {
      const next = draftFrom(live.data[me], houseOf(space), friends)
      setInitial(next)
      setDraft(next)
    }
  }
  const [busy, setBusy] = useState(false)
  const tierFields = useRef(new Map<number, HTMLTextAreaElement>())
  const [focusTier, setFocusTier] = useState<number | null>(null)
  const focusRef = useRef<HTMLDivElement>(null)

  const valid = draftValid(draft, friends, judges)
  const dirty = draftChanged(draft, initial, friends)

  // "Add your stakes for Kim": bring that friend's fields into view.
  useEffect(() => {
    if (focus) focusRef.current?.scrollIntoView({ block: 'center' })
  }, [focus])
  useEffect(() => {
    if (focusTier === null) return
    tierFields.current.get(focusTier)?.focus()
    setFocusTier(null)
  }, [focusTier])

  const save = async () => {
    if (!valid || busy) return
    if (mine && !dirty) {
      close()
      return
    }
    const input = draftInput(draft, friends)
    setBusy(true)
    try {
      await saveMyStakes(space, input)
      const nowMs = appNow()
      const when = now ?? termsNow(space, nowMs)
      const shown = friendsOf(space, me, when).filter((f) => space.memberIds.includes(f))
      const after = stakesAfterSave(me, input, live.data?.[me] ?? mine, nowMs)
      const waiting = waitingAfterSave(space, me, after, live.data, when).map(name)
      toast({ title: 'Saved', message: saveMessage(waiting, shown.length, when), icon: 'checkmark', tone: 'success' })
      close()
    } catch (e) {
      toast({ title: 'Couldn’t save your stakes', message: e instanceof Error ? e.message : undefined, tone: 'error' })
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

  const setLine = (line: LineKey, text: string) => setDraft((d) => ({ ...d, [line]: text }))
  const setPer = (friend: UID, line: LineKey, text: string) =>
    setDraft((d) => ({ ...d, per: { ...d.per, [friend]: { ...(d.per[friend] ?? { reward: '', penalty: '' }), [line]: text } } }))
  const setMode = (line: LineKey, mode: StakesMode) => setDraft((d) => switchMode(d, line, mode))

  const addTier = async () => {
    const choices = unusedTierChoices(TIER_CHOICES, draft.tiers)
    const choice = await actionSheet({ title: 'How many months in a row?', actions: choices.map((m) => ({ label: `${m} months` })) })
    const months = choices.find((m) => `${m} months` === choice)
    if (months === undefined) return
    setDraft((d) => ({ ...d, tiers: [...d.tiers, { months, reward: '' }].sort((a, b) => a.months - b.months) }))
    setFocusTier(months)
  }
  const removeTier = (months: number) => setDraft((d) => ({ ...d, tiers: d.tiers.filter((t) => t.months !== months) }))
  const setTier = (months: number, reward: string) => setDraft((d) => ({ ...d, tiers: d.tiers.map((t) => (t.months === months ? { ...t, reward } : t)) }))

  const lineSection = (line: LineKey) => {
    const mode = line === 'reward' ? draft.rewardMode : draft.penaltyMode
    const header = line === 'reward' ? `If you hit ${space.threshold}%, they owe you…` : 'If you miss, you owe them…'
    const footer =
      line === 'reward'
        ? mode === 'group'
          ? 'One thing from the whole group, together.'
          : 'Each friend owes you their own.'
        : mode === 'group'
          ? 'One thing you give the group.'
          : 'You owe each friend their own.'
    return (
      <Section header={header} footer={friends.length > 0 ? footer : undefined}>
        <div className="sk-mode">
          <SegmentedControl<StakesMode>
            size="small"
            aria-label={line === 'reward' ? 'Reward' : 'Penalty'}
            options={MODES}
            value={mode}
            onChange={(m) => setMode(line, m)}
          />
        </div>
        {mode === 'group' ? (
          <TextArea
            value={draft[line]}
            onChange={(v) => setLine(line, v)}
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
              <div className="sk-field" key={f} ref={f === focus ? focusRef : undefined}>
                <div className="sk-field__label">
                  <Avatar name={person.name} color={person.color} photo={person.photo} size={22} />
                  <span className="sk-field__who">
                    <strong>{label}</strong>
                    {judges.includes(f) && <span>Judging now, so nothing’s owed for now</span>}
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

  return (
    <Screen
      title="Your Stakes"
      titleDisplay="inline"
      leading={<GlassButton icon="xmark" aria-label="Cancel" onClick={() => void cancel()} />}
      trailing={<GlassButton prominent icon="checkmark" aria-label="Save" onClick={() => void save()} disabled={!valid || busy} />}
    >
      {lineSection('reward')}
      {lineSection('penalty')}
      <Section header="Streak rewards" footer={TIERS_FOOTER}>
        <div className="sk-tiers">
          {draft.tiers.map((t) => (
            <SwipeToDelete key={t.months} onDelete={() => removeTier(t.months)}>
              <div className="sk-tier">
                <div className="sk-tier__head">
                  <span className="sk-tier__icon" aria-hidden>
                    <Icon name="sparkles" size={14} weight={2.2} />
                  </span>
                  <span className="sk-tier__title">{t.months} months in a row</span>
                  <button type="button" className="sk-tier__remove" aria-label={`Remove the ${t.months}-month reward`} onClick={() => removeTier(t.months)}>
                    <Icon name="xmarkCircleFill" size={20} />
                  </button>
                </div>
                <TextArea
                  textareaRef={(el) => {
                    if (el) tierFields.current.set(t.months, el)
                    else tierFields.current.delete(t.months)
                  }}
                  value={t.reward}
                  onChange={(v) => setTier(t.months, v)}
                  placeholder="A weekend away"
                  maxLength={120}
                  minRows={1}
                  maxRows={3}
                  aria-label={`Reward for ${t.months} months in a row`}
                />
              </div>
            </SwipeToDelete>
          ))}
        </div>
        {draft.tiers.length < MAX_TIERS && (
          <Row
            leading={
              <span className="sk-action-icon" aria-hidden>
                <Icon name="plus" size={20} weight={2.2} />
              </span>
            }
            title="Add Streak Reward"
            action
            onPress={() => void addTier()}
          />
        )}
      </Section>
      <p className="sk-editor-footer">{EDITOR_FOOTER}</p>
    </Screen>
  )
}
