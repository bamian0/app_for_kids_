// A navigation screen: scroll view + large title that collapses into a centered inline title in a
// frosted bar, back button from the stack, trailing bar items, and a floating glass toolbar.
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { CSSProperties, ReactNode, Ref } from 'react'
import { useNavPage } from './NavigationStack.tsx'
import { GlassButton, GlassSurface } from './Glass.tsx'
import { Icon } from './icons.tsx'
import { cx } from './press.ts'
import './screen.css'

export interface ScreenProps {
  title: string
  /** large (default): iOS large title that collapses on scroll. inline: small centered title only. */
  titleDisplay?: 'large' | 'inline'
  /** Secondary line under the large title, e.g. "Week of Oct 13". */
  subtitle?: ReactNode
  /** Back button label; defaults to the previous screen's title. false shows the chevron only. */
  backTitle?: string | false
  /** Hide the automatic back button. */
  hideBack?: boolean
  /** Custom back action (default: pop the stack). */
  onBack?: () => void
  /** Replaces the back button (e.g. a "Cancel" GlassButton in a sheet). */
  leading?: ReactNode
  /** Bar items on the right: GlassButtons. */
  trailing?: ReactNode
  /** Floating glass capsule above the home indicator. */
  toolbar?: ReactNode
  /** Stretch the toolbar capsule to the screen width (for a single full-width button). */
  toolbarFullWidth?: boolean
  /** grouped (default): gray page for inset lists. plain: white/black page. */
  background?: 'grouped' | 'plain'
  scrollRef?: Ref<HTMLDivElement>
  className?: string
  style?: CSSProperties
  children?: ReactNode
}

export function Screen({
  title,
  titleDisplay = 'large',
  subtitle,
  backTitle,
  hideBack,
  onBack,
  leading,
  trailing,
  toolbar,
  toolbarFullWidth,
  background = 'grouped',
  scrollRef,
  className,
  style,
  children,
}: ScreenProps) {
  const page = useNavPage()
  const rootRef = useRef<HTMLDivElement>(null)
  const scrollEl = useRef<HTMLDivElement | null>(null)
  const largeRef = useRef<HTMLDivElement>(null)
  const large = titleDisplay === 'large'

  const setTitle = page?.setTitle
  useEffect(() => {
    setTitle?.(title)
  }, [title, setTitle])

  useLayoutEffect(() => {
    const root = rootRef.current
    const scroller = scrollEl.current
    if (!root || !scroller) return
    let largeHeight = largeRef.current?.offsetHeight ?? 0
    let collapsed: boolean | null = null
    let scrolled: boolean | null = null

    const update = () => {
      const y = scroller.scrollTop
      const lt = largeRef.current
      if (lt) {
        if (y < 0) {
          // Rubber-band pull: the large title grows a little, anchored at its leading edge.
          lt.style.transform = `scale(${1 + Math.min(-y, 140) / 1000})`
          lt.style.clipPath = ''
        } else {
          lt.style.transform = ''
          // Clip what has slid under the bar instead of letting it show through.
          lt.style.clipPath = y > 0 ? `inset(${Math.min(y, largeHeight)}px 0 0 0)` : ''
        }
      }
      const nextCollapsed = large ? y >= largeHeight - 10 : true
      const nextScrolled = large ? y >= largeHeight - 2 : y > 0.5
      if (nextCollapsed !== collapsed) {
        collapsed = nextCollapsed
        root.toggleAttribute('data-collapsed', collapsed)
      }
      if (nextScrolled !== scrolled) {
        scrolled = nextScrolled
        root.toggleAttribute('data-scrolled', scrolled)
      }
    }

    const ro = new ResizeObserver(() => {
      largeHeight = largeRef.current?.offsetHeight ?? 0
      update()
    })
    if (largeRef.current) ro.observe(largeRef.current)
    update()
    scroller.addEventListener('scroll', update, { passive: true })
    return () => {
      scroller.removeEventListener('scroll', update)
      ro.disconnect()
    }
  }, [large])

  const setScrollRef = (el: HTMLDivElement | null) => {
    scrollEl.current = el
    if (typeof scrollRef === 'function') scrollRef(el)
    else if (scrollRef) scrollRef.current = el
  }

  const showBack = !hideBack && !leading && (onBack || (page && page.index > 0))
  const backLabel = backTitle === false ? undefined : (backTitle ?? page?.backTitle)
  const backFits = useBackLabelFits(rootRef, showBack ? backLabel : undefined)
  const back = showBack ? (
    <GlassButton
      className={cx('ui-bar__back', (!backLabel || !backFits) && 'ui-bar__back--round')}
      onClick={onBack ?? page?.pop}
      aria-label={backLabel ? `Back to ${backLabel}` : 'Back'}
    >
      <Icon name="chevronLeft" size={24} weight={2.5} className="ui-bar__back-chevron" />
      {backLabel && <span className="ui-bar__back-label">{backLabel}</span>}
    </GlassButton>
  ) : null

  return (
    <div
      ref={rootRef}
      className={cx('ui-screen', `ui-screen--${background}`, large ? 'ui-screen--large' : 'ui-screen--inline', className)}
      style={style}
    >
      <header
        className="ui-bar"
        onClick={(e) => {
          // Like tapping the iOS status bar: anywhere on the bar that isn't a control scrolls to top.
          if ((e.target as HTMLElement).closest('button, a, input')) return
          scrollEl.current?.scrollTo({ top: 0, behavior: 'smooth' })
        }}
      >
        <div className="ui-bar__material" />
        <div className="ui-bar__row">
          <div className="ui-bar__leading">{leading ?? back}</div>
          <h1 className="ui-bar__title" aria-hidden={large || undefined}>
            {title}
          </h1>
          <div className="ui-bar__trailing">{trailing}</div>
        </div>
      </header>
      <div ref={setScrollRef} className="ui-screen__scroll">
        <div className={cx('ui-screen__content', toolbar != null && 'ui-screen__content--toolbar')}>
          {large && (
            <div ref={largeRef} className="ui-screen__large">
              <h1 className="ui-screen__large-title">{title}</h1>
              {subtitle && <div className="ui-screen__subtitle">{subtitle}</div>}
            </div>
          )}
          {children}
        </div>
      </div>
      {toolbar != null && (
        <div className={cx('ui-screen__toolbar', toolbarFullWidth && 'ui-screen__toolbar--full')}>
          <GlassSurface className="ui-toolbar">{toolbar}</GlassSurface>
        </div>
      )}
    </div>
  )
}

