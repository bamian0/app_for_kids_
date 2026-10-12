// Money: amounts, balance, goals and earnings by week and month. See docs/SPEC.md §6.3.
// Amounts are plain numbers with at most 2 decimals; sums go through whole cents so they stay exact.
import { monthIdForWeek } from './time.ts'
import type { CurrencyCode, Earning, Goal, MoneyMove, MoneyState, MonthId, WeekId } from './types.ts'

export const MAX_AMOUNT = 1_000_000_000

const DEFAULT_LOCALE = 'en-US'
const DAY = 86_400_000
/** Pace looks back this far and reports per week. */
const PACE_DAYS = 28
/** Estimates longer than two years aren't worth showing. */
const MAX_ETA_WEEKS = 104

export const CURRENCIES: { code: CurrencyCode; name: string }[] = [
  { code: 'USD', name: 'US Dollar' },
  { code: 'EUR', name: 'Euro' },
  { code: 'GBP', name: 'British Pound' },
  { code: 'AMD', name: 'Armenian Dram' },
  { code: 'RUB', name: 'Russian Ruble' },
  { code: 'GEL', name: 'Georgian Lari' },
  { code: 'UAH', name: 'Ukrainian Hryvnia' },
  { code: 'CAD', name: 'Canadian Dollar' },
  { code: 'AUD', name: 'Australian Dollar' },
  { code: 'CHF', name: 'Swiss Franc' },
  { code: 'JPY', name: 'Japanese Yen' },
  { code: 'CNY', name: 'Chinese Yuan' },
  { code: 'INR', name: 'Indian Rupee' },
  { code: 'AED', name: 'UAE Dirham' },
  { code: 'TRY', name: 'Turkish Lira' },
  { code: 'PLN', name: 'Polish Zloty' },
  { code: 'SEK', name: 'Swedish Krona' },
  { code: 'NOK', name: 'Norwegian Krone' },
  { code: 'DKK', name: 'Danish Krone' },
  { code: 'CZK', name: 'Czech Koruna' },
  { code: 'HUF', name: 'Hungarian Forint' },
  { code: 'ILS', name: 'Israeli New Shekel' },
  { code: 'KRW', name: 'South Korean Won' },
  { code: 'BRL', name: 'Brazilian Real' },
  { code: 'MXN', name: 'Mexican Peso' },
  { code: 'ZAR', name: 'South African Rand' },
  { code: 'SGD', name: 'Singapore Dollar' },
  { code: 'HKD', name: 'Hong Kong Dollar' },
  { code: 'NZD', name: 'New Zealand Dollar' },
]

// Regions that use one of CURRENCIES, so the default is always one the currency picker lists.
const REGIONS: Record<CurrencyCode, string> = {
  USD: 'US PR GU VI AS MP UM EC SV TL FM MH PW BQ TC VG',
  EUR: '150 AT BE BG CY DE EE ES FI FR GR HR IE IT LT LU LV MT NL PT SI SK AD MC SM VA ME XK AX GF GP MQ RE YT PM BL MF',
  GBP: 'GB IM JE GG',
  AMD: 'AM',
  RUB: 'RU',
  GEL: 'GE',
  UAH: 'UA',
  CAD: 'CA',
  AUD: 'AU CX CC NF NR KI TV',
  CHF: 'CH LI',
  JPY: 'JP',
  CNY: 'CN',
  INR: 'IN',
  AED: 'AE',
  TRY: 'TR',
  PLN: 'PL',
  SEK: 'SE',
  NOK: 'NO SJ',
  DKK: 'DK GL FO',
  CZK: 'CZ',
  HUF: 'HU',
  ILS: 'IL',
  KRW: 'KR',
  BRL: 'BR',
  MXN: 'MX',
  ZAR: 'ZA',
  SGD: 'SG',
  HKD: 'HK',
  NZD: 'NZ CK NU PN TK',
}
const REGION_CURRENCY = new Map(Object.entries(REGIONS).flatMap(([code, regions]) => regions.split(' ').map((region) => [region, code] as const)))

/** From the locale's region (navigator.language when omitted and available), USD otherwise. A locale
 *  without a region uses its likely one ('de' → Germany → EUR). */
export function defaultCurrency(locale?: string): CurrencyCode {
  const tag = locale ?? (typeof navigator === 'undefined' ? undefined : navigator.language)
  if (!tag) return 'USD'
  try {
    const parsed = new Intl.Locale(tag.replace(/_/g, '-'))
    const region = parsed.region ?? parsed.maximize().region
    return (region && REGION_CURRENCY.get(region)) || 'USD'
  } catch {
    return 'USD'
  }
}

const formatters = new Map<string, Intl.NumberFormat>()

