// Pieces the shared-goal screens share: the goal form (name, target, unit, end date), the friend picker with its
// check circles, a row with its own trailing controls, and small helpers.
import { useMemo, useRef } from 'react'
import type { ReactNode } from 'react'
import { useFriendships, useProfiles } from '../../data/api.ts'
import { SHARED_NAME_MAX, SHARED_UNIT_MAX, SHARED_UNITS } from '../../domain/shared.ts'
import type { UID, UserProfile } from '../../domain/types.ts'
import { Avatar, Icon, Row, Section, TextFieldRow, cx } from '../../ui/index.ts'
import { usePress } from '../../ui/press.ts'
import { ErrorText } from '../components/Bits.tsx'
import { personOf } from '../components/people.ts'
import type { Person } from '../components/people.ts'
import { dayText, unitChips } from './copy.ts'

export function errorText(e: unknown, fallback = 'Couldn’t do that. Try again.'): string {
  return e instanceof Error && e.message ? e.message : fallback
}

/** How an amount is edited: "12", "12.5", "1250.25" (never grouped, never trailing zeros). */
export function editText(x: number): string {
  return Number.isFinite(x) ? String(Number(x.toFixed(2))) : ''
}

/** A person, or "A former member" (`former`) when their profile is gone. */
export function personOrFormer(profiles: Record<UID, UserProfile>, uid: UID, former: boolean, formerName: string): Person {
  const person = personOf(profiles, uid)
  return former && !profiles[uid] ? { ...person, name: formerName } : person
}

// ---------- A row with its own controls ----------

interface GoalRowProps {
  title: ReactNode
  /** Under the title (the team bar). */
  middle?: ReactNode
  subtitle?: ReactNode
  /** Trailing controls (Check In); they stay tappable on their own. */
  trailing?: ReactNode
  /** Controls under the text (an invitation's Join and Decline). */
  below?: ReactNode
  chevron?: boolean
  /** The whole row is the target, except the controls. */
  onOpen: () => void
  label: string
}

/** A list row whose trailing buttons don't open the row (like the Friends tab's person rows). */
export function OpenRow({ title, middle, subtitle, trailing, below, chevron, onOpen, label }: GoalRowProps) {
  const { pressed, handlers } = usePress(true)
  return (
    <div className={cx('ui-row sg-open', subtitle != null && 'ui-row--subtitle')} data-pressed={pressed || undefined}>
      <button type="button" className="sg-open__target" aria-label={label} onClick={onOpen} {...handlers} />
      <span className="ui-row__main">
        <span className="ui-row__text">
          <span className="ui-row__title">{title}</span>
          {middle}
          {subtitle != null && <span className="ui-row__subtitle">{subtitle}</span>}
          {below && <span className="sg-open__below">{below}</span>}
        </span>
        {trailing && <span className="ui-row__accessory sg-open__trailing">{trailing}</span>}
        {chevron && <Icon name="chevronRight" size={20} weight={2.6} className="ui-row__chevron" />}
      </span>
    </div>
  )
}

// ---------- Friends to invite ----------

export interface FriendItem {
  uid: UID
  person: Person
}

/** Your friends with a profile, by name; `loaded` once the pairs are in. */
export function useFriendsList(): { friends: FriendItem[]; loaded: boolean } {
  const live = useFriendships()
  const uids = useMemo(() => (live.data?.friends ?? []).map((p) => p.uid), [live.data])
  const profiles = useProfiles(uids)
  const friends = useMemo(
    () =>
      uids
        .filter((uid) => profiles[uid])
        .map((uid) => ({ uid, person: personOf(profiles, uid) }))
        .sort((a, b) => a.person.name.localeCompare(b.person.name) || (a.uid < b.uid ? -1 : 1)),
    [uids, profiles],
  )
  return { friends, loaded: live.data !== undefined }
}

/** The iOS selection circle: empty, or filled with a check. */
export function SelectCircle({ on, dim }: { on: boolean; dim?: boolean }) {
  return (
    <span className={cx('sg-select', on && 'is-on', dim && 'is-dim')} aria-hidden>
      {on && <Icon name="checkmark" size={13} weight={3.2} />}
    </span>
  )
}

/** Friends with check circles, at most `max` picked; the rest dim once the limit is reached. */
export function FriendPicker({
  friends,
  selected,
  onToggle,
  max,
  header,
  footer,
  empty,
}: {
  friends: FriendItem[]
  selected: UID[]
  onToggle: (uid: UID) => void
  max: number
  header?: string
  footer?: ReactNode
  /** Shown as a quiet row when there's nobody to pick. */
  empty: string
}) {
  const full = selected.length >= max
  return (
    <Section header={header} footer={friends.length > 0 ? footer : undefined}>
      {friends.length === 0 ? (
        <Row title={empty} className="sg-quiet-row" />
      ) : (
        friends.map(({ uid, person }) => {
          const on = selected.includes(uid)
          const off = !on && full
          return (
            <Row
              key={uid}
              title={person.name}
              leading={<Avatar name={person.name} color={person.color} photo={person.photo} size={32} />}
              accessory={<SelectCircle on={on} dim={off} />}
              onPress={() => onToggle(uid)}
              disabled={off}
              aria-label={`${person.name}${on ? ', selected' : ''}`}
              className="sg-pick"
            />
          )
        })
      )}
    </Section>
  )
}