/** Fallback for the button's own padding and chevron, before it has been measured. */
const BACK_CHROME = 49

/**
 * Whether the back label fits whole next to the title. Like UIKit, a label that doesn't fit is
 * dropped for the bare chevron rather than cut to "Sett…". The bar's columns are sized by the
 * title alone, so this never feeds back into the width it measures.
 */
function useBackLabelFits(rootRef: { current: HTMLDivElement | null }, label: string | undefined): boolean {
  const [fits, setFits] = useState(true)
  useLayoutEffect(() => {
    const lead = rootRef.current?.querySelector<HTMLElement>('.ui-bar__leading')
    const ctx = typeof document !== 'undefined' ? document.createElement('canvas').getContext('2d') : null
    if (!label || !lead || !ctx || typeof ResizeObserver === 'undefined') {
      setFits(true)
      return
    }
    let chrome = BACK_CHROME
    const measure = () => {
      const button = lead.querySelector<HTMLElement>('.ui-bar__back')
      const text = button?.querySelector<HTMLElement>('.ui-bar__back-label')
      if (!button || !text) return
      if (text.offsetWidth > 0) chrome = button.offsetWidth - text.offsetWidth
      const css = getComputedStyle(text)
      ctx.font = `${css.fontWeight} ${css.fontSize} ${css.fontFamily}`
      const needed = Math.ceil(ctx.measureText(label).width)
      // The label's own CSS cap (max-width: 34vw) would also cut it.
      setFits(needed <= Math.min(lead.clientWidth - chrome, window.innerWidth * 0.34) + 0.5)
    }
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(lead)
    return () => ro.disconnect()
  }, [rootRef, label])
  return fits
}
