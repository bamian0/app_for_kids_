// iOS 26 alerts (centered card, capsule buttons side by side or stacked) and action sheets.
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { AnimatePresence, motion } from 'motion/react'
import { useRequiredUI, useUI } from './context.ts'
import type { DialogAction, DialogKind, DialogSpec } from './context.ts'
import { springs } from './motion.ts'
import { cx } from './press.ts'
import './alert.css'

export type { DialogAction }

export interface AlertOptions {
  title: string
  message?: ReactNode
  /** Default: a single "OK". Two actions sit side by side (cancel first); three or more stack. */
  actions?: DialogAction[]
}

export interface ConfirmOptions {
  title: string
  message?: ReactNode
  confirmLabel?: string
  cancelLabel?: string
  destructive?: boolean
}

export interface ActionSheetOptions {
  title?: string
  message?: ReactNode
  actions: DialogAction[]
  /** Label of the separate cancel button (default "Cancel"). */
  cancelLabel?: string
}

export interface UseAlert {
  /** Resolves with the tapped action's label (null if dismissed). */
  alert: (options: AlertOptions) => Promise<string | null>
  /** Resolves true when the confirm button was tapped. */
  confirm: (options: ConfirmOptions) => Promise<boolean>
  /** Resolves with the tapped action's label, or null for Cancel / tap outside. */
  actionSheet: (options: ActionSheetOptions) => Promise<string | null>
}

export function useAlert(): UseAlert {
  const ui = useRequiredUI('useAlert()')
  const show = ui.showDialog
  return useMemo<UseAlert>(() => {
    const open = (kind: DialogKind, title: string | undefined, message: ReactNode, actions: DialogAction[]) =>
      new Promise<string | null>((resolve) => show({ kind, title, message, actions, resolve }))
    return {
      alert: ({ title, message, actions }) => open('alert', title, message, actions?.length ? actions : [{ label: 'OK', preferred: true }]),
      confirm: async ({ title, message, confirmLabel = 'OK', cancelLabel = 'Cancel', destructive }) => {
        const label = await open('alert', title, message, [
          { label: cancelLabel, style: 'cancel' },
          { label: confirmLabel, style: destructive ? 'destructive' : 'default', preferred: !destructive },
        ])
        return label === confirmLabel
      },
      actionSheet: ({ title, message, actions, cancelLabel = 'Cancel' }) =>
        open('actionSheet', title, message, [...actions, { label: cancelLabel, style: 'cancel' }]).then((label) =>
          label === cancelLabel ? null : label,
        ),
    }
  }, [show])
}

// ---- Rendering ----

function orderedAlertActions(actions: DialogAction[], row: boolean): DialogAction[] {
  const cancel = actions.filter((a) => a.style === 'cancel')
  const rest = actions.filter((a) => a.style !== 'cancel')
  // Side by side: cancel on the left. Stacked: cancel at the bottom.
  return row ? [...cancel, ...rest] : [...rest, ...cancel]
}

function AlertCard({ spec, onSelect }: { spec: DialogSpec; onSelect: (a: DialogAction) => void }) {
  // Two buttons sit side by side unless a label doesn't fit; then they stack, as on iOS.
  const [stacked, setStacked] = useState(false)
  const actionsRef = useRef<HTMLDivElement>(null)
  const row = spec.actions.length === 2 && !stacked
  const actions = orderedAlertActions(spec.actions, row)
  useLayoutEffect(() => {
    if (!row || !actionsRef.current) return
    const cut = [...actionsRef.current.children].some((button) => button.scrollWidth > button.clientWidth + 1)
    if (cut) setStacked(true)
  }, [row, spec])
  return (
    <motion.div
      className="ui-alert"
      role="alertdialog"
      aria-modal="true"
      aria-label={spec.title}
      initial={{ opacity: 0, scale: 1.1 }}
      animate={{ opacity: 1, scale: 1, transition: springs.snappy }}
      exit={{ opacity: 0, scale: 0.97, transition: { duration: 0.16 } }}
    >
      {(spec.title || spec.message) && (
        <div className="ui-alert__text">
          {spec.title && <h2 className="ui-alert__title">{spec.title}</h2>}
          {spec.message && <div className="ui-alert__message">{spec.message}</div>}
        </div>
      )}
      <div ref={actionsRef} className={cx('ui-alert__actions', row && 'ui-alert__actions--row')}>
        {actions.map((a, i) => (
          <button
            key={`${a.label}-${i}`}
            type="button"
            className={cx(
              'ui-alert__button',
              a.preferred && a.style !== 'destructive' && 'is-preferred',
              a.style === 'destructive' && 'is-destructive',
              a.style === 'cancel' && 'is-cancel',
            )}
            onClick={() => onSelect(a)}
          >
            {a.label}
          </button>
        ))}
      </div>
    </motion.div>
  )
}

