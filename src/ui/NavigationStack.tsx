// UINavigationController for the web: an in-memory stack of mounted screens with the iOS push/pop
// parallax and an interactive edge swipe-back that follows the finger and settles with a spring.
import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { PointerEvent as ReactPointerEvent, ReactNode } from 'react'
import { animate } from 'motion/react'
import { createVelocityTracker, prefersReducedMotion, springs } from './motion.ts'
import { cx } from './press.ts'
import './nav.css'

export interface PushOptions {
  /** Title of the pushed screen, shown in the next screen's back button. A <Screen title> overrides it. */
  title?: string
}

export interface NavApi {
  push: (element: ReactNode, options?: PushOptions) => void
  pop: () => void
  popToRoot: () => void
  /** Number of screens above the root (0 at root). */
  depth: number
  canGoBack: boolean
}

interface PageInfo {
  index: number
  isTop: boolean
  backTitle?: string
  setTitle: (title: string) => void
  pop: () => void
}

const NavContext = createContext<NavApi | null>(null)
const PageContext = createContext<PageInfo | null>(null)

/** Navigation API of the nearest NavigationStack. */
export function useNav(): NavApi {
  const nav = useContext(NavContext)
  if (!nav) throw new Error('useNav() must be used inside a <NavigationStack>')
  return nav
}

/** The current page's place in its stack (null outside a NavigationStack). Used by Screen. */
export function useNavPage(): PageInfo | null {
  return useContext(PageContext)
}

/** Hides any outer stack from its children. Sheets use it so their content starts a fresh navigation context. */
export function NavReset({ children }: { children: ReactNode }) {
  return (
    <NavContext.Provider value={null}>
      <PageContext.Provider value={null}>{children}</PageContext.Provider>
    </NavContext.Provider>
  )
}

interface Entry {
  key: number
  element: ReactNode
  title?: string
}

type Pending = 'push' | 'settle' | 'popToRoot' | null

const EDGE_WIDTH = 24
const PARALLAX = 0.3

export interface NavigationStackProps {
  root: ReactNode
  /** Back-button title for screens pushed from the root (the root <Screen title> is used when omitted). */
  rootTitle?: string
  className?: string
}

