// Check In (SPEC §11.9.5): your part for the week the sheet opened on, a large number with the goal's unit, and an
// optional one-line note. Saving replaces that week's check-in. When the week ends while the sheet is open, the save
// is refused with "That week just ended…": the sheet moves to the new week, keeping what you typed.
import { useEffect, useState } from 'react'
import { checkIn, useAuth, useCheckins, useSharedGoal } from '../../data/api.ts'
import { now } from '../../domain/clock.ts'
import { currencySymbol } from '../../domain/money.ts'
import {
  amountProblem,
  amountProblemText,
  CHECKIN_NOTE_MAX,
  goalWeek,
  isCurrencyUnit,
  noteProblem,
  noteProblemText,
  parseGoalAmount,
} from '../../domain/shared.ts'
import type { CurrencyCode, SharedGoal } from '../../domain/types.ts'
import { ActivityIndicator, GlassButton, Screen, Section, TextFieldRow, cx, useToast } from '../../ui/index.ts'
import { ErrorText } from '../components/Bits.tsx'
import { checkedInToast, checkinFooter, checkinHeader, WEEK_ENDED } from './copy.ts'
import { editText, errorText } from './parts.tsx'

interface Props {
  goal: SharedGoal
  close: () => void
  /** This save reached the target: the moment plays where the goal is shown (instead of a toast). */
  onReached?: () => void
}

export function CheckInSheet({ goal: initial, close, onReached }: Props) {
  const { uid: me } = useAuth()
  const toast = useToast()
  const goal = useSharedGoal(initial.id).data ?? initial
  const [week, setWeek] = useState(() => goalWeek(initial, now()))
  const checkins = useCheckins(goal.id, week)
  const mine = (checkins.data ?? []).find((c) => c.uid === me && c.weekId === week) ?? null
  const [text, setText] = useState('')
  const [note, setNote] = useState('')
  const [touched, setTouched] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Editing: the field starts with what you checked in, once it loads (unless you've typed already).
  useEffect(() => {
    if (touched || !mine) return
    setText(editText(mine.amount))
    setNote(mine.note)
  }, [mine, touched])

  const amount = parseGoalAmount(text)
  const problem = text.trim() === '' ? null : amountProblem(text)
  const long = noteProblem(note)
  const ready = text.trim() !== '' && problem === null && long === null
  const money = isCurrencyUnit(goal.unit)

  const save = async () => {
    if (!ready || busy || amount === null) return
    setBusy(true)
    setError(null)
    try {
      const result = await checkIn(goal.id, amount, note, week)
      close()
      if (result.reached) onReached?.()
      else {
        const copy = checkedInToast(goal, result.total)
        toast({
          title: copy.title,
          message: copy.message,
          icon: 'checkmark',
          tone: 'success',
        })
      }
    } catch (e) {
      const message = errorText(e, 'Couldn’t check in. Try again.')
      // The week ended under the sheet: move to the new one, keeping what was typed.
      const current = goalWeek(goal, now())
      if (message === WEEK_ENDED || current !== week) {
        setWeek(current)
        setTouched(true)
      }
      setError(message)
      setBusy(false)
    }
  }

  const edit = (setter: (v: string) => void) => (v: string) => {
    setTouched(true)
    setError(null)
    setter(v)
  }

  return (
    <Screen
      title="Check In"
      titleDisplay="inline"
      leading={<GlassButton icon="xmark" aria-label="Cancel" onClick={close} />}
      trailing={
        busy ? (
          <span className="s-bar-spinner">
            <ActivityIndicator color="var(--secondary-label)" label="Saving" />
          </span>
        ) : (
          <GlassButton prominent icon="checkmark" aria-label="Save" onClick={() => void save()} disabled={!ready} />
        )
      }
    >
      <Section
        header={checkinHeader(goal.name, week)}
        footer={
          <>
            {(error || problem) && (
              <span className="sg-footer-error">
                <ErrorText>{error ?? amountProblemText(problem!)}</ErrorText>
              </span>
            )}
            {checkinFooter(goal, mine, amount)}
          </>
        }
      >
        <label className={cx('sg-amount', problem && 'is-invalid')}>
          {money && <span className="sg-amount__unit sg-amount__unit--before">{currencySymbol(goal.unit as CurrencyCode)}</span>}
          <span className="sg-amount__sizer" data-text={text || '0'}>
            <input
              className="sg-amount__input"
              type="text"
              inputMode="decimal"
              enterKeyHint="done"
              autoComplete="off"
              autoCorrect="off"
              spellCheck={false}
              autoFocus
              value={text}
              placeholder="0"
              aria-label={`Your part in ${goal.unit}`}
              aria-invalid={problem ? true : undefined}
              onChange={(e) => edit(setText)(e.currentTarget.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.nativeEvent.isComposing) e.currentTarget.blur()
              }}
            />
          </span>
          {!money && <span className="sg-amount__unit">{goal.unit}</span>}
        </label>
      </Section>

      <Section header="Note (optional)" footer={long ? <ErrorText>{noteProblemText(long)}</ErrorText> : undefined}>
        <TextFieldRow
          value={note}
          onChange={edit(setNote)}
          placeholder="Long run on Sunday"
          aria-label="Note"
          maxLength={CHECKIN_NOTE_MAX}
          autoCapitalize="sentences"
          enterKeyHint="done"
        />
      </Section>
    </Screen>
  )
}