function ActionSheetCard({ spec, onSelect }: { spec: DialogSpec; onSelect: (a: DialogAction) => void }) {
  const cancel = spec.actions.find((a) => a.style === 'cancel')
  const rest = spec.actions.filter((a) => a !== cancel)
  return (
    <motion.div
      className="ui-actionsheet"
      role="dialog"
      aria-modal="true"
      aria-label={spec.title ?? 'Actions'}
      initial={{ y: '110%' }}
      animate={{ y: 0, transition: springs.sheet }}
      exit={{ y: '110%', transition: { duration: 0.24, ease: [0.4, 0, 1, 1] } }}
    >
      <div className="ui-actionsheet__group">
        {(spec.title || spec.message) && (
          <div className="ui-actionsheet__header">
            {spec.title && <div className="ui-actionsheet__title">{spec.title}</div>}
            {spec.message && <div className="ui-actionsheet__message">{spec.message}</div>}
          </div>
        )}
        {rest.map((a, i) => (
          <button
            key={`${a.label}-${i}`}
            type="button"
            className={cx('ui-actionsheet__button', a.style === 'destructive' && 'is-destructive')}
            onClick={() => onSelect(a)}
          >
            {a.label}
          </button>
        ))}
      </div>
      {cancel && (
        <button type="button" className="ui-actionsheet__cancel" onClick={() => onSelect(cancel)}>
          {cancel.label}
        </button>
      )}
    </motion.div>
  )
}

/** Renders one dialog with enter/exit animation. Used by UIProvider's queue and the declarative components. */
export function DialogLayer({ spec, onDone }: { spec: (DialogSpec & { id: number }) | null; onDone: (label: string | null) => void }) {
  const select = (a: DialogAction) => {
    a.onPress?.()
    onDone(a.label)
  }
  const dismissOutside = () => {
    if (!spec || spec.kind !== 'actionSheet') return
    const cancel = spec.actions.find((a) => a.style === 'cancel')
    if (cancel) select(cancel)
    else onDone(null)
  }

  const latest = useRef({ spec, select })
  latest.current = { spec, select }
  const lastFocus = useRef<Element | null>(null)
  const specId = spec?.id
  useEffect(() => {
    if (specId == null) return
    lastFocus.current = document.activeElement
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      const cancel = latest.current.spec?.actions.find((a) => a.style === 'cancel')
      if (cancel) latest.current.select(cancel)
    }
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('keydown', onKey)
      if (lastFocus.current instanceof HTMLElement) lastFocus.current.focus({ preventScroll: true })
    }
  }, [specId])

  return (
    <AnimatePresence>
      {spec && (
        <motion.div
          key={spec.id}
          className={cx('ui-dialog-layer', spec.kind === 'actionSheet' && 'ui-dialog-layer--sheet')}
          initial={{ opacity: 1 }}
          exit={{ opacity: 1, transition: { duration: 0.26 } }}
        >
          <motion.div
            className="ui-dialog-scrim"
            onClick={dismissOutside}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1, transition: { duration: 0.2 } }}
            exit={{ opacity: 0, transition: { duration: 0.22 } }}
          />
          {spec.kind === 'alert' ? <AlertCard spec={spec} onSelect={select} /> : <ActionSheetCard spec={spec} onSelect={select} />}
        </motion.div>
      )}
    </AnimatePresence>
  )
}

interface DeclarativeDialogProps {
  open: boolean
  /** Called with the tapped action's label, or null. */
  onClose: (label: string | null) => void
}

export interface AlertProps extends AlertOptions, DeclarativeDialogProps {}

/** Declarative alert; useAlert() is usually simpler. */
export function Alert({ open, onClose, title, message, actions }: AlertProps) {
  return (
    <DeclarativeDialog
      open={open}
      onClose={onClose}
      spec={{ kind: 'alert', title, message, actions: actions?.length ? actions : [{ label: 'OK', preferred: true }] }}
    />
  )
}

export interface ActionSheetProps extends ActionSheetOptions, DeclarativeDialogProps {}

export function ActionSheet({ open, onClose, title, message, actions, cancelLabel = 'Cancel' }: ActionSheetProps) {
  return (
    <DeclarativeDialog
      open={open}
      onClose={(label) => onClose(label === cancelLabel ? null : label)}
      spec={{ kind: 'actionSheet', title, message, actions: [...actions, { label: cancelLabel, style: 'cancel' }] }}
    />
  )
}

let declarativeId = 1_000_000

function DeclarativeDialog({ open, onClose, spec }: DeclarativeDialogProps & { spec: Omit<DialogSpec, 'resolve'> }) {
  const ui = useUI()
  const id = useRef(declarativeId++)
  const host = ui?.host ?? (typeof document !== 'undefined' ? document.body : null)
  if (!host) return null
  return createPortal(
    <div className="ui-dialog-portal">
      <DialogLayer spec={open ? { ...spec, resolve: () => {}, id: id.current } : null} onDone={onClose} />
    </div>,
    host,
  )
}
