// Set Balance: "I have this much now". Everything earned or moved before is assumed to be in it.
import { useState } from 'react'
import { setBaseline } from '../../data/api.ts'
import type { CurrencyCode } from '../../domain/types.ts'
import { GlassButton, Screen, Section, useToast } from '../../ui/index.ts'
import { ErrorText } from '../components/Bits.tsx'
import { MoneyField } from '../components/MoneyField.tsx'
import { errorText, quickWrite } from './write.ts'

export interface BalanceSheetProps {
  currency: CurrencyCode
  /** The balance now; the field starts with it. */
  balance: number
  close: () => void
}

export function BalanceSheet({ currency, balance, close }: BalanceSheetProps) {
  const toast = useToast()
  const [amount, setAmount] = useState<number | null>(balance > 0 ? balance : null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const save = async () => {
    if (amount === null || busy) return
    setBusy(true)
    setError(null)
    try {
      await quickWrite(setBaseline(amount), (e) => toast({ title: 'Couldn’t set your balance', message: errorText(e), tone: 'error' }))
      close()
    } catch (e) {
      setError(errorText(e))
      setBusy(false)
    }
  }

  return (
    <Screen
      title="Set Balance"
      titleDisplay="inline"
      leading={<GlassButton icon="xmark" aria-label="Cancel" onClick={close} />}
      trailing={<GlassButton prominent icon="checkmark" aria-label="Save" disabled={amount === null || busy} onClick={() => void save()} />}
    >
      <Section
        footer={
          error ? (
            <ErrorText>{error}</ErrorText>
          ) : (
            'What you have right now, across your accounts and cash. Money you add, spend or earn from tasks after this keeps it up to date.'
          )
        }
      >
        <MoneyField label="Balance" value={amount} onChange={setAmount} currency={currency} autoFocus />
      </Section>
    </Screen>
  )
}
