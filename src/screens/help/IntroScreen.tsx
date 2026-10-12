// The intro: five pages that explain Stakes before anything else, like an Apple first launch. Swipe or
// tap Continue; Skip and Get Started both end it. Shown once per device (introFlag.ts): signed out,
// before Welcome; signed in, once as a full-screen cover. Help replays it.
import { useLayoutEffect, useRef, useState } from 'react'
import type { ComponentType } from 'react'
import { motion, useMotionValue, useTransform } from 'motion/react'
import type { MotionValue } from 'motion/react'
import { Button, GlassButton, cx, haptic, usePrefersReducedMotion } from '../../ui/index.ts'
import { introPages } from './content.ts'
import type { IntroPage } from './content.ts'
import { MoneyVisual, MonthVisual, PlanVisual, ReviewVisual, WelcomeVisual } from './IntroVisuals.tsx'
import type { VisualProps } from './IntroVisuals.tsx'
import './help.css'

const VISUALS: Record<IntroPage['id'], ComponentType<VisualProps>> = {
  welcome: WelcomeVisual,
  plan: PlanVisual,
  review: ReviewVisual,
  month: MonthVisual,
  money: MoneyVisual,
}

/** Visuals are drawn on a fixed stage and scaled to the room the words and the button leave them. */
const STAGE_W = 320
const STAGE_H = 300
const MAX_SCALE = 1.2

export function IntroScreen({ onDone }: { onDone: () => void }) {
  const pages = introPages()
  const reduced = usePrefersReducedMotion()
  const rootRef = useRef<HTMLDivElement>(null)
  const pagerRef = useRef<HTMLElement>(null)
  const [index, setIndex] = useState(0)
  // How far the viewer has got: a page's picture plays the first time it comes into view, then stays put.
  const [reached, setReached] = useState(0)
  const progress = useMotionValue(0)
  const last = index === pages.length - 1

  // The picture takes the room the words leave (the same on every page, so titles line up), and the
  // two are centered together: an iPhone SE gets a smaller picture and still never scrolls.
  useLayoutEffect(() => {
    const root = rootRef.current
    const page = root?.querySelector<HTMLElement>('.intro__page')
    const words = page?.querySelector<HTMLElement>('.intro__words')
    if (!root || !page || !words) return
    const fit = () => {
      const room = page.clientHeight - parseFloat(getComputedStyle(page).paddingTop) - words.offsetHeight - 24
      const scale = Math.min(MAX_SCALE, room / STAGE_H, (page.clientWidth - 16) / STAGE_W)
      root.style.setProperty('--intro-scale', Math.max(0.5, scale).toFixed(3))
    }
    fit()
    const ro = new ResizeObserver(fit)
    ro.observe(page)
    return () => ro.disconnect()
  }, [])

  const onScroll = () => {
    const el = pagerRef.current
    if (!el || el.clientWidth === 0) return
    const p = el.scrollLeft / el.clientWidth
    progress.set(p)
    const i = Math.min(pages.length - 1, Math.max(0, Math.round(p)))
    setIndex(i)
    setReached((r) => Math.max(r, i))
  }

  const goTo = (i: number) => {
    const el = pagerRef.current
    el?.scrollTo({ left: i * el.clientWidth, behavior: reduced ? 'auto' : 'smooth' })
  }
  const finish = () => {
    haptic()
    onDone()
  }

  return (
    // As a cover it never drags like a sheet: swipes page, nothing else moves.
    <div ref={rootRef} className="intro" data-sheet-nodrag>
      <div className="intro__bar">
        <GlassButton className={cx('intro__skip', last && 'is-hidden')} onClick={finish} tabIndex={last ? -1 : undefined} aria-hidden={last || undefined}>
          Skip
        </GlassButton>
      </div>

      <section className="intro__pager" ref={pagerRef} onScroll={onScroll} aria-roledescription="carousel" aria-label="Introduction">
        {pages.map((page, i) => (
          <Page key={page.id} page={page} i={i} count={pages.length} active={i === index} play={i <= reached} progress={progress} reduced={reduced} />
        ))}
      </section>

      <div className="intro__footer">
        <div className="intro__dots" role="img" aria-label={`Page ${index + 1} of ${pages.length}`}>
          {pages.map((page, i) => (
            <span key={page.id} className={cx('intro__dot', i === index && 'is-current')} />
          ))}
        </div>
        <Button size="large" fullWidth onClick={() => (last ? finish() : goTo(index + 1))}>
          {last ? 'Get Started' : 'Continue'}
        </Button>
      </div>
    </div>
  )
}

interface PageProps {
  page: IntroPage
  i: number
  count: number
  active: boolean
  play: boolean
  progress: MotionValue<number>
  reduced: boolean
}

function Page({ page, i, count, active, play, progress, reduced }: PageProps) {
  const Visual = VISUALS[page.id]
  // The picture trails the swipe a little and fades, like the parallax of Apple's own intros.
  const distance = useTransform(progress, (p) => Math.min(1, Math.abs(p - i)))
  const x = useTransform(progress, (p) => `${Math.max(-1, Math.min(1, p - i)) * 28}%`)
  const scale = useTransform(distance, (d) => 1 - d * 0.08)
  const opacity = useTransform(distance, (d) => Math.max(0, 1 - d * 1.5))
  return (
    <div
      className="intro__page"
      role="group"
      aria-roledescription="slide"
      aria-label={`${i + 1} of ${count}`}
      aria-hidden={!active || undefined}
      inert={!active}
    >
      <motion.div className="intro__visual" style={reduced ? { opacity } : { x, scale, opacity }} aria-hidden inert>
        <div className="intro__stage">
          <Visual play={play} />
        </div>
      </motion.div>
      <div className="intro__words">
        <h1 className="intro__title">{page.title}</h1>
        <p className="intro__text">{page.text}</p>
      </div>
    </div>
  )
}
