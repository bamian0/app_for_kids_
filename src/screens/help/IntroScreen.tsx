// The intro: five pages that explain Stakes before anything else, like an Apple first launch. Swipe or
// tap Continue; Skip and Get Started both end it. Shown once per device (introFlag.ts): signed out,
// before Welcome; signed in, once as a full-screen cover. Help replays it.
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
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

/** Visuals are drawn on a fixed stage and scaled to the room the screen leaves them. */
const STAGE_W = 320
const STAGE_H = 300
/** What the title, text, page dots and button need below the visual, at most. */
const TEXT_ROOM = 420

export function IntroScreen({ onDone }: { onDone: () => void }) {
  const pages = introPages()
  const reduced = usePrefersReducedMotion()
  const rootRef = useRef<HTMLDivElement>(null)
  const pagerRef = useRef<HTMLDivElement>(null)
  const [index, setIndex] = useState(0)
  // How far anyone has got: a page's visual plays the first time it comes into view, then stays put.
  const [reached, setReached] = useState(0)
  const progress = useMotionValue(0)
  const last = index === pages.length - 1

  useEffect(() => setReached((r) => Math.max(r, index)), [index])

  // An iPhone SE gets a smaller picture, so the words and the button still fit without scrolling.
  useLayoutEffect(() => {
    const root = rootRef.current
    if (!root) return
    const fit = () => {
      const room = Math.min(340, Math.max(190, root.clientHeight - TEXT_ROOM))
      const scale = Math.min(1.12, room / STAGE_H, (root.clientWidth - 24) / STAGE_W)
      root.style.setProperty('--intro-visual-h', `${Math.round(room)}px`)
      root.style.setProperty('--intro-scale', scale.toFixed(3))
    }
    fit()
    const ro = new ResizeObserver(fit)
    ro.observe(root)
    return () => ro.disconnect()
  }, [])

  const onScroll = () => {
    const el = pagerRef.current
    if (!el || el.clientWidth === 0) return
    const p = el.scrollLeft / el.clientWidth
    progress.set(p)
    setIndex(Math.min(pages.length - 1, Math.max(0, Math.round(p))))
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
    <div ref={rootRef} className="intro">
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
  const x = useTransform(progress, (p) => `${Math.max(-1, Math.min(1, p - i)) * 36}%`)
  const scale = useTransform(distance, (d) => 1 - d * 0.08)
  const opacity = useTransform(distance, (d) => 1 - d)
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
      <h1 className="intro__title">{page.title}</h1>
      <p className="intro__text">{page.text}</p>
    </div>
  )
}
