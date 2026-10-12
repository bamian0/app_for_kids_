// An amount as a form row, like a price field in Settings: label on the left, the amount on the right
// with its currency symbol, decimal keypad. The typed text stays as typed; the parent gets the number.
import { useId, useState } from 'react'
import type { ReactElement, Ref } from 'react'
import { currencySymbol, editableAmount, parseAmount } from '../../domain/money.ts'
import type { CurrencyCode } from '../../domain/types.ts'
import { cx } from '../../ui/index.ts'
import '../tasks.css'

export interface MoneyFieldProps {
  value: number | null
  /** `value` is null for an empty field and for text that isn't an amount; `invalid` tells them apart. */
  onChange: (value: number | null, invalid: boolean) => void
  currency: CurrencyCode
  /** Row label on the left, e.g. "Amount". */
  label: string
  placeholder?: string
  autoFocus?: boolean
  inputRef?: Ref<HTMLInputElement>
}

/** The text a stored amount is edited as: '1250', '1250.50', never grouped (see editableAmount). */
const editText = (value: number | null): string => (value === null ? '' : editableAmount(value))

export function MoneyField({ value, onChange, currency, label, placeholder = '0', autoFocus, inputRef }: MoneyFieldProps): ReactElement {
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
              ref={inputRef}
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
                onChange(amount, next.trim() !== '' && amount === null)
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.nativeEvent.isComposing) e.currentTarget.blur()
              }}
              onBlur={() => {
                // Tidy what was typed ('1250.5' → '1250.50', '1,250' → '1250'); a typo stays so it can be fixed.
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
