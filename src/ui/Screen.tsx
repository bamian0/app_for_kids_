// A navigation screen: scroll view + large title that slides under an iOS 26 soft scroll edge while
// the centered inline title fades in, back button from the stack, trailing bar items, and a floating
// glass toolbar.
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
  /** Full-width buttons floating on their own, without the glass capsule (e.g. one large filled button). */
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
  const largeTitleRef = useRef<HTMLHeadingElement>(null)
  const materialRef = useRef<HTMLDivElement>(null)
  const barTitleRef = useRef<HTMLHeadingElement>(null)
  const toolbarRef = useRef<HTMLDivElement>(null)
  const large = titleDisplay === 'large'
  const hasToolbar = toolbar != null

  // The content scrolls clear of the floating toolbar, however tall it is (two buttons and a note, a
  // keyboard taking the home indicator's place): its measured height drives the bottom padding.
  useLayoutEffect(() => {
    const root = rootRef.current
    const bar = toolbarRef.current
    if (!root || !bar) return
    const set = () => root.style.setProperty('--ui-toolbar-height', `${bar.offsetHeight}px`)
    set()
    const ro = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(set)
    ro?.observe(bar)
    return () => {
      ro?.disconnect()
      root.style.removeProperty('--ui-toolbar-height')
    }
  }, [hasToolbar])

  const setTitle = page?.setTitle
  useEffect(() => {
    setTitle?.(title)
  }, [title, setTitle])

  useLayoutEffect(() => {
    const scroller = scrollEl.current
    if (!scroller) return
    // Where the large title ends, from the top of the content: something may sit above it (an app icon).
    // Layout offsets, so a pull's stretch or a sheet scaling the page doesn't skew it.
    let titleEnd = 0
    const measureTitle = () => {
      const t = largeTitleRef.current
      if (!t) return
      const content = t.closest<HTMLElement>('.ui-screen__content')
      titleEnd =
        content && t.offsetParent === scroller
          ? t.offsetTop + t.offsetHeight - content.offsetTop - parseFloat(getComputedStyle(content).paddingTop)
          : t.offsetHeight
    }
    measureTitle()
    const opacity = new WeakMap<HTMLElement, string>()
    // Inline opacity on two elements only: a custom property here would restyle the whole screen per frame.
    const fade = (el: HTMLElement | null, value: number) => {
      if (!el) return
      const v = Math.min(1, Math.max(0, value)).toFixed(2)
      if (opacity.get(el) === v) return
      opacity.set(el, v)
      el.style.opacity = v
    }

    const update = () => {
      const y = scroller.scrollTop
      const lt = largeRef.current
      // Rubber-band pull: the large title grows a little, anchored at its leading edge.
      if (lt) lt.style.transform = y < 0 ? `scale(${1 + Math.min(-y, 140) / 1000})` : ''
      // iOS 26 scroll edge: content softens under the bar from the first pixels of scroll.
      fade(materialRef.current, y / 12)
      // The inline title fades in as the large title disappears under the bar's soft edge.
      if (large) fade(barTitleRef.current, (y - (titleEnd - 12)) / 16)
    }

    const ro = new ResizeObserver(() => {
      measureTitle()
      update()
    })
    if (largeTitleRef.current) ro.observe(largeTitleRef.current)
    // Content appearing or going above the title moves it without resizing it, but resizes the content.
    const content = largeTitleRef.current?.closest('.ui-screen__content')
    if (content) ro.observe(content)
    update()
    scroller.addEventListener('scroll', update, { passive: true })
    return () => {
      scroller.removeEventListener('scroll', update)
      ro.disconnect()
      // An inline title (titleDisplay switched) must not keep the large mode's fade.
      fade(barTitleRef.current, 1)
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
        <div ref={materialRef} className="ui-bar__material" />
        <div className="ui-bar__row">
          <div className="ui-bar__leading">{leading ?? back}</div>
          <h1 ref={barTitleRef} className="ui-bar__title" aria-hidden={large || undefined}>
            {title}
          </h1>
          <div className="ui-bar__trailing">{trailing}</div>
        </div>
      </header>
      <div ref={setScrollRef} className="ui-screen__scroll">
        <div className={cx('ui-screen__content', toolbar != null && 'ui-screen__content--toolbar')}>
          {large && (
            <div ref={largeRef} className="ui-screen__large">
              <h1 ref={largeTitleRef} className="ui-screen__large-title">
                {title}
              </h1>
              {subtitle && <div className="ui-screen__subtitle">{subtitle}</div>}
            </div>
          )}
          {children}
        </div>
      </div>
      {toolbar != null && (
        <div ref={toolbarRef} className={cx('ui-screen__toolbar', toolbarFullWidth && 'ui-screen__toolbar--full')}>
          {toolbarFullWidth ? <div className="ui-toolbar">{toolbar}</div> : <GlassSurface className="ui-toolbar">{toolbar}</GlassSurface>}
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
