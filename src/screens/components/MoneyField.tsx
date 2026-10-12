// An amount as a form row, like a price field in Settings: label on the left, the amount on the right
// with its currency symbol, decimal keypad. The typed text stays as typed; the parent gets the number.
import { useId, useState } from 'react'
import type { ReactElement } from 'react'
import { currencySymbol, parseAmount } from '../../domain/money.ts'
import type { CurrencyCode } from '../../domain/types.ts'
import { cx } from '../../ui/index.ts'
import '../tasks.css'

export interface MoneyFieldProps {
  value: number | null
  onChange: (value: number | null) => void
  currency: CurrencyCode
  /** Row label on the left, e.g. "Amount". */
  label: string
  placeholder?: string
  autoFocus?: boolean
}

/** The text a stored amount is edited as: grouped, cents only when there are some ('1,250', '1,250.50'). */
function editText(value: number | null): string {
  if (value === null) return ''
  const cents = Math.round(value * 100) % 100 !== 0
  return value.toLocaleString('en-US', { minimumFractionDigits: cents ? 2 : 0, maximumFractionDigits: 2 })
}

export function MoneyField({ value, onChange, currency, label, placeholder = '0', autoFocus }: MoneyFieldProps): ReactElement {
  const id = useId()
  const [text, setText] = useState(() => editText(value))
  const [shown, setShown] = useState(value)
  // A new value from outside (loaded, reset) replaces the text, unless it is what the text already says.
  if (value !== shown) {
    setShown(value)
    if (parseAmount(text) !== value) setText(editText(value))
  }
  const invalid = text.trim() !== '' && parseAmount(text) === null

  return (
    // The whole row is the label, so a tap anywhere on it brings up the keypad.
    <label htmlFor={id} className="ui-row ui-row--field tk-money">
      <span className="ui-row__main">
        <span className="ui-row__field-label">{label}</span>
        <span className={cx('tk-money__value', text === '' && 'is-empty', invalid && 'is-invalid')}>
          <span className="tk-money__symbol" aria-hidden>
            {currencySymbol(currency)}
          </span>
          <span className="tk-money__sizer" data-text={text || placeholder}>
            <input
              id={id}
              className="tk-money__input"
              type="text"
              inputMode="decimal"
              enterKeyHint="done"
              autoComplete="off"
              autoCorrect="off"
              spellCheck={false}
              autoFocus={autoFocus}
              value={text}
              placeholder={placeholder}
              aria-label={`${label} in ${currency}`}
              aria-invalid={invalid || undefined}
              onChange={(e) => {
                const next = e.currentTarget.value
                const amount = parseAmount(next)
                setText(next)
                setShown(amount)
                onChange(amount)
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.nativeEvent.isComposing) e.currentTarget.blur()
              }}
              onBlur={() => {
                // Tidy what was typed ('1250.5' → '1,250.50'); a typo stays so it can be fixed.
                const amount = parseAmount(text)
                if (amount !== null) setText(editText(amount))
              }}
            />
          </span>
        </span>
      </span>
    </label>
  )
}
