// Add Money / Remove Money: an amount and an optional note. A removal is a spend; both can be undone
// from the activity list with a swipe.
import { useState } from 'react'
import { addMove } from '../../data/api.ts'
import { formatMoney, roundMoney } from '../../domain/money.ts'
import type { CurrencyCode } from '../../domain/types.ts'
import { GlassButton, Screen, Section, TextFieldRow, useToast } from '../../ui/index.ts'
import { ErrorText } from '../components/Bits.tsx'
import { MoneyField } from '../components/MoneyField.tsx'
import { errorText, quickWrite } from './write.ts'

export interface MoveSheetProps {
  kind: 'add' | 'spend'
  currency: CurrencyCode
  /** The balance now, to show what it will be. */
  balance: number
  close: () => void
}

const MAX_NOTE = 80

export function MoveSheet({ kind, currency, balance, close }: MoveSheetProps) {
  const toast = useToast()
  const [amount, setAmount] = useState<number | null>(null)
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const adding = kind === 'add'
  const valid = amount !== null && amount > 0

  const save = async () => {
    if (!valid || busy) return
    setBusy(true)
    setError(null)
    try {
      await quickWrite(addMove(kind, amount, note.trim()), (e) =>
        toast({ title: adding ? 'Couldn’t add the money' : 'Couldn’t remove the money', message: errorText(e), tone: 'error' }),
      )
      close()
    } catch (e) {
      setError(errorText(e))
      setBusy(false)
    }
  }

  const after = valid ? roundMoney(balance + (adding ? amount : -amount)) : null
  const footer = error ? (
    <ErrorText>{error}</ErrorText>
  ) : after !== null ? (
    `Your balance will be ${formatMoney(after, currency)}.`
  ) : adding ? (
    'Money that came in outside your tasks, like a gift or a sale.'
  ) : (
    'Money you spent or moved out. It comes off your balance.'
  )

  return (
    <Screen
      title={adding ? 'Add Money' : 'Remove Money'}
      titleDisplay="inline"
      leading={<GlassButton icon="xmark" aria-label="Cancel" onClick={close} />}
      trailing={<GlassButton prominent icon="checkmark" aria-label={adding ? 'Add' : 'Remove'} disabled={!valid || busy} onClick={() => void save()} />}
    >
      <Section footer={footer}>
        <MoneyField label="Amount" value={amount} onChange={setAmount} currency={currency} autoFocus />
        <TextFieldRow
          className="m-field-end"
          label={adding ? 'Note' : 'What for?'}
          value={note}
          onChange={setNote}
          placeholder="Optional"
          maxLength={MAX_NOTE}
          autoCapitalize="sentences"
          enterKeyHint="done"
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.nativeEvent.isComposing) void save()
          }}
        />
      </Section>
    </Screen>
  )
}
