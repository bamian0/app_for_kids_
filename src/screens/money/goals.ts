// How a goal reads in the list and in its sheet.
import { formatMoney } from '../../domain/money.ts'
import type { FundedGoal } from '../../domain/money.ts'
import type { CurrencyCode } from '../../domain/types.ts'
import { weeksText } from './format.ts'

/** "$1,550 to go · ≈ 6 weeks at your pace", "$1,550 to go", or "Funded". */
export function goalLine(f: FundedGoal, currency: CurrencyCode): string {
  if (f.complete) return 'Funded'
  const left = `${formatMoney(f.left, currency)} to go`
  return f.etaWeeks !== null && f.etaWeeks > 0 ? `${left} · ${weeksText(f.etaWeeks)} at your pace` : left
}