function currencyFormat(locale: string, currency: CurrencyCode, options: Intl.NumberFormatOptions = {}): Intl.NumberFormat {
  const key = `${locale}|${currency}|${JSON.stringify(options)}`
  let format = formatters.get(key)
  if (!format) {
    format = new Intl.NumberFormat(locale, { style: 'currency', currency, currencyDisplay: 'narrowSymbol', ...options })
    formatters.set(key, format)
  }
  return format
}

/** The currency's own minor digits: 2 for USD, 0 for JPY and KRW. */
function currencyDigits(currency: CurrencyCode): number {
  return currencyFormat(DEFAULT_LOCALE, currency).resolvedOptions().maximumFractionDigits ?? 2
}

/** Narrow symbol: '$', '€', '֏'. */
export function currencySymbol(currency: CurrencyCode, locale: string = DEFAULT_LOCALE): string {
  const part = currencyFormat(locale, currency).formatToParts(0).find((p) => p.type === 'currency')
  return part?.value ?? currency
}

/** Rounds half away from zero to `digits` decimals, after shaving float noise (1.005 → 1.01). */
function roundTo(n: number, digits: number): number {
  const scale = 10 ** digits
  const rounded = Math.round(Number((Math.abs(n) * scale).toPrecision(15)))
  // `|| 0` turns −0 into 0, so a rounded-away minus never shows.
  return (Math.sign(n) * rounded) / scale || 0
}

export function roundMoney(n: number): number {
  return roundTo(n, 2)
}

/** Whole cents; anything that isn't a finite number counts as nothing. */
function cents(amount: number): number {
  return Number.isFinite(amount) ? Math.round(roundMoney(amount) * 100) : 0
}

/**
 * '$1,250', '$1,250.50' (cents only when there are some, never for JPY or KRW). `signed` gives
 * '+$500' and '−$300' (zero stays unsigned); `compact` gives '$1.2K'. Negatives always use the
 * minus sign (−). The locale defaults to en-US, like the rest of the app's copy.
 */
export function formatMoney(amount: number, currency: CurrencyCode, opts: { signed?: boolean; compact?: boolean; locale?: string } = {}): string {
  const digits = currencyDigits(currency)
  const value = roundTo(Number.isFinite(amount) ? amount : 0, digits)
  const signDisplay = opts.signed ? 'exceptZero' : 'auto'
  let options: Intl.NumberFormatOptions
  if (opts.compact) {
    options = { notation: 'compact', signDisplay }
  } else {
    const hasMinor = digits > 0 && Math.round(Math.abs(value) * 10 ** digits) % 10 ** digits !== 0
    const shown = hasMinor ? digits : 0
    options = { minimumFractionDigits: shown, maximumFractionDigits: shown, signDisplay }
  }
  return currencyFormat(opts.locale ?? DEFAULT_LOCALE, currency, options)
    .formatToParts(value)
    .map((p) => (p.type === 'minusSign' ? '−' : p.value))
    .join('')
}