export function NavigationStack({ root, rootTitle, className }: NavigationStackProps) {
  const [entries, setEntries] = useState<Entry[]>(() => [{ key: 0, element: null, title: rootTitle }])
  const [titles, setTitles] = useState<Record<number, string>>({})
  const entriesRef = useRef(entries)
  entriesRef.current = entries

  const container = useRef<HTMLDivElement>(null)
  const pageEls = useRef(new Map<number, HTMLDivElement>())
  const dimEls = useRef(new Map<number, HTMLDivElement>())
  const progress = useRef(0) // 0: top page at rest; 1: top page fully off to the right
  const fade = useRef(false)
  const pending = useRef<Pending>(null)
  const anim = useRef<{ stop: () => void; finish: () => void } | null>(null)
  const nextKey = useRef(1)

  const apply = useCallback((p: number) => {
    const list = entriesRef.current
    const width = container.current?.clientWidth ?? window.innerWidth
    const top = list.length - 1
    list.forEach((entry, i) => {
      const el = pageEls.current.get(entry.key)
      const dim = dimEls.current.get(entry.key)
      if (!el) return
      if (i === top) {
        el.style.visibility = 'visible'
        if (fade.current) {
          el.style.transform = ''
          el.style.opacity = String(1 - p)
        } else {
          el.style.opacity = ''
          el.style.transform = p === 0 ? '' : `translate3d(${p * width}px,0,0)`
        }
      } else if (i === top - 1) {
        el.style.visibility = 'visible'
        el.style.opacity = ''
        el.style.transform = fade.current ? '' : `translate3d(${-(1 - p) * PARALLAX * width}px,0,0)`
        if (dim) dim.style.opacity = fade.current ? '0' : String(1 - p)
      } else {
        el.style.visibility = 'hidden'
      }
    })
  }, [])

  const settleNow = useCallback(() => {
    anim.current?.finish()
    anim.current = null
  }, [])

  const animateTo = useCallback(
    (target: number, velocity: number, onDone?: () => void) => {
      anim.current?.stop()
      let done = false
      let controls: { stop: () => void } | undefined
      const finish = () => {
        if (done) return
        done = true
        controls?.stop()
        progress.current = target
        apply(target)
        anim.current = null
        onDone?.()
      }
      const options = fade.current
        ? { duration: 0.22, ease: 'easeOut' as const }
        : { ...springs.navigation, velocity }
      controls = animate(progress.current, target, {
        ...options,
        onUpdate: (v: number) => {
          progress.current = v
          apply(v)
        },
        onComplete: finish,
      })
      if (done) return
      anim.current = {
        stop: () => {
          done = true
          controls?.stop()
        },
        finish,
      }
    },
    [apply],
  )

  const commitPop = useCallback(() => {
    pending.current = 'settle'
    setEntries((list) => (list.length > 1 ? list.slice(0, -1) : list))
  }, [])

  const push = useCallback(
    (element: ReactNode, options?: PushOptions) => {
      settleNow()
      fade.current = prefersReducedMotion()
      pending.current = 'push'
      const key = nextKey.current++
      setEntries((list) => [...list, { key, element, title: options?.title }])
    },
    [settleNow],
  )

  const pop = useCallback(() => {
    settleNow()
    if (entriesRef.current.length < 2) return
    fade.current = prefersReducedMotion()
    animateTo(1, 0, commitPop)
  }, [animateTo, commitPop, settleNow])

  const popToRoot = useCallback(() => {
    settleNow()
    const list = entriesRef.current
    if (list.length < 2) return
    fade.current = prefersReducedMotion()
    if (list.length === 2) {
      animateTo(1, 0, commitPop)
      return
    }
    // Like UIKit: drop the middle screens, then slide the top one away to reveal the root.
    pending.current = 'popToRoot'
    setEntries([list[0], list[list.length - 1]])
  }, [animateTo, commitPop, settleNow])

  useLayoutEffect(() => {
    const kind = pending.current
    pending.current = null
    if (kind === 'push') {
      progress.current = 1
      apply(1)
      animateTo(0, 0)
    } else if (kind === 'popToRoot') {
      apply(0)
      animateTo(1, 0, commitPop)
    } else if (kind === 'settle') {
      progress.current = 0
      apply(0)
    } else if (!anim.current) {
      apply(progress.current)
    }
  }, [entries, apply, animateTo, commitPop])

  useEffect(() => () => anim.current?.stop(), [])

  // ---- Interactive swipe-back from the left edge ----
  const gesture = useRef<{ id: number; x0: number; y0: number; started: boolean; p0: number } | null>(null)
  const tracker = useRef(createVelocityTracker())

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (entriesRef.current.length < 2 || gesture.current) return
    if (e.pointerType === 'mouse' && e.button !== 0) return
    const rect = e.currentTarget.getBoundingClientRect()
    if (e.clientX - rect.left > EDGE_WIDTH) return
    gesture.current = { id: e.pointerId, x0: e.clientX, y0: e.clientY, started: false, p0: 0 }
  }

  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const g = gesture.current
    if (!g || e.pointerId !== g.id) return
    const dx = e.clientX - g.x0
    const dy = e.clientY - g.y0
    const width = e.currentTarget.clientWidth
    if (!g.started) {
      if (Math.abs(dy) > 10 && Math.abs(dy) > Math.abs(dx)) {
        gesture.current = null
        return
      }
      if (dx < 6 || dx < Math.abs(dy)) return
      g.started = true
      anim.current?.stop()
      anim.current = null
      fade.current = false
      g.p0 = progress.current
      g.x0 = e.clientX
      tracker.current.reset()
      e.currentTarget.setPointerCapture(e.pointerId)
      e.currentTarget.dataset.swiping = ''
    }
    const p = Math.min(1, Math.max(0, g.p0 + (e.clientX - g.x0) / width))
    progress.current = p
    apply(p)
    tracker.current.add(e.clientX)
  }

  const endGesture = (e: ReactPointerEvent<HTMLDivElement>, cancelled: boolean) => {
    const g = gesture.current
    if (!g || e.pointerId !== g.id) return
    gesture.current = null
    if (!g.started) return
    delete e.currentTarget.dataset.swiping
    swallowNextClick()
    const width = e.currentTarget.clientWidth
    const v = tracker.current.velocity() / width
    const p = progress.current
    const commit = !cancelled && (v > 0.9 || (p > 0.5 && v > -0.4))
    if (commit) animateTo(1, Math.max(v, 0), commitPop)
    else animateTo(0, Math.min(v, 0))
  }

  const top = entries.length - 1
  const backTitleFor = (i: number) => {
    if (i === 0) return undefined
    const prev = entries[i - 1]
    return titles[prev.key] ?? prev.title
  }

  const navApi = useMemo<NavApi>(
    () => ({ push, pop, popToRoot, depth: entries.length - 1, canGoBack: entries.length > 1 }),
    [push, pop, popToRoot, entries.length],
  )

  const setTitleFor = useCallback((key: number, title: string) => {
    setTitles((t) => (t[key] === title ? t : { ...t, [key]: title }))
  }, [])

  return (
    <NavContext.Provider value={navApi}>
      <div
        ref={container}
        className={cx('ui-nav', className)}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={(e) => endGesture(e, false)}
        onPointerCancel={(e) => endGesture(e, true)}
      >
        {entries.map((entry, i) => (
          <NavPage
            key={entry.key}
            entryKey={entry.key}
            index={i}
            isTop={i === top}
            backTitle={backTitleFor(i)}
            setTitleFor={setTitleFor}
            pop={pop}
            pageRef={(el) => {
              if (el) pageEls.current.set(entry.key, el)
              else pageEls.current.delete(entry.key)
            }}
            dimRef={(el) => {
              if (el) dimEls.current.set(entry.key, el)
              else dimEls.current.delete(entry.key)
            }}
          >
            {i === 0 ? root : entry.element}
          </NavPage>
        ))}
      </div>
    </NavContext.Provider>
  )
}

interface NavPageProps {
  entryKey: number
  index: number
  isTop: boolean
  backTitle?: string
  setTitleFor: (key: number, title: string) => void
  pop: () => void
  pageRef: (el: HTMLDivElement | null) => void
  dimRef: (el: HTMLDivElement | null) => void
  children: ReactNode
}

function NavPage({ entryKey, index, isTop, backTitle, setTitleFor, pop, pageRef, dimRef, children }: NavPageProps) {
  const setTitle = useCallback((title: string) => setTitleFor(entryKey, title), [entryKey, setTitleFor])
  const info = useMemo<PageInfo>(() => ({ index, isTop, backTitle, setTitle, pop }), [index, isTop, backTitle, setTitle, pop])
  return (
    <PageContext.Provider value={info}>
      <div ref={pageRef} className="ui-nav__page" inert={!isTop} aria-hidden={!isTop || undefined}>
        {children}
        <div ref={dimRef} className="ui-nav__dim" />
      </div>
    </PageContext.Provider>
  )
}

function swallowNextClick() {
  const handler = (e: Event) => {
    e.stopPropagation()
    e.preventDefault()
  }
  window.addEventListener('click', handler, { capture: true, once: true })
  window.setTimeout(() => window.removeEventListener('click', handler, { capture: true }), 80)
}
