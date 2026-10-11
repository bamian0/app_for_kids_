// Shared plumbing between UIProvider and the overlay components (sheets, alerts, toasts, edge glow).
import { createContext, useContext } from 'react'
import type { ReactNode } from 'react'
import type { MotionValue } from 'motion/react'

export type SheetDetent = 'medium' | 'large'

export interface SheetOptions {
  /** Default ['large']. With both, the sheet opens at the first one. */
  detents?: SheetDetent[]
  /** card (default): iOS page sheet. fullScreen: covers everything, for multi-step flows. */
  presentation?: 'card' | 'fullScreen'
  /** Drag down / tap the dimmed area to dismiss (default true for cards, false for fullScreen). */
  dismissible?: boolean
  /** Show the grabber (default true for cards). */
  grabber?: boolean
  'aria-label'?: string
}

export interface SheetRecord {
  id: number
  /** 0 → nothing presented above; 1 → fully covered by this sheet at its large detent. */
  cover: MotionValue<number>
}

export type DialogKind = 'alert' | 'actionSheet'

export interface DialogAction {
  label: string
  /** cancel: bold, dismisses. destructive: red. default: neutral. */
  style?: 'default' | 'cancel' | 'destructive'
  /** Emphasized (label-filled) button in alerts. */
  preferred?: boolean
  onPress?: () => void
}

export interface DialogSpec {
  kind: DialogKind
  title?: string
  message?: ReactNode
  actions: DialogAction[]
  /** Resolves the promise with the chosen label, or null when dismissed. */
  resolve: (label: string | null) => void
}

export interface ToastOptions {
  title: string
  message?: string
  /** Leading icon name or node. */
  icon?: ReactNode
  tone?: 'default' | 'success' | 'error'
  /** Default 3200ms. */
  durationMs?: number
  onPress?: () => void
}

export interface UIContextValue {
  host: HTMLElement | null
  safeTop: number
  sheets: SheetRecord[]
  registerSheet: (cover: MotionValue<number>) => { id: number; unregister: () => void }
  presentSheet: (content: ReactNode | ((close: () => void) => ReactNode), options?: SheetOptions) => () => void
  dismissTopSheet: () => void
  showDialog: (spec: DialogSpec) => void
  showToast: (options: ToastOptions) => void
  playEdgeGlow: (durationMs?: number) => void
}

export const UIContext = createContext<UIContextValue | null>(null)

export function useUI(): UIContextValue | null {
  return useContext(UIContext)
}

export function useRequiredUI(name: string): UIContextValue {
  const ui = useContext(UIContext)
  if (!ui) throw new Error(`${name} must be used inside <UIProvider>`)
  return ui
}

/** Set inside a sheet so useSheet().dismiss() closes that sheet. */
export interface SheetScope {
  dismiss: () => void
  detent: SheetDetent
  setDetent: (detent: SheetDetent) => void
}

export const SheetScopeContext = createContext<SheetScope | null>(null)
