// Earnings per week as columns, like the Health app: this week in graphite, earlier weeks in gray.
// Touch or hover picks a week and shows its amount on the column; the arrow keys do the same.
import { useLayoutEffect, useRef, useState } from 'react'
import type { KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent } from 'react'
import { formatMoney } from '../../domain/money.ts'
import type { CurrencyCode, WeekId } from '../../domain/types.ts'
import { cx } from '../../ui/index.ts'
import { weekLabel } from './format.ts'

export interface EarningsChartProps {
  /** Oldest first; the last one is this week. */
  weeks: WeekId[]
  /** Earned per week, aligned with `weeks`. */
  values: number[]
  currency: CurrencyCode
}

const PLOT = 112
/** Room above the tallest column for its value. */
const HEAD = 22
/** The week labels under the baseline. */
const FOOT = 22
/** The y-axis labels on the right, like Health. */
const AXIS = 40
const MAX_BAR = 24
const RADIUS = 4

/** The smallest of 1, 2, 5 × 10ⁿ at or above `max`, so the gridlines (top and half) read as round numbers. */
function niceTop(max: number): number {
  if (!(max > 0)) return 1
  const power = 10 ** Math.floor(Math.log10(max))
  for (const step of [1, 2, 5, 10]) if (step * power >= max - 1e-9) return step * power
  return 10 * power
}

/** A column with a rounded top and a square foot on the baseline. */
function columnPath(x: number, bottom: number, width: number, height: number): string {
  const r = Math.min(RADIUS, height, width / 2)
  const top = bottom - height
  return `M${x},${bottom}V${top + r}A${r},${r} 0 0 1 ${x + r},${top}H${x + width - r}A${r},${r} 0 0 1 ${x + width},${top + r}V${bottom}Z`
}

/** Roughly how wide a value label is (13px semibold, tabular digits), to keep it inside the chart. */
function labelWidth(text: string): number {
  return text.length * 7.6
}

function useWidth(ref: { current: HTMLElement | null }): number {
  const [width, setWidth] = useState(0)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const measure = () => setWidth(el.clientWidth)
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [ref])
  return width
}

export function EarningsChart({ weeks, values, currency }: EarningsChartProps) {
  const box = useRef<HTMLDivElement>(null)
  const width = useWidth(box)
  const current = weeks.length - 1
  const [picked, setPicked] = useState<number | null>(null)
  const selected = picked ?? current
  const scrubbing = useRef(false)

  const n = weeks.length
  const max = Math.max(0, ...values)
  const top = niceTop(max)
  const plotWidth = Math.max(0, width - AXIS)
  const band = n > 0 ? plotWidth / n : 0
  const bar = Math.min(MAX_BAR, Math.max(6, band * 0.6))
  const baseline = HEAD + PLOT
  const height = HEAD + PLOT + FOOT
  const money = (v: number) => formatMoney(v, currency, { compact: v >= 10_000 })

  const pickAt = (e: ReactPointerEvent<SVGSVGElement>) => {
    if (band <= 0) return
    const x = e.clientX - e.currentTarget.getBoundingClientRect().left
    setPicked(Math.min(n - 1, Math.max(0, Math.floor(x / band))))
  }

  const onKeyDown = (e: ReactKeyboardEvent) => {
    const step = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0
    if (!step) return
    e.preventDefault()
    setPicked(Math.min(n - 1, Math.max(0, selected + step)))
  }

  // Every other week is labelled, counting back from this week, and the picked week always is.
  const labelled = (i: number) => i === selected || ((current - i) % 2 === 0 && Math.abs(i - selected) !== 1)
  const summary = weeks.map((w, i) => `${i === current ? 'This week' : `Week of ${weekLabel(w)}`}: ${formatMoney(values[i] ?? 0, currency)}`).join('; ')

  return (
    <div ref={box} className="m-chart">
      {width > 0 && (
        <svg
          className="m-chart__svg"
          width={width}
          height={height}
          viewBox={`0 0 ${width} ${height}`}
          role="img"
          aria-label={`Earned by week. ${summary}.`}
          tabIndex={0}
          onKeyDown={onKeyDown}
          onPointerDown={(e) => {
            scrubbing.current = true
            pickAt(e)
          }}
          onPointerMove={(e) => {
            if (scrubbing.current || e.pointerType === 'mouse') pickAt(e)
          }}
          onPointerUp={() => {
            scrubbing.current = false
          }}
          onPointerCancel={() => {
            scrubbing.current = false
          }}
          onPointerLeave={(e) => {
            if (e.pointerType === 'mouse') setPicked(null)
          }}
        >
          {[0.5, 1].map((f) => (
            <g key={f} className="m-chart__grid">
              <line x1={0} x2={plotWidth} y1={baseline - PLOT * f + 0.5} y2={baseline - PLOT * f + 0.5} />
              {max > 0 && (
                <text x={width} y={baseline - PLOT * f + 4} textAnchor="end">
                  {formatMoney(top * f, currency, { compact: true })}
                </text>
              )}
            </g>
          ))}
          <line className="m-chart__baseline" x1={0} x2={plotWidth} y1={baseline + 0.5} y2={baseline + 0.5} />
          <text className="m-chart__axis-zero" x={width} y={baseline + 4} textAnchor="end">
            0
          </text>

          {weeks.map((weekId, i) => {
            const value = values[i] ?? 0
            const h = value > 0 ? Math.max(2, (value / top) * PLOT) : 0
            const x = i * band + (band - bar) / 2
            const center = i * band + band / 2
            const isSelected = i === selected
            return (
              <g key={weekId} className={cx('m-chart__week', i === current && 'is-current', isSelected && 'is-selected')}>
                {h > 0 && <path className="m-chart__bar" d={columnPath(x, baseline, bar, h)} />}
                {isSelected && (
                  <text
                    className="m-chart__value"
                    // Over its column, but never past the chart's edges.
                    x={Math.min(width - labelWidth(money(value)) / 2, Math.max(labelWidth(money(value)) / 2, center))}
                    y={baseline - h - 7}
                    textAnchor="middle"
                  >
                    {money(value)}
                  </text>
                )}
                {labelled(i) && (
                  <text className="m-chart__label" x={center} y={height - 5} textAnchor="middle">
                    {i === current ? 'This week' : weekLabel(weekId)}
                  </text>
                )}
              </g>
            )
          })}
        </svg>
      )}
      <span className="ui-visually-hidden" aria-live="polite">
        {picked === null ? '' : `${picked === current ? 'This week' : `Week of ${weekLabel(weeks[picked])}`}: ${formatMoney(values[picked] ?? 0, currency)}`}
      </span>
    </div>
  )
}
