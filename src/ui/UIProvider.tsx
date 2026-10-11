// App root for the design system: hosts sheets, alerts, banners and the edge glow above the app, and
// scales the app back like a presenting view when a card sheet comes up.
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { MotionConfig } from 'motion/react'
import type { MotionValue } from 'motion/react'
import { UIContext } from './context.ts'
import type { DialogSpec, SheetOptions, SheetRecord, ToastOptions, UIContextValue } from './context.ts'
import { Sheet } from './Sheet.tsx'
import { DialogLayer } from './Alert.tsx'
import { ToastLayer } from './Toast.tsx'
import { IridescentEdgeGlow } from './Iridescence.tsx'
import type { EdgeGlowHandle } from './Iridescence.tsx'
import './provider.css'

export type Theme = 'system' | 'light' | 'dark'

/** Force light or dark, or follow the system. */
export function setTheme(theme: Theme): void {
  const root = document.documentElement
  if (theme === 'system') delete root.dataset.theme
  else root.dataset.theme = theme
}

interface PresentedSheet {
  id: number
  open: boolean
  content: ReactNode | ((close: () => void) => ReactNode)
  options?: SheetOptions
}

export interface UIProviderProps {
  children: ReactNode
  /** Force a theme. Omit to leave <html data-theme> alone (follows the system unless set elsewhere). */
  theme?: Theme
}

/** Wrap the whole app once: <UIProvider><NavigationStack root={…} /></UIProvider>. */
export function UIProvider({ children, theme }: UIProviderProps) {
  const [host, setHost] = useState<HTMLDivElement | null>(null)
  const [safeTop, setSafeTop] = useState(0)
  const probe = useRef<HTMLDivElement>(null)
  const presentingRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (theme) setTheme(theme)
  }, [theme])

  useLayoutEffect(() => {
    const measure = () => setSafeTop(probe.current?.offsetHeight ?? 0)
    measure()
    window.addEventListener('resize', measure)
    return () => window.removeEventListener('resize', measure)
  }, [])

  // ---- Sheet stack ----
  const [sheets, setSheets] = useState<SheetRecord[]>([])
  const sheetSeq = useRef(1)
  const registerSheet = useCallback((cover: MotionValue<number>) => {
    const id = sheetSeq.current++
    setSheets((list) => [...list, { id, cover }])
    return { id, unregister: () => setSheets((list) => list.filter((s) => s.id !== id)) }
  }, [])

  const [presented, setPresented] = useState<PresentedSheet[]>([])
  const closeSheet = useCallback((id: number) => {
    setPresented((list) => list.map((p) => (p.id === id ? { ...p, open: false } : p)))
  }, [])
  const presentSheet = useCallback(
    (content: PresentedSheet['content'], options?: SheetOptions) => {
      const id = sheetSeq.current++
      setPresented((list) => [...list, { id, open: true, content, options }])
      return () => closeSheet(id)
    },
    [closeSheet],
  )
  const presentedRef = useRef(presented)
  presentedRef.current = presented
  const dismissTopSheet = useCallback(() => {
    const top = [...presentedRef.current].reverse().find((p) => p.open)
    if (top) closeSheet(top.id)
  }, [closeSheet])

  // The bottom-most sheet drives the presenting view: scale back, round corners, slide below the status bar.
  const baseCover = sheets[0]?.cover
  useEffect(() => {
    const el = presentingRef.current
    if (!el) return
    const apply = (c: number) => {
      if (c <= 0.001) {
        el.style.transform = ''
        el.style.borderRadius = ''
        return
      }
      el.style.transform = `translate3d(0, ${(c * safeTop).toFixed(2)}px, 0) scale(${(1 - 0.075 * c).toFixed(4)})`
      el.style.borderRadius = `${(c * 26).toFixed(1)}px`
    }
    if (!baseCover) {
      apply(0)
      return
    }
    apply(baseCover.get())
    return baseCover.on('change', apply)
  }, [baseCover, safeTop])

  // ---- Dialogs (queued, one at a time) ----
  const [dialogs, setDialogs] = useState<Array<DialogSpec & { id: number }>>([])
  const dialogSeq = useRef(1)
  const showDialog = useCallback((spec: DialogSpec) => {
    setDialogs((list) => [...list, { ...spec, id: dialogSeq.current++ }])
  }, [])
  const dialogsRef = useRef(dialogs)
  dialogsRef.current = dialogs
  const finishDialog = useCallback((label: string | null) => {
    const top = dialogsRef.current[0]
    if (!top) return
    top.resolve(label)
    setDialogs((list) => list.filter((d) => d.id !== top.id))
  }, [])

  // ---- Banner ----
  const [toast, setToast] = useState<(ToastOptions & { id: number }) | null>(null)
  const toastSeq = useRef(1)
  const showToast = useCallback((options: ToastOptions) => setToast({ ...options, id: toastSeq.current++ }), [])

  // ---- Edge glow ----
  const glow = useRef<EdgeGlowHandle>(null)
  const playEdgeGlow = useCallback((ms?: number) => glow.current?.play(ms), [])

  const value = useMemo<UIContextValue>(
    () => ({ host, safeTop, sheets, registerSheet, presentSheet, dismissTopSheet, showDialog, showToast, playEdgeGlow }),
    [host, safeTop, sheets, registerSheet, presentSheet, dismissTopSheet, showDialog, showToast, playEdgeGlow],
  )

  return (
    <MotionConfig reducedMotion="user">
      <UIContext.Provider value={value}>
        <div className="ui-app">
          <div ref={probe} className="ui-app__safe-probe" aria-hidden />
          <div ref={presentingRef} className="ui-app__presenting" inert={sheets.length > 0}>
            {children}
          </div>
          <div ref={setHost} className="ui-app__overlays">
            {presented.map((p) => (
              <Sheet
                key={p.id}
                {...p.options}
                open={p.open}
                onClose={() => closeSheet(p.id)}
                onClosed={() => setPresented((list) => list.filter((x) => x.id !== p.id))}
              >
                {typeof p.content === 'function' ? p.content(() => closeSheet(p.id)) : p.content}
              </Sheet>
            ))}
            <DialogLayer spec={dialogs[0] ?? null} onDone={finishDialog} />
            <ToastLayer toast={toast} onDismiss={() => setToast(null)} />
            <IridescentEdgeGlow ref={glow} />
          </div>
        </div>
      </UIContext.Provider>
    </MotionConfig>
  )
}
