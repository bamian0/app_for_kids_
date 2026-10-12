// Currency picker. Changing it relabels every amount; nothing is converted.
import { setCurrency } from '../../data/api.ts'
import { CURRENCIES, currencySymbol } from '../../domain/money.ts'
import type { CurrencyCode } from '../../domain/types.ts'
import { GlassButton, Row, Screen, Section, cx, useToast } from '../../ui/index.ts'
import { errorText } from './write.ts'

export interface CurrencySheetProps {
  currency: CurrencyCode
  close: () => void
}

export function CurrencySheet({ currency, close }: CurrencySheetProps) {
  const toast = useToast()
  // The device's default may be one the list doesn't have; it still shows, checked, on top.
  const options = CURRENCIES.some((c) => c.code === currency) ? CURRENCIES : [{ code: currency, name: currency }, ...CURRENCIES]

  const pick = (code: CurrencyCode) => {
    close()
    if (code === currency) return
    setCurrency(code).catch((e: unknown) => toast({ title: 'Couldn’t change the currency', message: errorText(e), tone: 'error' }))
  }

  return (
    <Screen title="Currency" titleDisplay="inline" leading={<GlassButton icon="xmark" aria-label="Close" onClick={close} />}>
      <Section footer="Your amounts keep their numbers in the new currency. Nothing is converted.">
        {options.map((c) => (
          <Row
            key={c.code}
            leading={
              <span className={cx('m-symbol', currencySymbol(c.code).length > 2 && 'is-long')} aria-hidden>
                {currencySymbol(c.code)}
              </span>
            }
            title={c.name}
            detail={c.code}
            checked={c.code === currency}
            onPress={() => pick(c.code)}
          />
        ))}
      </Section>
    </Screen>
  )
}
