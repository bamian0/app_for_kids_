// Top notification banner: slides down with a spring, auto-dismisses, swipe up to dismiss.
import { useEffect, useRef } from 'react'
import type { ReactNode } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import { useRequiredUI } from './context.ts'
import type { ToastOptions } from './context.ts'
import { Icon, iconNames } from './icons.tsx'
import type { IconName } from './icons.tsx'
import { springs } from './motion.ts'
import { cx } from './press.ts'
import './toast.css'

export type { ToastOptions }

/** Show a banner: toast('Saved') or toast({ title, message, icon, tone }). Needs <UIProvider>. */
export function useToast(): (options: ToastOptions | string) => void {
  const ui = useRequiredUI('useToast()')
  const show = ui.showToast
  return (options) => show(typeof options === 'string' ? { title: options } : options)
}

function leadingIcon(t: ToastOptions): ReactNode {
  if (t.icon != null && typeof t.icon !== 'string') return t.icon
  const name: IconName =
    typeof t.icon === 'string' && (iconNames as string[]).includes(t.icon)
      ? (t.icon as IconName)
      : t.tone === 'success'
        ? 'checkmark'
        : t.tone === 'error'
          ? 'xmark'
          : 'bell'
  return <Icon name={name} size={18} weight={2.2} />
}

export interface BannerProps extends ToastOptions {
  onDismiss: () => void
}

/** The banner view itself (normally shown through useToast()). */
export function Banner({ onDismiss, onPress, ...t }: BannerProps) {
  const timer = useRef<number | undefined>(undefined)
  const arm = () => {
    window.clearTimeout(timer.current)
    timer.current = window.setTimeout(onDismiss, t.durationMs ?? 3200)
  }
  useEffect(() => {
    arm()
    return () => window.clearTimeout(timer.current)
    // Re-arm only for a new banner.
  }, [t.title, t.message])

  return (
    <motion.div
      className={cx('ui-banner', t.tone && `ui-banner--${t.tone}`)}
      role="status"
      aria-live="polite"
      initial={{ y: -140, opacity: 0.4 }}
      animate={{ y: 0, opacity: 1, transition: springs.bouncy }}
      exit={{ y: -140, opacity: 0, transition: { duration: 0.32, ease: [0.4, 0, 1, 1] } }}
      drag="y"
      dragConstraints={{ top: 0, bottom: 0 }}
      dragElastic={{ top: 0.9, bottom: 0.12 }}
      onDragStart={() => window.clearTimeout(timer.current)}
      onDragEnd={(_, info) => {
        if (info.offset.y < -24 || info.velocity.y < -250) onDismiss()
        else arm()
      }}
      onTap={() => {
        onPress?.()
        if (onPress) onDismiss()
      }}
    >
      <span className="ui-banner__icon">{leadingIcon(t)}</span>
      <span className="ui-banner__text">
        <span className="ui-banner__title">{t.title}</span>
        {t.message && <span className="ui-banner__message">{t.message}</span>}
      </span>
    </motion.div>
  )
}

export function ToastLayer({ toast, onDismiss }: { toast: (ToastOptions & { id: number }) | null; onDismiss: () => void }) {
  return (
    <div className="ui-toast-layer">
      <AnimatePresence>{toast && <Banner key={toast.id} {...toast} onDismiss={onDismiss} />}</AnimatePresence>
    </div>
  )
}
