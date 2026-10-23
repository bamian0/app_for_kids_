// "Streak Rewards" (SPEC §12.10, §9.8): what friends owe you, together, for this many months in a row at the bar,
// deal or not. Up to five, each length once. Saving says when they count: now, or once friends agree.
import { useEffect, useRef, useState } from 'react'
import { saveStreakRewards, useAuth, useProfiles, useStakes } from '../../data/api.ts'
import { MAX_TIERS, TIER_CHOICES } from '../../domain/stakes.ts'
import type { Space, StreakTier, UID } from '../../domain/types.ts'
import { GlassButton, Icon, Row, Screen, Section, TextArea, haptic, useAlert, useToast } from '../../ui/index.ts'
import { firstName, nameOf } from '../components/people.ts'
import { SwipeToDelete } from '../components/SwipeToDelete.tsx'
import { sameTierList, streakFooter, streakSaveMessage, streakWaiting } from './deals.ts'
import { playingFriends, unusedTierChoices } from './stakes.ts'
import './stakes.css'

export interface StreakRewardsSheetProps {
  space: Space
  close: () => void
}

const MAX_TEXT = 120

/** Saving is allowed: every reward filled and under 120, each length once. */
export function tiersValid(tiers: StreakTier[]): boolean {
  if (tiers.some((t) => t.reward.trim() === '' || t.reward.trim().length > MAX_TEXT)) return false
  return new Set(tiers.map((t) => t.months)).size === tiers.length
}

export function cleanTiers(tiers: StreakTier[]): StreakTier[] {
  return tiers.map((t) => ({ months: t.months, reward: t.reward.trim() })).sort((a, b) => a.months - b.months)
}

export function StreakRewardsSheet({ space, close }: StreakRewardsSheetProps) {
  const { uid } = useAuth()
  const me = uid ?? ''
  const toast = useToast()
  const { actionSheet } = useAlert()
  const live = useStakes(space)
  const own = live.data?.[me]
  const friends = playingFriends(space, me)
  const profiles = useProfiles(friends)
  const name = (id: UID) => firstName(nameOf(profiles, id))
  const [initial, setInitial] = useState<StreakTier[]>(() => own?.tiers.map((t) => ({ ...t })) ?? [])
  const [tiers, setTiers] = useState<StreakTier[]>(initial)
  const [seeded, setSeeded] = useState(live.data !== undefined)
  // Opened before your stakes doc had loaded: start from it once it arrives, unless you started typing.
  if (!seeded && live.data !== undefined) {
    setSeeded(true)
    if (tiers === initial) {
      const next = live.data[me]?.tiers.map((t) => ({ ...t })) ?? []
      setInitial(next)
      setTiers(next)
    }
  }
  const [busy, setBusy] = useState(false)
  const fields = useRef(new Map<number, HTMLTextAreaElement>())
  const [focusTier, setFocusTier] = useState<number | null>(null)
  useEffect(() => {
    if (focusTier === null) return
    fields.current.get(focusTier)?.focus()
    setFocusTier(null)
  }, [focusTier])

  const valid = tiersValid(tiers)
  const dirty = !sameTierList(cleanTiers(tiers), cleanTiers(initial))

  const save = async () => {
    if (!valid || busy) return
    if (!dirty) {
      close()
      return
    }
    const next = cleanTiers(tiers)
    setBusy(true)
    try {
      await saveStreakRewards(space, next)
      haptic()
      toast({ title: 'Saved', message: streakSaveMessage(streakWaiting(own, next, friends).map(name)), icon: 'checkmark', tone: 'success' })
      close()
    } catch (e) {
      toast({ title: 'Couldn’t save your streak rewards', message: e instanceof Error ? e.message : undefined, tone: 'error' })
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

  const add = async () => {
    const choices = unusedTierChoices(TIER_CHOICES, tiers)
    const choice = await actionSheet({ title: 'How many months in a row?', actions: choices.map((m) => ({ label: `${m} months` })) })
    const months = choices.find((m) => `${m} months` === choice)
    if (months === undefined) return
    setTiers((ts) => [...ts, { months, reward: '' }].sort((a, b) => a.months - b.months))
    setFocusTier(months)
  }
  const remove = (months: number) => setTiers((ts) => ts.filter((t) => t.months !== months))
  const set = (months: number, reward: string) => setTiers((ts) => ts.map((t) => (t.months === months ? { ...t, reward } : t)))

  return (
    <Screen
      title="Streak Rewards"
      titleDisplay="inline"
      leading={<GlassButton icon="xmark" aria-label="Cancel" onClick={() => void cancel()} />}
      trailing={<GlassButton prominent icon="checkmark" aria-label="Save" onClick={() => void save()} disabled={!valid || busy} />}
    >
      <Section footer={streakFooter(space.threshold, null)}>
        <div className="sk-tiers">
          {tiers.map((t) => (
            <SwipeToDelete key={t.months} onDelete={() => remove(t.months)}>
              <div className="sk-tier">
                <div className="sk-tier__head">
                  <span className="sk-tier__icon" aria-hidden>
                    <Icon name="sparkles" size={14} weight={2.2} />
                  </span>
                  <span className="sk-tier__title">{t.months} months in a row</span>
                  <button type="button" className="sk-tier__remove" aria-label={`Remove the ${t.months}-month reward`} onClick={() => remove(t.months)}>
                    <Icon name="xmarkCircleFill" size={20} />
                  </button>
                </div>
                <TextArea
                  textareaRef={(el) => {
                    if (el) fields.current.set(t.months, el)
                    else fields.current.delete(t.months)
                  }}
                  value={t.reward}
                  onChange={(v) => set(t.months, v)}
                  placeholder="A weekend away"
                  maxLength={MAX_TEXT}
                  minRows={1}
                  maxRows={3}
                  aria-label={`Reward for ${t.months} months in a row`}
                />
              </div>
            </SwipeToDelete>
          ))}
        </div>
        {tiers.length < MAX_TIERS && (
          <Row
            leading={
              <span className="sk-action-icon" aria-hidden>
                <Icon name="plus" size={20} weight={2.2} />
              </span>
            }
            title="Add Streak Reward"
            action
            onPress={() => void add()}
          />
        )}
      </Section>
    </Screen>
  )
}
