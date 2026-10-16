// A line of facts joined by middle dots ("0 of 2 done · reviews in", "Lena: A beer · Sam: A paperback") that
// wraps like iOS lays such lines out: between facts, never inside a short one, and never with a dot left at the
// edge of a line.
import { Fragment, useLayoutEffect, useRef } from 'react'
import './facts.css'

export interface FactsProps {
  /** The facts, already joined: "3 weeks scored · 1 paused". */
  text: string
  separator?: string
}

/** Each fact is an inline block (a long one still wraps inside itself) carrying its dot at its end. A fact that
 *  ends a line drops its dot, so a centered line stays centered; if dropping it would pull the next fact up
 *  beside it, the dot keeps its room and is only hidden. Laid out once per width, so it can't loop. */
export function Facts({ text, separator = ' · ' }: FactsProps) {
  const parts = text.split(separator)
  const ref = useRef<HTMLSpanElement>(null)

  useLayoutEffect(() => {
    const root = ref.current
    if (!root) return
    let width = -1
    const layout = () => {
      const w = root.clientWidth
      if (w === width || w === 0) return
      width = w
      const facts = Array.from(root.children) as HTMLElement[]
      const dots = facts.map((fact) => fact.querySelector<HTMLElement>('.ui-fact__dot'))
      const lineHeight = parseFloat(getComputedStyle(root).lineHeight) || 20
      // The next fact starts on the line this one ends on.
      const sameLine = (i: number) => facts[i + 1].getBoundingClientRect().top < facts[i].getBoundingClientRect().bottom - lineHeight / 2
      for (const dot of dots) {
        if (!dot) continue
        dot.style.display = ''
        dot.style.visibility = ''
      }
      const ends = dots.map((dot, i) => !!dot && i < facts.length - 1 && !sameLine(i))
      ends.forEach((end, i) => {
        if (end) (dots[i] as HTMLElement).style.display = 'none'
      })
      for (let pass = 0; pass < facts.length; pass++) {
        let moved = false
        ends.forEach((end, i) => {
          const dot = dots[i] as HTMLElement
          if (end && dot.style.display === 'none' && sameLine(i)) {
            dot.style.display = ''
            moved = true
          }
        })
        if (!moved) break
      }
      dots.forEach((dot, i) => {
        if (dot && dot.style.display !== 'none') dot.style.visibility = i < facts.length - 1 && !sameLine(i) ? 'hidden' : ''
      })
    }
    layout()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(layout)
    observer.observe(root)
    return () => observer.disconnect()
  }, [text, separator])

  if (parts.length < 2) return <>{text}</>
  // " ·" kept whole (nowrap), so the text reads exactly as given: "3 weeks scored · 1 paused".
  const dot = separator.trimEnd()
  return (
    <span ref={ref} className="ui-facts">
      {parts.map((part, i) => (
        <Fragment key={i}>
          {i > 0 && ' '}
          <span className="ui-fact">
            {part}
            {i < parts.length - 1 && <span className="ui-fact__dot">{dot}</span>}
          </span>
        </Fragment>
      ))}
    </span>
  )
}