// ---------- The goal form ----------

export interface GoalDraft {
  name: string
  target: string
  unit: string
  /** The End Date toggle. */
  ends: boolean
  /** 'YYYY-MM-DD' while `ends`. */
  endsOn: string
}

export interface GoalErrors {
  name?: string | null
  target?: string | null
  unit?: string | null
}

/** Name, target with unit chips, and the optional end date: New Shared Goal and Edit Goal. */
export function GoalFields({
  draft,
  onChange,
  currency,
  errors,
  targetFooter,
  minDay,
  nowMs,
  autoFocus,
  targetRef,
}: {
  draft: GoalDraft
  onChange: (next: GoalDraft) => void
  currency: string
  errors: GoalErrors
  targetFooter?: ReactNode
  /** The earliest end date ('YYYY-MM-DD'). */
  minDay: string
  nowMs: number
  autoFocus?: 'name' | 'target'
  targetRef?: React.Ref<HTMLInputElement>
}) {
  const set = (patch: Partial<GoalDraft>) => onChange({ ...draft, ...patch })
  const chips = unitChips(SHARED_UNITS, currency)
  const unitRef = useRef<HTMLInputElement>(null)
  const targetError = errors.target ?? errors.unit
  return (
    <>
      <Section header="Goal" footer={errors.name ? <ErrorText>{errors.name}</ErrorText> : undefined}>
        <TextFieldRow
          value={draft.name}
          onChange={(name) => set({ name })}
          placeholder="Run 100 km"
          aria-label="Goal name"
          maxLength={SHARED_NAME_MAX}
          autoCapitalize="sentences"
          autoFocus={autoFocus === 'name'}
          enterKeyHint="next"
        />
      </Section>

      <Section header="Target" footer={targetError ? <ErrorText>{targetError}</ErrorText> : targetFooter}>
        <TextFieldRow
          className="sg-field-end"
          label="Amount"
          labelWidth={72}
          value={draft.target}
          onChange={(target) => set({ target })}
          placeholder="100"
          inputMode="decimal"
          autoComplete="off"
          autoCorrect="off"
          spellCheck={false}
          enterKeyHint="next"
          autoFocus={autoFocus === 'target'}
          inputRef={targetRef}
          aria-invalid={errors.target ? true : undefined}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.nativeEvent.isComposing) unitRef.current?.focus()
          }}
        />
        <TextFieldRow
          className="sg-field-end"
          label="Unit"
          labelWidth={72}
          value={draft.unit}
          onChange={(unit) => set({ unit })}
          placeholder="km"
          maxLength={SHARED_UNIT_MAX}
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          enterKeyHint="done"
          inputRef={unitRef}
        />
        <div className="sg-chips" role="group" aria-label="Units">
          {chips.map((u) => (
            <button
              key={u}
              type="button"
              className={cx('sg-chip', draft.unit.trim() === u && 'is-on')}
              aria-pressed={draft.unit.trim() === u}
              onClick={() => set({ unit: u })}
            >
              {u}
            </button>
          ))}
        </div>
      </Section>

      <Section footer="Optional. Check-ins stop after this day.">
        <Row title="End Date" toggle={draft.ends} onToggle={(ends) => set({ ends, endsOn: ends && !draft.endsOn ? minDay : draft.endsOn })} />
        {draft.ends && (
          <Row title="Last Day" accessory={<DateField value={draft.endsOn || minDay} min={minDay} nowMs={nowMs} onChange={(endsOn) => set({ endsOn })} />} />
        )}
      </Section>
    </>
  )
}

/** A compact date, like iOS's: the day in a gray capsule; the native picker opens on tap. */
export function DateField({ value, min, nowMs, onChange }: { value: string; min: string; nowMs: number; onChange: (day: string) => void }) {
  return (
    <span className="sg-date">
      <span className="sg-date__text" aria-hidden>
        {dayText(value, nowMs)}
      </span>
      <input
        className="sg-date__input"
        type="date"
        value={value}
        min={min}
        aria-label="Last day"
        onChange={(e) => {
          const next = e.currentTarget.value
          if (next) onChange(next < min ? min : next)
        }}
        onClick={(e) => {
          try {
            e.currentTarget.showPicker?.()
          } catch {
            // Some browsers only open it from their own control; tapping still focuses it.
          }
        }}
      />
    </span>
  )
}