// Pasted amounts may carry a symbol or a code at either end: '$500', '500 USD', '€ 1.234,50'.
const SYMBOL_OR_CODE = `(?:\\p{Sc}|${CURRENCIES.map((c) => c.code).join('|')})+`
const AFFIX = new RegExp(`^${SYMBOL_OR_CODE}|${SYMBOL_OR_CODE}$`, 'giu')
// Spaces (\s includes no-break and thin ones) and apostrophes ('1’234') only ever group digits.
const GROUP_SPACE = /[\s'\u2019]/

/** Integer digits grouped by `separators`: '1,234,567', '1 234', and Indian '1,23,456'. */
function groupedDigits(text: string, separators: RegExp): string | null {
  const groups = text.split(separators)
  if (groups.length === 1) return /^\d*$/.test(text) ? text : null
  const [head, ...rest] = groups
  const ok =
    /^[1-9]\d{0,2}$/.test(head) &&
    rest.every((g, i) => (i === rest.length - 1 ? /^\d{3}$/.test(g) : /^\d{2,3}$/.test(g)))
  return ok ? groups.join('') : null
}

/**
 * Reads an amount the way people type or paste it: '1,234.50', '1.234,50', '1 234,5', '$500', '0'.
 * One '.' or ',' followed by exactly three digits groups thousands ('1,500' = 1500); otherwise it is
 * the decimal point ('1,5' = 1.5, '12.' = 12 while typing). Rounded to cents. null when empty,
 * not a number, negative or over MAX_AMOUNT.
 */
export function parseAmount(text: string): number | null {
  const s = text.trim().replace(/^\+/, '').replace(AFFIX, '').trim()
  if (!/^[\d.,\s'\u2019]+$/.test(s) || !/\d/.test(s)) return null

  const dots = s.split('.').length - 1
  const commas = s.split(',').length - 1
  let decimal: '.' | ',' | null = null
  if (dots > 0 && commas > 0) {
    // Both: the last one is the decimal point, and it appears once.
    decimal = s.lastIndexOf('.') > s.lastIndexOf(',') ? '.' : ','
    if ((decimal === '.' ? dots : commas) > 1) return null
  } else if (dots + commas === 1) {
    const sep = dots === 1 ? '.' : ','
    const [head, tail] = s.split(sep)
    const groupsThousands = tail.length === 3 && !GROUP_SPACE.test(s) && /^[1-9]\d{0,2}$/.test(head)
    decimal = groupsThousands ? null : sep
  }

  const at = decimal === null ? -1 : s.indexOf(decimal)
  const whole = at < 0 ? s : s.slice(0, at)
  const fraction = at < 0 ? '' : s.slice(at + 1)
  if (!/^\d*$/.test(fraction)) return null
  const group = decimal === '.' ? /[,\s'\u2019]/ : decimal === ',' ? /[.\s'\u2019]/ : /[.,\s'\u2019]/
  const digits = groupedDigits(whole, group)
  if (digits === null || (digits === '' && fraction === '')) return null

  const value = roundMoney(Number(`${digits || '0'}.${fraction || '0'}`))
  return value > MAX_AMOUNT ? null : value
}

/**
 * The text an amount is edited as: digits, '.' and cents only when there are some ('1250', '1250.50').
 * Not grouped: in '1,250' one more digit ('1,2500') or one less ('1,25') reads as a decimal comma, and
 * a comma keypad typing ',50' after it gives '1,250,50', which isn't an amount at all.
 */
export function editableAmount(value: number): string {
  const cents = Math.round(value * 100) % 100 !== 0
  return value.toLocaleString(DEFAULT_LOCALE, { minimumFractionDigits: cents ? 2 : 0, maximumFractionDigits: 2, useGrouping: false })
}

export function earningId(spaceId: string, weekId: WeekId, taskId: string): string {
  return `${spaceId}_${weekId}_${taskId}`
}

/** Moves and earnings after this instant count toward the balance; null counts everything. A baseline
 *  without its time yet (a pending write) was just set, so it already holds everything so far. */
function cutoffOf(state: MoneyState | null): number | null {
  if (state?.baseline == null) return null
  return state.baselineAt ?? Number.POSITIVE_INFINITY
}

/**
 * Whether money earned at `earnedAt` is already inside the balance the user set ("I have X now"):
 * earned at or before baselineAt. Un-doing its task then keeps it earned, or ticking the task again
 * would earn it after the baseline and count it twice.
 */
export function inBaseline(state: MoneyState | null, earnedAt: number | null): boolean {
  const cutoff = cutoffOf(state)
  return earnedAt !== null && cutoff !== null && earnedAt <= cutoff
}

function isEarned(e: Earning): e is Earning & { earnedAt: number } {
  return e.earnedAt !== null && e.earnedAt !== undefined
}

/** Positive for money in, negative for money out. */
function moveCents(m: MoneyMove): number {
  return m.kind === 'spend' ? -cents(m.amount) : cents(m.amount)
}

/**
 * baseline (0 if unset) + moves and earnings strictly after baselineAt (everything without a
 * baseline): what was earned or moved at or before it is already in the baseline. Can be negative.
 */
export function balanceOf(state: MoneyState | null, earnings: Earning[], moves: MoneyMove[]): number {
  const cutoff = cutoffOf(state)
  const after = (at: number) => cutoff === null || at > cutoff
  let total = state?.baseline != null ? cents(state.baseline) : 0
  for (const m of moves) if (after(m.at)) total += moveCents(m)
  for (const e of earnings) if (isEarned(e) && after(e.earnedAt)) total += cents(e.amount)
  return total / 100
}

/** Net money in over the last 28 days (earnings + adds − spends) ÷ 4. Goals marked as bought are left
 *  out: that money was saved earlier, so buying one doesn't slow the pace toward the others. Anything
 *  newer than `nowMs` counts too, so a server time slightly ahead of the device clock isn't left out. */
export function weeklyPace(earnings: Earning[], moves: MoneyMove[], nowMs: number): number {
  const since = nowMs - PACE_DAYS * DAY
  let total = 0
  for (const m of moves) if (m.at > since && !m.goal) total += moveCents(m)
  for (const e of earnings) if (isEarned(e) && e.earnedAt > since) total += cents(e.amount)
  return total / 100 / (PACE_DAYS / 7)
}

/** Weeks to save `needed` at `pace` per week: 0 when nothing is needed, null when there is no
 *  positive pace or it would take more than two years. */
export function etaWeeks(needed: number, pace: number): number | null {
  if (needed <= 0) return 0
  if (!(pace > 0) || !Number.isFinite(needed)) return null
  // The tolerance keeps float noise (1.1 / 0.1 = 11.000000000000002) from adding a week.
  const weeks = Math.max(1, Math.ceil(needed / pace - 1e-9))
  return weeks <= MAX_ETA_WEEKS ? weeks : null
}

export interface FundedGoal {
  goal: Goal
  funded: number
  /** 0..1 */
  progress: number
  left: number
  complete: boolean
  etaWeeks: number | null
}

function byGoalOrder(a: Goal, b: Goal): number {
  return a.order - b.order || a.createdAt - b.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
}

/**
 * Fills goals top first (by order, then createdAt): each takes what it can of what the ones above
 * left over. A goal's estimate is for everything still needed up to and including it, since the
 * money reaches it only after the goals above are funded.
 */
export function fundGoals(goals: Goal[], balance: number, pace: number): FundedGoal[] {
  let remaining = Math.max(0, cents(balance))
  let needed = 0
  return [...goals].sort(byGoalOrder).map((goal) => {
    const cost = Math.max(0, cents(goal.cost))
    const funded = Math.min(remaining, cost)
    remaining -= funded
    needed += cost - funded
    return {
      goal,
      funded: funded / 100,
      progress: cost === 0 ? 1 : funded / cost,
      left: (cost - funded) / 100,
      complete: funded === cost,
      etaWeeks: etaWeeks(needed / 100, pace),
    }
  })
}

/** Order for a new goal: after every existing one. */
export function nextGoalOrder(goals: Goal[]): number {
  const orders = goals.map((g) => g.order).filter(Number.isFinite)
  return orders.length === 0 ? 0 : Math.floor(Math.max(...orders)) + 1
}

/** Month of an earning's week; null for a malformed weekId, so one bad doc can't break a screen. */
function monthOf(weekId: WeekId): MonthId | null {
  try {
    return monthIdForWeek(weekId)
  } catch {
    return null
  }
}

function sum(earnings: Earning[]): number {
  return earnings.reduce((total, e) => total + cents(e.amount), 0) / 100
}

/** Earned amounts per week (only tasks that are done), 0 for a week without any. */
export function earnedByWeek(earnings: Earning[], weekIds: WeekId[]): Record<WeekId, number> {
  const out: Record<WeekId, number> = {}
  for (const weekId of weekIds) out[weekId] = sum(earnings.filter((e) => isEarned(e) && e.weekId === weekId))
  return out
}

/** Earned in the weeks that belong to `monthId` (the month of each week's Friday). */
export function earnedInMonth(earnings: Earning[], monthId: MonthId): number {
  return sum(earnings.filter((e) => isEarned(e) && monthOf(e.weekId) === monthId))
}

/** Revenue tasks in those weeks that aren't done yet. */
export function pendingIn(earnings: Earning[], weekIds: WeekId[]): number {
  return sum(earnings.filter((e) => !isEarned(e) && weekIds.includes(e.weekId)))
}

export function totalEarned(earnings: Earning[]): number {
  return sum(earnings.filter(isEarned))
}

/** The month's earned tasks, largest first (latest first on a tie). Tasks without an amount are left out. */
export function topEarnings(earnings: Earning[], monthId: MonthId, n: number): Earning[] {
  return earnings
    .filter((e) => isEarned(e) && cents(e.amount) > 0 && monthOf(e.weekId) === monthId)
    .sort((a, b) => cents(b.amount) - cents(a.amount) || (b.earnedAt ?? 0) - (a.earnedAt ?? 0) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .slice(0, Math.max(0, n))
}

export type MoneyActivity =
  | { kind: 'earning'; id: string; at: number; amount: number; earning: Earning }
  | { kind: 'add' | 'spend'; id: string; at: number; amount: number; move: MoneyMove }
  | { kind: 'baseline'; id: 'baseline'; at: number; amount: number }

/** Money in and out, newest first: earnings once earned, adds and spends, and when the balance was
 *  set. On a tie the balance comes first, as what happened at that moment is already in it. */
export function moneyActivity(state: MoneyState | null, earnings: Earning[], moves: MoneyMove[]): MoneyActivity[] {
  const items: MoneyActivity[] = [
    ...earnings.flatMap((e): MoneyActivity[] => (isEarned(e) ? [{ kind: 'earning', id: e.id, at: e.earnedAt, amount: e.amount, earning: e }] : [])),
    ...moves.map((m): MoneyActivity => ({ kind: m.kind, id: m.id, at: m.at, amount: m.amount, move: m })),
  ]
  if (state?.baseline != null && state.baselineAt != null) items.push({ kind: 'baseline', id: 'baseline', at: state.baselineAt, amount: state.baseline })
  return items.sort(
    (a, b) => b.at - a.at || Number(b.kind === 'baseline') - Number(a.kind === 'baseline') || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  )
}
